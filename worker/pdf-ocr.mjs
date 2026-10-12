import {cacheVersion,pdfBytes,recognize} from './ocr-cache.mjs';
import {WorkflowEntrypoint} from 'cloudflare:workers';
import {OCR_MODELS} from './mistral-ocr.mjs';
import {TEXTIN_MODEL} from './textin-ocr.mjs';
import {pdfPages,PDF_TEXT_UNAVAILABLE} from './pdf-text.mjs';
import {put,sha,cleanError} from './utils.mjs';
import {readingText,readingExcerpt} from './reading.mjs';

const MAX_OCR_PAGES=20;
const validModel=model=>model===TEXTIN_MODEL||Object.hasOwn(OCR_MODELS,model??'');
const pdfFilter="t.status='complete' AND t.object_key IS NOT NULL AND t.sha256 IS NOT NULL AND t.filename LIKE '%.pdf'";
export async function enqueuePdfOcr(env,articleId,{model=env.PDF_OCR_MODEL??TEXTIN_MODEL,publish=false}={}){
  if(!validModel(model))throw new Error('Unsupported OCR model');
  const rows=await env.DB.prepare(`SELECT t.* FROM attachments t WHERE t.article_id=? AND ${pdfFilter} ORDER BY t.id`).bind(articleId).all();
  const jobs=[];
  for(const row of rows.results){
    if(!row.filename?.endsWith('.pdf')||!row.sha256)continue;
    const id=(await sha(`${await cacheVersion(model)}:${row.id}:${row.sha256}:${model}`)).slice(0,40),now=new Date().toISOString();
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
  return {articleId,jobs:rows.results.map(job=>job.model===TEXTIN_MODEL?{...job,estimated_usd:null}:job)};
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
    WHERE t.article_id=? AND ${pdfFilter} ORDER BY t.id`).bind(model,articleId).all();
  if(!rows.results.length||rows.results.some(row=>!row.result_key))return {updated:false,reason:'Other PDF text is still pending'};
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
  let htmlText=originalBody?await originalBody.text():article.body_text;
  if(capture){
    const manifest=await capture.json();
    for(const download of manifest.downloads??[]){
      if(!download.saved?.name?.endsWith('.pdf'))continue;
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
      SELECT 1 FROM attachments t WHERE t.article_id=? AND ${pdfFilter} AND NOT EXISTS(
        SELECT 1 FROM pdf_ocr_jobs j WHERE j.attachment_id=t.id AND j.source_hash=t.sha256 AND j.model=? AND j.status='complete')) RETURNING id`)
    .bind(body,readingExcerpt(body),await sha(body),result.key,model,now,articleId,article.prefix,article.content_hash,articleId,model).first();
  return {updated:!!updated,characters:body.length,pages:pages.length};
}

export async function resumePdfOcr(env){
  const model=env.PDF_OCR_MODEL??TEXTIN_MODEL;
  if(env.PDF_OCR_ENABLED!=='true'||!validModel(model))return [];
  const rows=await env.DB.prepare(`SELECT DISTINCT a.id FROM articles a JOIN attachments t ON t.article_id=a.id
    LEFT JOIN pdf_ocr_jobs j ON j.attachment_id=t.id AND j.source_hash=t.sha256 AND j.model=?
    WHERE a.prefix IS NOT NULL AND ${pdfFilter} AND (
      j.id IS NULL OR (j.status NOT IN ('complete','needs_review') AND j.attempts<2 AND j.lease_until<?) OR (j.status='complete' AND (a.ocr_model IS NULL OR a.ocr_model<>?))) LIMIT 20`)
    .bind(model,Date.now(),model).all();
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
    const prefix=`derived/pdf/${claimed.source_hash}/${claimed.model}/${await cacheVersion(claimed.model)}`;
    try{
      const analysis=await step.do('inspect',async()=>{
        const cached=await env.ARCHIVE.get(`${prefix}/result.json`);
        if(cached){
          const result=await cached.json();
          if(result.sourceHash!==claimed.source_hash||result.model!==claimed.model)throw new Error('Cached OCR source/model mismatch');
          return {cached:true,totalPages:result.totalPages,wanted:result.pages.filter(page=>page.source==='ocr').map(page=>page.index)};
        }
        const result=await pdfPages(await pdfBytes(env,claimed));
        const wanted=result.pages.filter(page=>page.needsOcr).map(page=>page.index);
        if(wanted.length>MAX_OCR_PAGES)throw new Error('PDF exceeds 20 OCR pages; requires a larger explicit budget');
        await put(env,prefix,'native.json',JSON.stringify(result),'application/json');
        return {wanted,totalPages:result.totalPages};
      });
      const chunkKeys=[];
      if(!analysis.cached)for(let offset=0;offset<analysis.wanted.length;offset+=10){
        const pages=analysis.wanted.slice(offset,offset+10);
        const key=await step.do(`recognize-${offset}`,{retries:{limit:0,delay:'30 seconds'},timeout:'4 minutes'},
          ()=>recognize(env,claimed,{prefix,pages,totalPages:analysis.totalPages}));
        chunkKeys.push(key);
      }
      await step.do('save-result',async()=>{
        let artifactKey=`${prefix}/result.json`,estimatedUsd=0;
        if(!analysis.cached){
          const native=await(await env.ARCHIVE.get(`${prefix}/native.json`)).json(),recognized=new Map(),calls=[];
          for(const key of chunkKeys){
            const result=await(await env.ARCHIVE.get(key)).json();
            const {pages:recognizedPages,raw,...summary}=result;calls.push(summary);
            for(const page of recognizedPages)recognized.set(page.index,page);
          }
          const pages=native.pages.map(page=>{
            const ocr=recognized.get(page.index);
            if(page.needsOcr&&(!ocr||!ocr.text.trim()))throw new Error('OCR returned missing/empty text for a scanned page; review required');
            return ocr?{...ocr,source:'ocr'}:{index:page.index,text:page.text,markdown:page.text,source:'native'};
          });
          estimatedUsd=calls.reduce((sum,call)=>sum+(call.estimatedUsd??0),0);
          const output={sourceHash:claimed.source_hash,model:claimed.model,totalPages:native.totalPages,pages,calls,
            estimatedUsd:claimed.model===TEXTIN_MODEL?null:estimatedUsd,estimatedCny:null,createdAt:new Date().toISOString()};
          const artifact=await put(env,prefix,'result.json',JSON.stringify(output),'application/json');artifactKey=artifact.key;
        }else{
          estimatedUsd=(await(await env.ARCHIVE.get(artifactKey)).json()).estimatedUsd??0;
        }
        await env.DB.prepare("UPDATE pdf_ocr_jobs SET status='complete',lease_until=0,result_key=?,total_pages=?,ocr_pages=?,estimated_usd=?,updated_at=? WHERE id=?")
          .bind(artifactKey,analysis.totalPages,analysis.wanted.length,estimatedUsd,new Date().toISOString(),id).run();
      });
      return await step.do('publish',async()=>{
        const job=await env.DB.prepare('SELECT publish_requested FROM pdf_ocr_jobs WHERE id=?').bind(id).first();
        return job.publish_requested?publishPdfText(env,claimed.article_id,claimed.model):{benchmark:true};
      });
    }catch(error){
      const message=cleanError(error);
      const status=/budget exhausted/.test(message)?'deferred_budget':/is busy/.test(message)?'deferred_busy':/review required/i.test(message)?'needs_review':'failed';
      await env.DB.prepare('UPDATE pdf_ocr_jobs SET status=?,lease_until=0,error=?,updated_at=? WHERE id=?')
        .bind(status,message,new Date().toISOString(),id).run();
      return {error:message};
    }
  }
}
