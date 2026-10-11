import {WorkflowEntrypoint} from 'cloudflare:workers';
import {OCR_MODELS,mistralOcr} from './mistral-ocr.mjs';
import {pdfPages,PDF_TEXT_UNAVAILABLE} from './pdf-text.mjs';
import {put,sha,cleanError} from './utils.mjs';
import {readingText,readingExcerpt} from './reading.mjs';

const VERSION='v1';
const MAX_BYTES=12*1024*1024;
const MAX_OCR_PAGES=20;
const validModel=model=>Object.hasOwn(OCR_MODELS,model??'');

async function pdfBytes(env,job){
  const object=await env.ARCHIVE.get(job.source_key);
  if(!object||object.size>MAX_BYTES)throw new Error('Saved PDF missing or exceeds OCR size limit');
  const bytes=await object.arrayBuffer();
  if(await sha(bytes)!==job.source_hash)throw new Error('Saved PDF hash changed');
  return bytes;
}

async function reservePages(env,count){
  const day=new Date().toISOString().slice(0,10),month=day.slice(0,7);
  const daily=Number(env.MAX_PDF_OCR_PAGES_PER_DAY||50),monthly=Number(env.MAX_PDF_OCR_PAGES_PER_MONTH||1000);
  if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(daily)||!Number.isSafeInteger(monthly))throw new Error('Invalid OCR budget');
  await env.DB.prepare('INSERT OR IGNORE INTO pdf_ocr_budget(id,day,month) VALUES (1,?,?)').bind(day,month).run();
  const reserved=await env.DB.prepare(`UPDATE pdf_ocr_budget SET day=?,month=?,day_pages=CASE WHEN day=? THEN day_pages+? ELSE ? END,month_pages=CASE WHEN month=? THEN month_pages+? ELSE ? END
    WHERE id=1 AND (CASE WHEN day=? THEN day_pages ELSE 0 END)+?<=? AND (CASE WHEN month=? THEN month_pages ELSE 0 END)+?<=? RETURNING id`)
    .bind(day,month,day,count,count,month,count,count,day,count,daily,month,count,monthly).first();
  if(!reserved)throw new Error('PDF OCR budget exhausted');
  await env.DB.batch([day,month].map(period=>env.DB.prepare('INSERT INTO pdf_ocr_usage(period,reserved_pages) VALUES (?,?) ON CONFLICT(period) DO UPDATE SET reserved_pages=reserved_pages+excluded.reserved_pages').bind(period,count)));
  return {day,month};
}

export async function enqueuePdfOcr(env,articleId,{model=env.PDF_OCR_MODEL,publish=false}={}){
  if(!validModel(model))throw new Error('Unsupported OCR model');
  if(!env.MISTRAL_API_KEY)throw new Error('Mistral API key is not configured');
  const rows=await env.DB.prepare("SELECT t.* FROM attachments t WHERE t.article_id=? AND t.role='body-pdf' AND t.status='complete' AND t.object_key IS NOT NULL ORDER BY t.id").bind(articleId).all();
  const jobs=[];
  for(const row of rows.results){
    if(!row.filename?.endsWith('.pdf')||!row.sha256)continue;
    const id=(await sha(`${VERSION}:${row.id}:${row.sha256}:${model}`)).slice(0,40),now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO pdf_ocr_jobs(id,article_id,attachment_id,source_hash,source_key,filename,model,publish_requested,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET publish_requested=MAX(publish_requested,excluded.publish_requested)`)
      .bind(id,articleId,row.id,row.sha256,row.object_key,row.filename,model,publish?1:0,now,now).run();
    const job=await env.DB.prepare('SELECT * FROM pdf_ocr_jobs WHERE id=?').bind(id).first();
    if(job.status==='complete'){
      if(publish)await publishPdfText(env,articleId,model);
      jobs.push({id,status:job.status,cached:true});continue;
    }
    if(job.status==='running'&&job.lease_until>Date.now()){jobs.push({id,status:'running'});continue;}
    if(job.attempts>=2&&job.status!=='deferred_budget'){jobs.push({id,status:job.status,error:job.error});continue;}
    const instance=await env.PDF_OCR.create({id:`${id}-${crypto.randomUUID().slice(0,8)}`,params:{jobId:id}});
    jobs.push({id,status:'pending',workflowId:instance.id});
  }
  return {articleId,model,jobs};
}

export async function pdfOcrStatus(env,articleId){
  const rows=await env.DB.prepare('SELECT id,model,status,total_pages,ocr_pages,attempts,estimated_usd,error,updated_at FROM pdf_ocr_jobs WHERE article_id=? ORDER BY model').bind(articleId).all();
  return {articleId,jobs:rows.results};
}

// Admin comparison output; all reads remain behind the existing ADMIN_TOKEN gate.
export async function pdfOcrResults(env,articleId,model){
  if(!validModel(model))throw new Error('Unsupported OCR model');
  const rows=await env.DB.prepare("SELECT result_key FROM pdf_ocr_jobs WHERE article_id=? AND model=? AND status='complete'").bind(articleId,model).all();
  const documents=[];
  for(const row of rows.results){const object=await env.ARCHIVE.get(row.result_key);if(object)documents.push(await object.json());}
  return {articleId,model,documents};
}

export async function publishPdfText(env,articleId,model){
  const article=await env.DB.prepare('SELECT prefix,body_text,content_hash FROM articles WHERE id=?').bind(articleId).first();
  if(!article?.prefix)throw new Error('Article is not archived');
  const rows=await env.DB.prepare(`SELECT t.id,t.filename,t.sha256,j.result_key,j.ocr_pages FROM attachments t
    LEFT JOIN pdf_ocr_jobs j ON j.attachment_id=t.id AND j.source_hash=t.sha256 AND j.model=? AND j.status='complete'
    WHERE t.article_id=? AND t.role='body-pdf' AND t.status='complete' ORDER BY t.id`).bind(model,articleId).all();
  if(!rows.results.length||rows.results.some(row=>!row.result_key))return {updated:false,reason:'Other PDF text is still pending'};
  if(!rows.results.some(row=>row.ocr_pages>0))return {updated:false,reason:'Native text needs no OCR replacement'};
  const pages=[];
  for(const row of rows.results){
    const object=await env.ARCHIVE.get(row.result_key);if(!object)throw new Error('OCR result missing');
    const result=await object.json();
    if(result.sourceHash!==row.sha256)throw new Error('OCR source changed');
    for(const page of result.pages)pages.push({page:page.index+1,filename:row.filename,source:page.source,markdown:page.markdown,text:page.text});
  }
  const text=pages.map(page=>page.text).join('\n\n').trim();
  if(!text)return {updated:false,reason:'No readable PDF text'};
  const now=new Date().toISOString(),prefix=`derived/reading/${articleId}/${await sha(JSON.stringify({model,pages}))}`;
  // Preserve the existing derived body before replacing it. Original PDF/snapshots are untouched.
  if(!await env.ARCHIVE.head(`${prefix}/previous-body.txt`))await put(env,prefix,'previous-body.txt',article.body_text,'text/plain; charset=utf-8');
  // Include non-PDF HTML text when a source combines HTML with an embedded document.
  const capture=await env.ARCHIVE.get(`${article.prefix}/manifest.json`);
  const originalBody=await env.ARCHIVE.get(`${article.prefix}/body.txt`);
  let htmlText=originalBody?await originalBody.text():'';
  if(capture){
    const manifest=await capture.json();
    for(const download of manifest.downloads??[]){
      if(download.role!=='body-pdf'||!download.saved?.name)continue;
      const native=await env.ARCHIVE.get(`${article.prefix}/${download.saved.name}.txt`);
      const nativeText=native?await native.text():'';
      if(nativeText)htmlText=htmlText.replace(nativeText,'');
    }
  }
  htmlText=readingText(htmlText).split(PDF_TEXT_UNAVAILABLE).join('').trim();
  const body=[htmlText,text].filter(Boolean).join('\n\n');
  const result=await put(env,prefix,'reading.json',JSON.stringify({status:'complete',model,htmlText,pages,updatedAt:now}),'application/json');
  await put(env,prefix,'reading.txt',body,'text/plain; charset=utf-8');
  const updated=await env.DB.prepare(`UPDATE articles SET body_text=?,excerpt=?,content_hash=?,ocr_result_key=?,ocr_model=?,ocr_updated_at=?
    WHERE id=? AND prefix=? AND content_hash=? AND NOT EXISTS(
      SELECT 1 FROM attachments t WHERE t.article_id=? AND t.role='body-pdf' AND t.status='complete' AND NOT EXISTS(
        SELECT 1 FROM pdf_ocr_jobs j WHERE j.attachment_id=t.id AND j.source_hash=t.sha256 AND j.model=? AND j.status='complete')) RETURNING id`)
    .bind(body,readingExcerpt(body),await sha(body),result.key,model,now,articleId,article.prefix,article.content_hash,articleId,model).first();
  return {updated:!!updated,characters:body.length,pages:pages.length};
}

export async function resumePdfOcr(env){
  if(env.PDF_OCR_ENABLED!=='true'||!env.MISTRAL_API_KEY||!validModel(env.PDF_OCR_MODEL))return [];
  const rows=await env.DB.prepare(`SELECT DISTINCT a.id FROM articles a JOIN attachments t ON t.article_id=a.id
    LEFT JOIN pdf_ocr_jobs j ON j.attachment_id=t.id AND j.source_hash=t.sha256 AND j.model=?
    WHERE a.prefix IS NOT NULL AND t.role='body-pdf' AND t.status='complete' AND (
      j.id IS NULL OR (j.status<>'complete' AND j.attempts<2 AND j.lease_until<?) OR (j.status='complete' AND j.ocr_pages>0 AND a.ocr_model IS NULL)) LIMIT 20`)
    .bind(env.PDF_OCR_MODEL,Date.now()).all();
  const jobs=[];
  for(const row of rows.results)jobs.push(await enqueuePdfOcr(env,row.id,{publish:true}));
  return jobs;
}

export class PdfOcrWorkflow extends WorkflowEntrypoint{
  async run(event,step){
    const env=this.env,id=event.payload.jobId;
    const claimed=await step.do('claim',async()=>env.DB.prepare(`UPDATE pdf_ocr_jobs SET status='running',lease_until=?,error=NULL,updated_at=?
      WHERE id=? AND lease_until<? AND status<>'complete' AND attempts<2 RETURNING *`).bind(Date.now()+15*60000,new Date().toISOString(),id,Date.now()).first());
    if(!claimed)return {skipped:true};
    const prefix=`derived/pdf/${claimed.source_hash}/${claimed.model}/${VERSION}`;
    let enteredPaidWork=false;
    try{
      const analysis=await step.do('inspect',async()=>{
        const result=await pdfPages(await pdfBytes(env,claimed));
        const wanted=result.pages.filter(page=>page.needsOcr).map(page=>page.index);
        if(wanted.length>MAX_OCR_PAGES)throw new Error('PDF exceeds 20 OCR pages; requires a larger explicit budget');
        await put(env,prefix,'native.json',JSON.stringify(result),'application/json');
        await env.DB.prepare('UPDATE pdf_ocr_jobs SET total_pages=?,ocr_pages=? WHERE id=?').bind(result.totalPages,wanted.length,id).run();
        return {wanted,totalPages:result.totalPages};
      });
      const chunkKeys=[];
      for(let offset=0;offset<analysis.wanted.length;offset+=10){
        const pages=analysis.wanted.slice(offset,offset+10),name=`ocr-${pages.join('-')}.json`,key=`${prefix}/${name}`;
        await step.do(`recognize-${offset}`,{retries:{limit:0,delay:'30 seconds'},timeout:'3 minutes'},async()=>{
          if(await env.ARCHIVE.head(key))return;
          const callId=await sha(key);
          await env.DB.prepare('INSERT OR IGNORE INTO pdf_ocr_calls(id) VALUES (?)').bind(callId).run();
          const lock=await env.DB.prepare('UPDATE pdf_ocr_calls SET lease_until=? WHERE id=? AND lease_until<? AND attempts<2 RETURNING id').bind(Date.now()+4*60000,callId,Date.now()).first();
          if(!lock)throw new Error('Identical PDF OCR is busy or exhausted its two attempts');
          try{
            if(await env.ARCHIVE.head(key))return;
            // Until invoice semantics are verified, reserve all source pages for each PDF request.
            const period=await reservePages(env,analysis.totalPages);
            if(!enteredPaidWork){await env.DB.prepare('UPDATE pdf_ocr_jobs SET attempts=attempts+1 WHERE id=?').bind(id).run();enteredPaidWork=true;}
            await env.DB.prepare('UPDATE pdf_ocr_calls SET attempts=attempts+1 WHERE id=?').bind(callId).run();
            const result=await mistralOcr(env,{bytes:await pdfBytes(env,claimed),pages,model:claimed.model});
            await put(env,prefix,name,JSON.stringify(result),'application/json');
            await env.DB.batch([
              ...[period.day,period.month].map(value=>env.DB.prepare('INSERT INTO pdf_ocr_usage(period,processed_pages,estimated_usd) VALUES (?,?,?) ON CONFLICT(period) DO UPDATE SET processed_pages=processed_pages+excluded.processed_pages,estimated_usd=estimated_usd+excluded.estimated_usd').bind(value,result.usageInfo.pages_processed,result.estimatedUsd)),
              env.DB.prepare('UPDATE pdf_ocr_calls SET result_key=?,error=NULL WHERE id=?').bind(key,callId),
            ]);
          }finally{await env.DB.prepare('UPDATE pdf_ocr_calls SET lease_until=0 WHERE id=?').bind(callId).run();}
        });
        chunkKeys.push(key);
      }
      await step.do('save-result',async()=>{
        const native=await(await env.ARCHIVE.get(`${prefix}/native.json`)).json(),recognized=new Map(),calls=[];
        for(const key of chunkKeys){
          const result=await(await env.ARCHIVE.get(key)).json();calls.push(result);
          for(const page of result.pages)recognized.set(page.index,page);
        }
        const pages=native.pages.map(page=>{
          const ocr=recognized.get(page.index);
          if(page.needsOcr&&!ocr)throw new Error('OCR page missing');
          return ocr?{...ocr,source:'ocr'}:{index:page.index,text:page.text,markdown:page.text,source:'native'};
        });
        if(pages.some(page=>native.pages[page.index].needsOcr&&!page.text.trim()))throw new Error('OCR returned empty text for a scanned page; review required');
        const estimatedUsd=calls.reduce((sum,call)=>sum+call.estimatedUsd,0);
        const output={sourceHash:claimed.source_hash,model:claimed.model,totalPages:native.totalPages,pages,calls,estimatedUsd,createdAt:new Date().toISOString()};
        const artifact=await put(env,prefix,'result.json',JSON.stringify(output),'application/json');
        await env.DB.prepare("UPDATE pdf_ocr_jobs SET status='complete',lease_until=0,result_key=?,estimated_usd=?,updated_at=? WHERE id=?").bind(artifact.key,estimatedUsd,output.createdAt,id).run();
      });
      return await step.do('publish',async()=>{
        const job=await env.DB.prepare('SELECT publish_requested FROM pdf_ocr_jobs WHERE id=?').bind(id).first();
        return job.publish_requested?publishPdfText(env,claimed.article_id,claimed.model):{benchmark:true};
      });
    }catch(error){
      const message=cleanError(error),deferred=/budget exhausted/.test(message);
      await env.DB.prepare('UPDATE pdf_ocr_jobs SET status=?,lease_until=0,error=?,updated_at=? WHERE id=?')
        .bind(deferred?'deferred_budget':'failed',message,new Date().toISOString(),id).run();
      return {error:message};
    }
  }
}
