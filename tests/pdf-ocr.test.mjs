import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

let mf;
let db;
let bucket;

const workflowPlugin={
  name:'pdf-ocr-workflow-test',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'pdf-ocr-test'}));
    buildApi.onLoad({filter:/.*/,namespace:'pdf-ocr-test'},()=>({
      loader:'js',
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

before(async()=>{
  const bundle=await build({
    stdin:{
      contents:`
        import {PdfOcrWorkflow,enqueuePdfOcr,publishPdfText,resumePdfOcr} from './worker/pdf-ocr.mjs';
        import {apiRoute} from './worker/api.mjs';
        import {textinConfig} from './worker/textin-ocr.mjs';
        const originalFetch=globalThis.fetch;
        const makeStep=(env,jobId)=>({
          async do(name,config,fn){
            if(name==='publish'){
              const job=await env.DB.prepare('SELECT result_key FROM pdf_ocr_jobs WHERE id=?').bind(jobId).first();
              globalThis.R2_RESULT_BEFORE_PUBLISH=!!job?.result_key&&!!await env.ARCHIVE.head(job.result_key);
            }
            return (typeof config==='function'?config:fn)();
          },
          async sleep(){},
        });
        export default {
          async fetch(request,env){
            env.PDF_OCR ??= {create:async({id,params})=>{
              globalThis.PDF_OCR_CREATIONS.push({id,params});
              return {id};
            }};
            const url=new URL(request.url);
            if(url.pathname==='/configure'){
              globalThis.PDF_OCR_CREATIONS=[];
              globalThis.MISTRAL_CALLS=[];
              globalThis.R2_RESULT_BEFORE_PUBLISH=null;
              globalThis.STORAGE_FAILED=false;
              globalThis.MISTRAL_RESPONSE=url.searchParams.get('response');
              globalThis.OCR_MODEL=url.searchParams.get('model')||'mistral-ocr-4-1';
              globalThis.MISTRAL_PDF=new Uint8Array(await request.arrayBuffer());
              globalThis.fetch=async(input,init)=>{
                const request=new Request(input,init);
                if(request.url==='https://api.textin.com/api/v1/xparse/parse/sync'){
                  const form=await request.formData(),config=JSON.parse(form.get('config'));
                  const pages=config.scope.page_range.split(',').flatMap(part=>{const [first,last]=part.split('-').map(Number);return Array.from({length:(last||first)-first+1},(_,i)=>first+i)});
                  globalThis.MISTRAL_CALLS.push({url:request.url,config});
                  if(globalThis.MISTRAL_RESPONSE==='error')throw new Error('provider connection timed out');
                  if(globalThis.MISTRAL_RESPONSE==='held')await new Promise(resolve=>{globalThis.RELEASE_OCR=resolve});
                  return Response.json({code:200,data:{schema_version:'1.4.0',success_count:pages.length,metadata:{page_count:2},
                    pages:pages.map(n=>({page_number:n,status:'Success',element_ids:['text-'+n]})),
                    elements:pages.map(n=>({element_id:'text-'+n,page_number:n,type:'NarrativeText',text:'扫描通知 资助名单',metadata:{}}))}});
                }
                if(request.url!=='https://api.mistral.ai/v1/ocr')return originalFetch(request);
                globalThis.MISTRAL_CALLS.push({url:request.url,method:request.method,headers:{authorization:request.headers.get('authorization')},body:await request.json()});
                if(globalThis.MISTRAL_RESPONSE==='error')return Response.json({message:'upstream temporarily unavailable'},{status:500});
                const pdf=globalThis.MISTRAL_PDF;
                return Response.json({
                  model:'mistral-ocr-4-1',
                  pages:[{index:0,markdown:'扫描通知 资助名单',tables:[]}],
                  usage_info:{pages_processed:1,doc_size_bytes:pdf.byteLength},
                });
              };
              return Response.json({ok:true});
            }
            if(url.pathname==='/enqueue')return Response.json(await enqueuePdfOcr(env,url.searchParams.get('articleId'),{model:globalThis.OCR_MODEL,publish:url.searchParams.get('publish')==='1'}));
            if(url.pathname==='/run'){
              globalThis.CURRENT_JOB_ID=url.searchParams.get('jobId');
              const archive=env.ARCHIVE;
              const runEnv=globalThis.MISTRAL_RESPONSE==='write-failure'?{...env,ARCHIVE:{
                get:key=>archive.get(key),head:key=>archive.head(key),
                put:async(key,...args)=>{
                  if(key.endsWith('/ocr-0.json')&&!globalThis.STORAGE_FAILED){globalThis.STORAGE_FAILED=true;throw new Error('R2 temporary write failure')}
                  return archive.put(key,...args);
                },
              }}:env;
              const workflow=new PdfOcrWorkflow(runEnv);
              return Response.json(await workflow.run({instanceId:url.searchParams.get('instanceId'),payload:{jobId:url.searchParams.get('jobId')}},makeStep(env,url.searchParams.get('jobId'))));
            }
            if(url.pathname==='/publish')return Response.json(await publishPdfText(env,url.searchParams.get('articleId'),globalThis.OCR_MODEL));
            if(url.pathname==='/release'){globalThis.RELEASE_OCR?.();return Response.json({ok:true})}
            if(url.pathname==='/resume')return Response.json(await resumePdfOcr({...env,PDF_OCR_ENABLED:'true',PDF_OCR_MODEL:globalThis.OCR_MODEL}));
            if(url.pathname==='/benchmark-config')return Response.json(textinConfig([0]));
            if(url.pathname.startsWith('/api/'))return apiRoute(request,env);
            if(url.pathname==='/state')return Response.json({calls:globalThis.MISTRAL_CALLS,creations:globalThis.PDF_OCR_CREATIONS,r2ResultBeforePublish:globalThis.R2_RESULT_BEFORE_PUBLISH});
            return new Response('Not found',{status:404});
          }
        }
      `,
      resolveDir:process.cwd(),
      sourcefile:'pdf-ocr-fixture.mjs',
    },
    bundle:true,
    write:false,
    format:'esm',
    platform:'browser',
    external:['node:buffer','node:*'],
    plugins:[workflowPlugin],
  });
  mf=new Miniflare(convertV4Options({
    modules:true,
    script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
    bindings:{TEXTIN_APP_ID:'test-app-id',TEXTIN_SECRET_CODE:'test-secret',MISTRAL_API_KEY:'test-mistral-key',MAX_PDF_OCR_PAGES_PER_DAY:'50',MAX_PDF_OCR_PAGES_PER_MONTH:'1000'},
    d1Databases:['DB'],
    r2Buckets:['ARCHIVE'],
  }));
  db=await mf.getD1Database('DB');
  bucket=await mf.getR2Bucket('ARCHIVE');
  for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await db.prepare("INSERT INTO sources(id,name,url) VALUES ('test','测试来源','https://example.com/')").run();
});

after(async()=>{await mf?.dispose();});

beforeEach(async()=>{
  for(const table of ['pdf_ocr_calls','pdf_ocr_jobs','attachments','articles','pdf_ocr_usage','pdf_ocr_budget']){
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  let listing=await bucket.list();
  while(listing.objects.length){
    await Promise.all(listing.objects.map(object=>bucket.delete(object.key)));
    if(listing.truncated)listing=await bucket.list({cursor:listing.cursor});
    else break;
  }
});

function convertV4Options(options){
  return convertV4MiniflareOptions(options);
}

test('native-text PDF completes from cache without a paid OCR request',async()=>{
  const pdf=textPdf();
  await seedArticle({id:'native-text',objectKey:'original/native-text.pdf',pdf,body:'原生正文'});
  await configure(mf,pdf,'success');
  await enqueue(mf,'native-text',true);
  await runWorkflow(mf,(await jobByAttachment(db,'native-text')).id);

  assert.equal((await state(mf)).calls.length,0);
  assert.equal((await jobByAttachment(db,'native-text')).status,'complete');
  assert.equal((await jobByAttachment(db,'native-text')).ocr_pages,0);
  assert.match((await article(db,'native-text')).body_text,/CQU scholarship notice/);
  assert.deepEqual(await search(db,'原生正文'),['native-text']);

  assert.equal((await enqueue(mf,'native-text',true)).jobs[0].cached,true);
  assert.equal((await state(mf)).calls.length,0);
  assert.equal((await state(mf)).creations.length,1);
  assert.equal((await db.prepare('SELECT COUNT(*) count FROM pdf_ocr_jobs').first()).count,1);
});

test('image-only PDF uses the Mistral protocol and publishes R2 text before making it searchable',async()=>{
  const pdf=imagePdf('scanned');
  await seedArticle({id:'scanned',objectKey:'original/scanned.pdf',pdf,body:'扫描件暂无正文'});
  await bucket.put('articles/scanned/body.txt','通知说明\n如果您无法在线浏览此 PDF 文件，则可以下载此 PDF 文件\n# attachment-1.pdf\n## Metadata\n- PDFFormatVersion=1.7\n## Contents\n### Page 1\n');
  await configure(mf,pdf,'success');
  await enqueue(mf,'scanned',true);
  await runWorkflow(mf,(await jobByAttachment(db,'scanned')).id);

  const observed=await state(mf),http=observed.calls;
  assert.equal(observed.r2ResultBeforePublish,true);
  assert.equal(http.length,1);
  assert.equal(http[0].method,'POST');
  assert.equal(http[0].headers.authorization,'Bearer test-mistral-key');
  assert.equal(http[0].body.model,'mistral-ocr-4-1');
  assert.deepEqual(http[0].body.pages,[0]);
  assert.equal(http[0].body.document.type,'document_url');
  assert.equal(http[0].body.document.document_url,`data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`);

  const completed=await jobByAttachment(db,'scanned');
  assert.equal(completed.status,'complete');
  assert.equal(completed.ocr_pages,1);
  const artifact=await bucket.get(completed.result_key);
  assert.equal(artifact.httpMetadata.contentType,'application/json');
  const result=await artifact.json();
  assert.equal(result.sourceHash,completed.source_hash);
  assert.equal(result.pages[0].source,'ocr');
  assert.match(result.pages[0].text,/扫描通知 资助名单/);
  assert.equal((await article(db,'scanned')).body_text,'通知说明\n\n扫描通知 资助名单');
  const reading=await(await bucket.get((await article(db,'scanned')).ocr_result_key)).json();
  assert.equal(reading.htmlText,'通知说明');
  assert.deepEqual(await search(db,'资助名单'),['scanned']);

  await enqueue(mf,'scanned',true);
  assert.equal((await state(mf)).calls.length,1);
  assert.equal((await state(mf)).creations.length,1);

  // Another article referencing identical bytes reuses the provider result.
  await seedArticle({id:'same-file',objectKey:'original/copy.pdf',pdf,body:'另一篇通知'});
  await enqueue(mf,'same-file',true);
  await runWorkflow(mf,(await jobByAttachment(db,'same-file')).id);
  assert.equal((await state(mf)).calls.length,1);
  assert.deepEqual((await search(db,'资助名单')).sort(),['same-file','scanned']);
});

test('a local global budget limit defers the whole job without consuming its attempt',async()=>{
  const pdf=imagePdf('budget');
  await seedArticle({id:'budget',objectKey:'original/budget.pdf',pdf,body:'预算前正文'});
  await configure(mf,pdf,'success');
  const today=new Date().toISOString();
  await db.prepare('INSERT INTO pdf_ocr_budget(id,day,month,day_pages,month_pages) VALUES (1,?,?,50,999)').bind(today.slice(0,10),today.slice(0,7)).run();
  await db.prepare('UPDATE pdf_ocr_budget SET day_pages=50,month_pages=999').run();
  await enqueue(mf,'budget',true);
  await runWorkflow(mf,(await jobByAttachment(db,'budget')).id);

  const deferred=await jobByAttachment(db,'budget');
  assert.equal(deferred.status,'deferred_budget');
  assert.equal(deferred.attempts,0);
  assert.equal(deferred.lease_until,0);
  assert.equal((await state(mf)).calls.length,0);
  assert.equal((await article(db,'budget')).body_text,'预算前正文');
  assert.deepEqual(await search(db,'资助名单'),[]);
  assert.equal((await db.prepare('SELECT reserved_pages FROM pdf_ocr_usage WHERE period=?').bind(new Date().toISOString().slice(0,10)).first())?.reserved_pages,undefined);

  await db.prepare('UPDATE pdf_ocr_budget SET day_pages=0,month_pages=0').run();
  const retried=await enqueue(mf,'budget',true);
  assert.equal(retried.jobs[0].status,'pending');
  assert.equal((await state(mf)).creations.length,2);
});

test('provider failure never replaces the archived article or original PDF',async()=>{
  const pdf=imagePdf('provider-failure');
  await seedArticle({id:'provider-failure',objectKey:'original/provider-failure.pdf',pdf,body:'失败前正文'});
  await configure(mf,pdf,'error');
  await enqueue(mf,'provider-failure',true);
  await runWorkflow(mf,(await jobByAttachment(db,'provider-failure')).id);

  const failed=await jobByAttachment(db,'provider-failure');
  assert.equal(failed.status,'needs_review');
  assert.equal(failed.attempts,1);
  assert.match(failed.error,/Mistral OCR HTTP 500/);
  const current=await article(db,'provider-failure');
  assert.equal(current.body_text,'失败前正文');
  assert.equal(current.content_hash,sha256('失败前正文'));
  assert.equal(current.ocr_result_key,null);
  assert.deepEqual(await search(db,'失败前正文'),['provider-failure']);
  assert.deepEqual(await search(db,'资助名单'),[]);
  assert.equal(Buffer.from(await (await bucket.get('original/provider-failure.pdf')).arrayBuffer()).toString('binary'),pdf);
  await enqueue(mf,'provider-failure',true);
  await runWorkflow(mf,failed.id);
  await enqueue(mf,'provider-failure',true);
  assert.equal((await state(mf)).calls.length,1);
  assert.equal((await jobByAttachment(db,'provider-failure')).attempts,1);
});

test('OCR for a superseded original cannot publish over the current attachment',async()=>{
  const oldPdf=imagePdf('superseded-old');
  const newPdf=imagePdf('superseded-new');
  await seedArticle({id:'superseded',objectKey:'original/superseded-old.pdf',pdf:oldPdf,body:'旧正文'});
  await configure(mf,oldPdf,'success');
  await enqueue(mf,'superseded',true);
  await runWorkflow(mf,(await jobByAttachment(db,'superseded')).id);
  const before=await article(db,'superseded');
  assert.match(before.body_text,/扫描通知 资助名单/);

  const attachment=await jobByAttachment(db,'superseded');
  await bucket.put('original/superseded-new.pdf',new TextEncoder().encode(newPdf),{httpMetadata:{contentType:'application/pdf'}});
  await db.prepare("UPDATE attachments SET object_key='original/superseded-new.pdf',sha256=? WHERE id=?").bind(sha256(newPdf),attachment.attachment_id).run();

  const republish=await publish(mf,'superseded');
  assert.equal(republish.updated,false);
  assert.match(republish.reason,/pending/);
  const after=await article(db,'superseded');
  assert.equal(after.body_text,before.body_text);
  assert.equal(after.content_hash,before.content_hash);
  assert.equal(after.ocr_result_key,before.ocr_result_key);
  assert.equal(Buffer.from(await (await bucket.get('original/superseded-new.pdf')).arrayBuffer()).toString('binary'),newPdf);
});

function textPdf(){
  const stream='BT /F1 12 Tf 72 120 Td (CQU scholarship notice) Tj ET';
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]);
}

test('TextIn reads only the image-only page of a mixed ordinary attachment, then serves and searches cached text',async()=>{
  const id='a'.repeat(24),pdf=mixedPdf();
  await seedArticle({id,objectKey:'original/mixed.pdf',pdf,body:'混合附件通知',role:'attachment'});
  await configure(mf,pdf,'success','textin-xparse-auto');
  await enqueue(mf,id,true);
  const job=await jobByAttachment(db,id);
  await runWorkflow(mf,job.id);
  assert.equal((await jobByAttachment(db,id)).status,'complete');
  const observed=await state(mf);
  assert.equal(observed.calls.length,1);
  assert.equal(observed.calls[0].config.scope.page_range,'2');
  assert.equal(observed.r2ResultBeforePublish,true);
  const detail=await(await mf.dispatchFetch(`https://feed.test/api/articles/${id}`)).json();
  assert.equal(detail.article.ocr.model,'textin-xparse-auto');
  assert.deepEqual(detail.article.ocr.pages.map(p=>[p.page,p.source]),[[1,'native'],[2,'ocr']]);
  assert.match(detail.article.bodyText,/CQU caption/);
  assert.match(detail.article.bodyText,/资助名单/);
  const found=await(await mf.dispatchFetch('https://feed.test/api/articles?q=资助名单')).json();
  assert.equal(found.articles[0].id,id);
  const names=await bucket.list({prefix:'derived/pdf/'});
  assert.equal(names.objects.filter(o=>o.key.endsWith('.raw.json')).length,1);
  assert.equal(names.objects.filter(o=>o.key.endsWith('.request.json')).length,1);

  await seedArticle({id:'b'.repeat(24),objectKey:'original/duplicate-mixed.pdf',pdf,body:'另一通知',role:'attachment'});
  await enqueue(mf,'b'.repeat(24),true);
  await runWorkflow(mf,(await jobByAttachment(db,'b'.repeat(24))).id);
  assert.equal((await state(mf)).calls.length,1);
  assert.equal((await jobByAttachment(db,'b'.repeat(24))).attempts,0);
});

test('native caption plus image skips paid OCR, even when the text layer is short',async()=>{
  const pdf=imagePdf('caption',true);
  await seedArticle({id:'caption',objectKey:'original/caption.pdf',pdf,body:'短文字层'});
  await configure(mf,pdf,'error','textin-xparse-auto');
  await enqueue(mf,'caption',true);
  await runWorkflow(mf,(await jobByAttachment(db,'caption')).id);
  assert.equal((await jobByAttachment(db,'caption')).status,'complete');
  assert.equal((await state(mf)).calls.length,0);
  assert.match((await article(db,'caption')).body_text,/CQU caption/);
});

test('a paid TextIn timeout is not retried by cron or another article with identical bytes',async()=>{
  const pdf=imagePdf('uncertain');
  await seedArticle({id:'uncertain',objectKey:'original/uncertain.pdf',pdf,body:'原有正文'});
  await configure(mf,pdf,'error','textin-xparse-auto');
  await enqueue(mf,'uncertain',true);
  await runWorkflow(mf,(await jobByAttachment(db,'uncertain')).id);
  assert.equal((await jobByAttachment(db,'uncertain')).status,'needs_review');
  assert.deepEqual(await(await mf.dispatchFetch('https://feed.test/resume')).json(),[]);
  // Even restoring D1 from an older backup does not erase the R2 attempt receipt.
  await db.prepare('DELETE FROM pdf_ocr_calls').run();
  await seedArticle({id:'uncertain-copy',objectKey:'original/uncertain-copy.pdf',pdf,body:'另一通知'});
  await enqueue(mf,'uncertain-copy',true);
  await runWorkflow(mf,(await jobByAttachment(db,'uncertain-copy')).id);
  assert.equal((await state(mf)).calls.length,1);
  assert.equal((await article(db,'uncertain-copy')).ocr_result_key,null);
});

test('previously paid TextIn benchmark is promoted to reading without a new request or budget reservation',async()=>{
  const pdf=imagePdf('benchmark'),hash=sha256(pdf);
  await seedArticle({id:'benchmark',objectKey:'original/benchmark.pdf',pdf,body:'通知正文'});
  await configure(mf,pdf,'error','textin-xparse-auto');
  const config=await(await mf.dispatchFetch('https://feed.test/benchmark-config')).json();
  await bucket.put(`benchmarks/textin/${hash}/v2/auto/result.json`,JSON.stringify({summary:{sourceHash:hash,success:true},config,payload:{code:200,data:{
    schema_version:'1.4.0',success_count:1,metadata:{page_count:1},pages:[{page_number:1,status:'Success',element_ids:['one']}],
    elements:[{element_id:'one',page_number:1,type:'NarrativeText',text:'缓存名单 中文姓名',metadata:{}}],
  }}}));
  await enqueue(mf,'benchmark',true);
  await runWorkflow(mf,(await jobByAttachment(db,'benchmark')).id);
  assert.equal((await jobByAttachment(db,'benchmark')).status,'complete');
  assert.equal((await state(mf)).calls.length,0);
  assert.deepEqual(await search(db,'中文姓名'),['benchmark']);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM pdf_ocr_budget').first()).n,0);
});

test('a storage failure after TextIn responds recovers from raw R2 data without paying twice',async()=>{
  const pdf=imagePdf('storage-failure');
  await seedArticle({id:'raw-recovery',objectKey:'original/raw-recovery.pdf',pdf,body:'原有正文'});
  await configure(mf,pdf,'write-failure','textin-xparse-auto');
  await enqueue(mf,'raw-recovery',true);
  const job=await jobByAttachment(db,'raw-recovery');
  await runWorkflow(mf,job.id);
  assert.equal((await jobByAttachment(db,'raw-recovery')).status,'needs_review');
  assert.equal((await article(db,'raw-recovery')).body_text,'原有正文');
  await enqueue(mf,'raw-recovery',true);
  await runWorkflow(mf,job.id);
  assert.equal((await jobByAttachment(db,'raw-recovery')).status,'complete');
  assert.equal((await state(mf)).calls.length,1);
  assert.deepEqual(await search(db,'资助名单'),['raw-recovery']);
});

test('concurrent articles sharing a PDF only issue one TextIn request',async()=>{
  const pdf=imagePdf('concurrent');
  for(const id of ['first','second']){
    await seedArticle({id,objectKey:`original/${id}.pdf`,pdf,body:'通知正文'});
  }
  await configure(mf,pdf,'held','textin-xparse-auto');
  await enqueue(mf,'first',true);await enqueue(mf,'second',true);
  const first=await jobByAttachment(db,'first'),second=await jobByAttachment(db,'second');
  const running=runWorkflow(mf,first.id);
  try{
    for(let i=0;i<100&&(await state(mf)).calls.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await state(mf)).calls.length,1);
    await runWorkflow(mf,second.id);
    assert.equal((await jobByAttachment(db,'second')).status,'deferred_busy');
  }finally{
    await mf.dispatchFetch('https://feed.test/release');
    await running;
  }
  await runWorkflow(mf,second.id);
  assert.equal((await jobByAttachment(db,'second')).status,'complete');
  assert.equal((await state(mf)).calls.length,1);
});

// Real PDF objects: page one has a short native caption and an image; page two
// contains only an image. The production unpdf parser decides which to recognize.
function mixedPdf(){
  const first='q 200 0 0 200 20 20 cm /Im0 Do Q\nBT /F1 12 Tf 72 120 Td (CQU caption) Tj ET';
  const second='q 200 0 0 200 20 20 cm /Im0 Do Q';
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 6 0 R >> /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nP\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 8 0 R >>',
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ]);
}

function imagePdf(marker='image',caption=false){
  const content=`q 200 0 0 200 20 20 cm /Im0 Do Q\n${caption?'BT /F1 12 Tf 72 120 Td (CQU caption) Tj ET':''}\n% ${marker}`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 6 0 R >> /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nP\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function buildPdf(objects){
  let pdf='%PDF-1.7\n';
  const offsets=[0];
  objects.forEach((object,index)=>{
    offsets.push(pdf.length);
    pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;
  });
  const start=pdf.length;
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return pdf;
}

async function seedArticle({id,objectKey,pdf,body,role='body-pdf'}){
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,body_text,prefix,content_hash) VALUES (?,'test',?,?,'2026-10-01','2026-10-11','complete',?,?,?)")
    .bind(id,`https://example.com/${id}.html`,`${id} 通知`,body,`articles/${id}`,sha256(body)).run();
  await db.prepare("INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,bytes,content_type,sha256,status,role) VALUES (?,?,?,?,'attachment-1.pdf',?,?,?,?, 'complete','body-pdf')")
    .bind(`${id}-file`,id,`${id}.pdf`,`https://example.com/${id}.pdf`,objectKey,pdf.length,'application/pdf',sha256(pdf)).run();
  await db.prepare('UPDATE attachments SET role=? WHERE article_id=?').bind(role,id).run();
  await bucket.put(objectKey,new TextEncoder().encode(pdf),{httpMetadata:{contentType:'application/pdf'}});
  await bucket.put(`articles/${id}/body.txt`,body);
}

async function configure(worker,pdf,response,model='mistral-ocr-4-1'){
  const result=await worker.dispatchFetch(`https://feed.test/configure?response=${response}&model=${model}`,{method:'POST',body:pdf});
  if(!result.ok)throw new Error(await result.text());
  return result;
}

async function enqueue(worker,articleId,publish){
  const response=await worker.dispatchFetch(`https://feed.test/enqueue?articleId=${encodeURIComponent(articleId)}&publish=${publish?1:0}`);
  if(!response.ok)throw new Error(await response.text());
  return response.json();
}

async function runWorkflow(worker,jobId){
  const response=await worker.dispatchFetch(`https://feed.test/run?jobId=${encodeURIComponent(jobId)}&instanceId=${encodeURIComponent(`test-${jobId}`)}`);
  if(!response.ok)throw new Error(await response.text());
  return response.json();
}

async function publish(worker,articleId){
  const response=await worker.dispatchFetch(`https://feed.test/publish?articleId=${encodeURIComponent(articleId)}`);
  if(!response.ok)throw new Error(await response.text());
  return response.json();
}

async function state(worker){
  const response=await worker.dispatchFetch('https://feed.test/state');
  assert.equal(response.status,200);
  return response.json();
}

async function jobByAttachment(database,articleId){
  return database.prepare('SELECT * FROM pdf_ocr_jobs WHERE article_id=? ORDER BY created_at LIMIT 1').bind(articleId).first();
}

async function article(database,id){
  return database.prepare('SELECT body_text,content_hash,ocr_result_key,ocr_model FROM articles WHERE id=?').bind(id).first();
}

async function search(database,query){
  return (await database.prepare('SELECT id FROM article_search WHERE article_search MATCH ? ORDER BY rank').bind(JSON.stringify(query)).all()).results.map(row=>row.id);
}

async function applyMigration(database,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/).map(statement=>statement.trim()).filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await database.prepare(statement).run();
}

function sha256(value){
  return createHash('sha256').update(value).digest('hex');
}
