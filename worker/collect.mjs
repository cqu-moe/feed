import {Buffer} from 'node:buffer';
import {readingText,readingExcerpt} from './reading.mjs';
import {pdfPages,PDF_TEXT_UNAVAILABLE} from './pdf-text.mjs';
import {enqueuePdfOcr} from './pdf-ocr.mjs';
import {script as bundle} from 'single-file-cli/lib/single-file-bundle.js';
import options from './singlefile-options.json';
import {captchaPage} from './page-action.mjs';
import {issueGrant} from './bridge.mjs';
import {scrape} from './firecrawl.mjs';
import {put,bounded,fileKind,sha,cleanError} from './utils.mjs';
import {resumeSavedCapture,saveCaptureRevision} from './archive-capture.mjs';

export function createCollector(dependencies={}){
  const {
    scrape: scrapeDependency=scrape,
    fetch: fetchDependency=fetch,
    enqueueOcr: enqueueOcrDependency=enqueuePdfOcr,
  }=dependencies;
  return (env,source,article,captureContext)=>collectArticle(env,source,article,{
    scrape:scrapeDependency,
    fetch:fetchDependency,
    enqueueOcr:enqueueOcrDependency,
  },captureContext);
}

async function collectArticle(env,source,article,dependencies,captureContext){
  const {scrape:scrapeDependency,fetch:fetchDependency,enqueueOcr:enqueueOcrDependency}=dependencies;
  const {fence,taskId=null,attemptNo=null}=captureContext??{};
  if(!Number.isSafeInteger(fence))throw new Error('Capture lease is required');
  const versioned=taskId&&env.ARCHIVE_VERSIONS_ENABLED==='true';
  if(versioned){
    const saved=await resumeSavedCapture(env,source,article,captureContext);
    if(saved)return saved;
  }
  const commitGuard=`EXISTS(SELECT 1 FROM articles WHERE id=? AND capture_fence=? AND status='collecting' AND lease_until>?)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state='running'))`;
  const runId=crypto.randomUUID(),prefix=`articles/${article.id}/${runId}`;
  const grant=await issueGrant(env,source,runId,article.id);
  const bridgeURL=new URL('/internal/bridge',env.BASE_URL);bridgeURL.searchParams.set('grant',grant.token);
  const input={id:article.id,url:article.url,title:article.title.replace(/^[●•·\s]+|[…]+$/g,'').slice(0,18),bridgeURL:bridgeURL.href,bridgeOrigin:bridgeURL.origin,channel:grant.channel,bundle,options:{...options,selfExtractingArchive:false,maxResourceSize:3,maxResourceSizeEnabled:true,networkTimeout:8000,insertMetaCSP:false}};
  const data=await scrapeDependency(env,article.url,{formats:['markdown','rawHtml',{type:'screenshot',fullPage:true}],onlyMainContent:true,actions:[{type:'executeJavascript',script:`var __name=value=>value; (${captchaPage.toString()})(${JSON.stringify(input)})`}]});
  let page=data.actions?.javascriptReturns?.[0]?.value;if(typeof page==='string')page=JSON.parse(page);
  if(!page?.bodyRecognized||new URL(page.page.url).origin!==new URL(source.url).origin)throw new Error('Article body not recognized');
  const report={id:article.id,runId,url:article.url,captureFence:fence,capturedAt:new Date().toISOString(),bodyCapturedAt:page.bodyCapturedAt??null,provider:{statusCode:data.metadata?.statusCode,creditsUsed:data.metadata?.creditsUsed,proxyUsed:data.metadata?.proxyUsed},artifacts:[],errors:[...(page.errors??[])]};
  const stored=new Map();
  for(const item of page.artifacts??[]){
    if(!/^(attachment-\d+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin)|snapshot\.html|offline\.html)$/.test(item.name))throw new Error('Unexpected artifact');
    const bytes=Buffer.from(item.base64,'base64');
    if(item.name.startsWith('attachment-')&&!fileKind(bytes))throw new Error('Invalid attachment signature');
    const saved=await put(env,prefix,item.name,bytes,item.contentType);stored.set(item.name,saved);report.artifacts.push(saved);
  }
  for(const row of page.downloads??[]){
    if(!row.saved?.uploaded)continue;
    const name=row.saved.name;if(!/^attachment-[1-8]\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|bin)$/.test(name))throw new Error('Invalid uploaded artifact');
    const object=await env.ARCHIVE.get(`${prefix}/${name}.upload.json`);if(!object)throw new Error('Uploaded artifact manifest missing');
    const saved=await object.json(),head=await env.ARCHIVE.head(`${prefix}/${name}`);
    if(!head||saved.key!==`${prefix}/${name}`||head.size!==saved.bytes||!/^\w{64}$/.test(saved.sha256))throw new Error('Uploaded artifact verification failed');
    stored.set(name,saved);report.artifacts.push(saved);
  }
  let body=page.bodyText?.trim()||((page.downloads??[]).some(row=>row.role==='body-pdf')?'':data.markdown||'');
  const rawBody=body,nativePdfs=new Set();
  // PDF-only notices still have searchable, unified text; original PDF remains authoritative.
  for(const row of page.downloads??[]){
    const saved=stored.get(row.saved?.name);
    if(saved&&row.role==='body-pdf'&&row.kind==='pdf'){
      try{
        const object=await env.ARCHIVE.get(saved.key);
        const analysis=await pdfPages(await object.arrayBuffer());
        const nativeText=analysis.pages.filter(page=>!page.needsOcr).map(page=>page.text.trim()).filter(Boolean).join('\n\n');
        const fullyNative=analysis.pages.length&&!analysis.pages.some(page=>page.needsOcr);
        if(fullyNative)nativePdfs.add(saved.name);
        // While OCR is required, keep the captured HTML body and marker only. The
        // adopted per-page result later replaces that marker without duplicating native text.
        body+='\n\n'+(fullyNative?nativeText:PDF_TEXT_UNAVAILABLE);
        report.artifacts.push(await put(env,prefix,`${saved.name}.pages.json`,JSON.stringify(analysis),'application/json'));
        report.artifacts.push(await put(env,prefix,`${saved.name}.txt`,nativeText,'text/plain; charset=utf-8'));
      }catch(error){body+='\n\n'+PDF_TEXT_UNAVAILABLE;report.errors.push(cleanError(error));}
    }
  }
  body=readingText(body);
  // A PDF-only notice is still a real observation when its original cannot be
  // downloaded. Keep the empty HTML body and the failed PDF requirement together.
  if(!body.trim()&&!(versioned&&page.attachmentCandidates?.some(row=>row.role==='body-pdf'))){
    throw new Error('Empty article body');
  }
  report.artifacts.push(await put(env,prefix,'body.txt',body,'text/plain; charset=utf-8'));
  if(data.markdown)report.artifacts.push(await put(env,prefix,'body.md',data.markdown,'text/markdown; charset=utf-8'));
  if(data.rawHtml)report.artifacts.push(await put(env,prefix,'rendered.html',data.rawHtml,'text/html; charset=utf-8'));
  let screenshotKey=null;
  if(data.screenshot){
    try{
      const target=new URL(data.screenshot);
      if(target.protocol!=='https:')throw new Error('Invalid screenshot URL');
      const response=await fetchDependency(target,{signal:AbortSignal.timeout(20000)});
      if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))throw new Error('Screenshot unavailable');
      const shot=await put(env,prefix,'original.png',await bounded(response),response.headers.get('content-type'));
      report.artifacts.push(shot);screenshotKey=shot.key;
    }catch(error){report.errors.push(cleanError(error));}
  }
  const candidates=page.attachmentCandidates??[],downloaded=new Map((page.downloads??[]).map(row=>[row.url,row]));
  const attachmentRows=[];let completeFiles=0;
  for(const [index,item] of candidates.entries()){
    const row=downloaded.get(item.url),saved=stored.get(row?.saved?.name),ok=!!saved&&row?.originalFile;
    if(ok)completeFiles++;
    const id=`${article.id}-${index+1}`;
    attachmentRows.push([id,article.id,item.name,item.url,saved?.name??null,saved?.key??null,saved?.bytes??0,saved?.contentType??null,saved?.sha256??null,ok?'complete':'failed',ok?null:row?.error??'Attachment limit reached',item.role]);
  }
  if(completeFiles<candidates.length)report.errors.push(`${completeFiles}/${candidates.length} attachments saved`);
  const snapshot=stored.get('offline.html');if(!snapshot)report.errors.push('Snapshot missing');
  const status=report.errors.length?'partial':'complete';
  const hash=await sha(body);
  report.status=status;report.attachmentCount=candidates.length;report.downloadedCount=completeFiles;
  report.downloads=(page.downloads??[]).map(({attempts,...row})=>({...row,attemptCount:attempts?.length??0}));
  report.artifacts.push(await put(env,prefix,'manifest.json',JSON.stringify(report,null,2),'application/json'));
  if(versioned)return saveCaptureRevision(env,source,article,captureContext,{report,stored,candidates,downloaded,body,rawBody,sourceMarkup:page.bodyHtml??null,nativePdfs,sourceTitle:page.heading||page.page.title});
  const result={id:article.id,status,attachments:candidates.length,downloaded:completeFiles,creditsUsed:report.provider.creditsUsed};
  // One eligibility cutoff for the entire atomic batch, after all R2 writes. A later
  // claimant changes the fence; the clock cannot expire between individual writes.
  const guardArgs=[article.id,fence,Date.now(),taskId,taskId,attemptNo];
  const statements=attachmentRows.map(row=>env.DB.prepare(`INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,bytes,content_type,sha256,status,error,role)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${commitGuard} ON CONFLICT(article_id,original_url) DO UPDATE SET name=excluded.name,filename=COALESCE(excluded.filename,attachments.filename),object_key=COALESCE(excluded.object_key,attachments.object_key),bytes=CASE WHEN excluded.object_key IS NULL THEN attachments.bytes ELSE excluded.bytes END,content_type=COALESCE(excluded.content_type,attachments.content_type),sha256=COALESCE(excluded.sha256,attachments.sha256),status=excluded.status,error=excluded.error,role=excluded.role`)
    .bind(...row,...guardArgs));
  if(taskId){
    statements.push(env.DB.prepare(`UPDATE task_attempts SET result_json=? WHERE task_id=? AND attempt_no=?
      AND result_json IS NULL AND ${commitGuard}`).bind(JSON.stringify(result),taskId,attemptNo,...guardArgs));
  }
  statements.push(env.DB.prepare(`UPDATE articles SET captured_at=?,status=?,error=?,body_text=?,excerpt=?,prefix=?,content_hash=?,attachment_count=?,snapshot_key=?,screenshot_key=?,ocr_result_key=NULL,ocr_model=NULL,ocr_updated_at=NULL,lease_until=0
    WHERE id=? AND ${commitGuard} RETURNING id`)
    .bind(report.capturedAt,status,report.errors.length?report.errors.join('; '):null,body,readingExcerpt(body),prefix,hash,candidates.length,snapshot?.key??null,screenshotKey,article.id,...guardArgs));
  const committed=await env.DB.batch(statements);
  if(!committed.at(-1).results?.length)throw new Error('Capture fence expired before archive commit');
  if(env.PDF_OCR_ENABLED==='true'){
    try{await enqueueOcrDependency(env,article.id,{publish:true});}
    catch(error){console.error(JSON.stringify({event:'pdf_ocr_enqueue_failed',articleId:article.id,error:cleanError(error)}));}
  }
  return result;
}
