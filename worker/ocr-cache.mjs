import {mistralOcr} from './mistral-ocr.mjs';
import {TEXTIN_MODEL,TEXTIN_CACHE_VERSION,textinConfig,textinOcr,parseTextinResult} from './textin-ocr.mjs';
import {pdfPages} from './pdf-text.mjs';
import {put,sha,cleanError,budgetLimit} from './utils.mjs';
const VERSION='v1',MAX_BYTES=12*1024*1024,MAX_OCR_PAGES=20;

// Both generations use the exact MVP namespace and ten-page request groups.
// A new projection/parser version must never imply another paid request.
export async function cachedPdfText(env,job){
  const prefix=`derived/pdf/${job.source_hash}/${job.model}/${await cacheVersion(job.model)}`;
  const bytes=await pdfBytes(env,job),native=await pdfPages(bytes.slice(0));
  const wanted=native.pages.filter(page=>page.needsOcr).map(page=>page.index);
  if(wanted.length>MAX_OCR_PAGES)throw new Error('PDF exceeds 20 OCR pages; requires a larger explicit budget');
  const key=`${prefix}/result.json`,existing=await env.ARCHIVE.get(key);
  if(existing){
    if(existing.size>MAX_BYTES)throw new Error('Cached OCR exceeds size limit; review required');
    return validateCachedText(await existing.json(),job,native);
  }
  const recognized=new Map(),calls=[];
  for(let offset=0;offset<wanted.length;offset+=10){
    const pages=wanted.slice(offset,offset+10);
    const chunkKey=await recognize(env,job,{prefix,pages,totalPages:native.totalPages});
    const chunk=await (await env.ARCHIVE.get(chunkKey)).json();
    const {pages:chunkPages,raw,...summary}=chunk;calls.push(summary);
    for(const page of chunkPages)recognized.set(page.index,page);
  }
  const output={sourceHash:job.source_hash,model:job.model,totalPages:native.totalPages,
    pages:native.pages.map(page=>recognized.has(page.index)?{...recognized.get(page.index),source:'ocr'}
      :{index:page.index,text:page.text,markdown:page.text,source:'native'}),calls,
    estimatedUsd:job.model===TEXTIN_MODEL?null:calls.reduce((sum,call)=>sum+(call.estimatedUsd??0),0),
    estimatedCny:null,createdAt:new Date().toISOString()};
  validateCachedText(output,job,native);
  const encoded=new TextEncoder().encode(JSON.stringify(output));
  if(encoded.byteLength>MAX_BYTES)throw new Error('Cached OCR exceeds size limit; review required');
  const saved=await env.ARCHIVE.put(key,encoded,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  return saved?output:validateCachedText(await (await env.ARCHIVE.get(key)).json(),job,native);
}

function validateCachedText(output,job,native){
  if(output?.sourceHash!==job.source_hash||output.model!==job.model||output.totalPages!==native.totalPages
    ||!Array.isArray(output.pages)||output.pages.length!==native.totalPages)
    throw new Error('Cached OCR source/model/coverage mismatch; review required');
  const seen=new Set();
  for(const page of output.pages){
    const original=native.pages[page?.index];
    if(!original||seen.has(page.index)||typeof page.text!=='string'||typeof page.markdown!=='string'
      ||!['native','ocr'].includes(page.source)||(original.needsOcr&&(page.source!=='ocr'||!page.text.trim()))
      ||(!original.needsOcr&&(page.source!=='native'||page.text!==original.text)))
      throw new Error('Cached OCR pages are invalid; review required');
    seen.add(page.index);
  }
  return output;
}

export async function cacheVersion(model){
  return model===TEXTIN_MODEL?`${TEXTIN_CACHE_VERSION}-no-text-${(await sha(JSON.stringify(textinConfig([0])))).slice(0,16)}`:VERSION;
}

export async function pdfBytes(env,job){
  const object=await env.ARCHIVE.get(job.source_key);
  if(!object||object.size>MAX_BYTES)throw new Error('Saved PDF missing or exceeds OCR size limit');
  const bytes=await object.arrayBuffer();
  if(await sha(bytes)!==job.source_hash)throw new Error('Saved PDF hash changed');
  return bytes;
}

export async function reservePages(env,count){
  const day=new Date().toISOString().slice(0,10),month=day.slice(0,7);
  const daily=budgetLimit(env.MAX_PDF_OCR_PAGES_PER_DAY,50),monthly=budgetLimit(env.MAX_PDF_OCR_PAGES_PER_MONTH,1000);
  if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(daily)||daily<0||!Number.isSafeInteger(monthly)||monthly<0)throw new Error('Invalid OCR budget');
  await env.DB.prepare('INSERT OR IGNORE INTO pdf_ocr_budget(id,day,month) VALUES (1,?,?)').bind(day,month).run();
  const reserved=await env.DB.prepare(`UPDATE pdf_ocr_budget SET day=?,month=?,day_pages=CASE WHEN day=? THEN day_pages+? ELSE ? END,month_pages=CASE WHEN month=? THEN month_pages+? ELSE ? END
    WHERE id=1 AND (?=0 OR (CASE WHEN day=? THEN day_pages ELSE 0 END)+?<=?) AND (?=0 OR (CASE WHEN month=? THEN month_pages ELSE 0 END)+?<=?) RETURNING id`)
    .bind(day,month,day,count,count,month,count,count,daily,day,count,daily,monthly,month,count,monthly).first();
  if(!reserved)throw new Error('PDF OCR budget exhausted');
  await env.DB.batch([day,month].map(period=>env.DB.prepare('INSERT INTO pdf_ocr_usage(period,reserved_pages) VALUES (?,?) ON CONFLICT(period) DO UPDATE SET reserved_pages=reserved_pages+excluded.reserved_pages').bind(period,count)));
  return {day,month};
}

// Reuse the already-paid comparison without uploading or recognizing it again.
// Only an exact source/config match is eligible; this never calls a provider.
async function benchmarkResult(env,job,totalPages,pages){
  if(job.model!==TEXTIN_MODEL||totalPages>MAX_OCR_PAGES)return null;
  const key=`benchmarks/textin/${job.source_hash}/v2/auto/result.json`;
  const object=await env.ARCHIVE.get(key);
  if(!object||object.size>24*1024*1024)return null;
  const saved=await object.json(),all=Array.from({length:totalPages},(_,i)=>i);
  if(saved.summary?.sourceHash!==job.source_hash||saved.summary?.success!==true||
    JSON.stringify(saved.config)!==JSON.stringify(textinConfig(all)))return null;
  const result=parseTextinResult(saved.payload,{pages:all});
  return {...result,pages:result.pages.filter(page=>pages.includes(page.index)),reusedFrom:key};
}

export async function recognize(env,job,{prefix,pages,totalPages}){
  const name=`ocr-${pages.join('-')}.json`,key=`${prefix}/${name}`,rawKey=`${key}.raw.json`,receiptKey=`${key}.request.json`;
  if(await env.ARCHIVE.head(key))return key;
  const callId=await sha(key);
  await env.DB.prepare('INSERT OR IGNORE INTO pdf_ocr_calls(id) VALUES (?)').bind(callId).run();
  const leaseUntil=Date.now()+5*60000;
  const lock=await env.DB.prepare('UPDATE pdf_ocr_calls SET lease_until=? WHERE id=? AND lease_until<? RETURNING attempts')
    .bind(leaseUntil,callId,Date.now()).first();
  if(!lock)throw new Error('Identical PDF OCR is busy');
  try{
    if(await env.ARCHIVE.head(key))return key;
    let result,period;
    const raw=job.model===TEXTIN_MODEL?await env.ARCHIVE.get(rawKey):null;
    if(raw){
      // A parsing/storage failure can be repaired without another paid request.
      if(raw.size>24*1024*1024)throw new Error('Saved TextIn raw response exceeds size limit; review required');
      let payload;
      try{payload=await raw.json();}catch{throw new Error('Saved TextIn raw response is invalid JSON; review required');}
      result=parseTextinResult(payload,{pages});
    }else{
      result=await benchmarkResult(env,job,totalPages,pages);
    }
    if(!result){
      if(lock.attempts>0||await env.ARCHIVE.head(receiptKey))throw new Error('OCR request already attempted; review required before any further charge');
      if(job.model===TEXTIN_MODEL){
        if(!env.TEXTIN_APP_ID||!env.TEXTIN_SECRET_CODE)throw new Error('TextIn credentials are not configured');
      }else if(!env.MISTRAL_API_KEY)throw new Error('Mistral API key is not configured');
      const bytes=await pdfBytes(env,job);
      // Reserve the full source document conservatively until account billing is verified.
      period=await reservePages(env,totalPages);
      const receipt=await env.ARCHIVE.put(receiptKey,JSON.stringify({sourceHash:job.source_hash,model:job.model,pages,createdAt:new Date().toISOString()}),{
        onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/json'},
      });
      if(!receipt)throw new Error('OCR request already attempted; review required before any further charge');
      await env.DB.batch([
        env.DB.prepare('UPDATE pdf_ocr_calls SET attempts=attempts+1 WHERE id=?').bind(callId),
        ...(job.id?[env.DB.prepare('UPDATE pdf_ocr_jobs SET attempts=MAX(attempts,1) WHERE id=?').bind(job.id)]:[]),
      ]);
      if(job.model===TEXTIN_MODEL){
        result=await textinOcr(env,{bytes,pages,onRawBody:async bytes=>{
          // The adapter bounds raw responses to 24 MiB. Keep raw character/box data private.
          await env.ARCHIVE.put(rawKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
        }});
      }else result=await mistralOcr(env,{bytes,pages,model:job.model});
    }
    const {raw:rawPayload,...normalized}=result;
    await put(env,prefix,name,JSON.stringify(normalized),'application/json');
    // Usage writes do not gate the R2 cache: a failed accounting write must not repeat OCR.
    await env.DB.batch([
      ...(period?[period.day,period.month].map(value=>env.DB.prepare('INSERT INTO pdf_ocr_usage(period,processed_pages,estimated_usd) VALUES (?,?,?) ON CONFLICT(period) DO UPDATE SET processed_pages=processed_pages+excluded.processed_pages,estimated_usd=estimated_usd+excluded.estimated_usd').bind(value,result.usageInfo.pages_processed,result.estimatedUsd??0)):[]),
      env.DB.prepare('UPDATE pdf_ocr_calls SET result_key=?,error=NULL WHERE id=?').bind(key,callId),
    ]);
    return key;
  }catch(error){
    const message=cleanError(error);
    await env.DB.prepare('UPDATE pdf_ocr_calls SET error=? WHERE id=? AND lease_until=?').bind(message,callId,leaseUntil).run().catch(()=>{});
    if(await env.ARCHIVE.head(receiptKey))throw new Error(`OCR review required: ${message}`);
    throw error;
  }finally{
    await env.DB.prepare('UPDATE pdf_ocr_calls SET lease_until=0 WHERE id=? AND lease_until=?').bind(callId,leaseUntil).run().catch(()=>{});
  }
}
