import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {oauthProvider,login} from './helpers/oauth-provider.mjs';

const articleId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';
const prefix='articles/1234567890abcdef12345678/legacy-run';

for(const [model,ocrRole,caption='',native=false] of [['mistral-ocr-4-1','body-pdf'],['textin-xparse-auto','body-pdf'],['textin-xparse-auto','attachment'],['mistral-ocr-4-1','body-pdf','page 1'],['textin-xparse-auto','attachment','page 1',true]])test(`an MVP ${model} ${ocrRole} ${caption} archive imports through Archive reconcile and supports read switching`,async()=>{
  const {mf,auth,bucket,legacy}=await fixture({model,ocrRole,caption,native});
  const pdfText=native?'page 1':'扫描通知 资助名单';
  try{
    const cookie=await login(mf,auth);
    const admin=(path,init={})=>mf.dispatchFetch('https://feed.test'+path,{
      ...init,headers:{Authorization:'Bearer migration-admin',...(init.headers??{})},
    });

    const submitted=await admin('/internal/archive-migration',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({requestId:'mvp-local-001',batchSize:20})});
    assert.equal(submitted.status,202,await submitted.clone().text());
    const result=await submitted.json();
    assert.equal(result.run.state,'succeeded');
    assert.equal(result.processed,1);
    assert.equal(result.remaining,0);
    assert.equal(result.blocked,0);

    const status=await(await admin('/internal/archive-migration')).json();
    assert.equal(status.run.state,'succeeded');
    assert.equal(status.report.legacy.articles,1);
    assert.equal(status.report.legacy.attachments,2);
    assert.equal(status.report.legacy.sourceAssociations,1);
    assert.equal(status.report.imported.ready,1);
    assert.equal(status.report.imported.contentEvents,1);
    assert.deepEqual(status.report.comparison.differences,[]);

    const read=(path,init={})=>mf.dispatchFetch('https://feed.test'+path,{...init,headers:{Cookie:cookie,...init.headers}});
    const history=await(await read(`/api/articles/${articleId}/revisions`)).json();
    assert.equal(history.revisions.length,1);
    const revision=history.revisions[0];
    assert.equal(revision.state,'ready');
    assert.equal(revision.changeKind,'baseline');
    assert.equal(status.report.imported.historyOnlyEvents,1);

    const detailResponse=await read(`/api/articles/${articleId}`);
    assert.equal(detailResponse.status,200,await detailResponse.clone().text());
    const detail=await detailResponse.json();
    assert.equal(detail.revision.id,revision.id);
    assert.equal(detail.article.ocr.model,model);
    assert.deepEqual(await (await bucket.get(legacy.keys.ocr)).json(),legacy.ocrResult);
    assert.equal(detail.article.bodyText,'通知说明\n\n'+pdfText);
    assert.equal(detail.article.ocr.pages.at(-1).filename,'attachment-1.pdf');
    assert.equal(detail.article.ocr.pages.at(-1).text,pdfText);

    const search=await(await read('/api/articles?'+new URLSearchParams({q:native?'page':'资助名单'}))).json();
    assert.deepEqual(search.articles.map(row=>row.id),[articleId]);
    const shortSearch=await(await read('/api/articles?'+new URLSearchParams({q:native?'pa':'名单'}))).json();
    assert.deepEqual(shortSearch.articles.map(row=>row.id),[articleId]);
    const file=await read(detail.attachments.find(item=>item.filename==='attachment-1.pdf').url,{headers:{Cookie:cookie,Range:'bytes=0-4'}});
    assert.equal(file.status,206);
    assert.equal(await file.text(),'%PDF-');
    const snapshot=await read(`/api/articles/${articleId}/revisions/${revision.id}/snapshot`);
    assert.equal(snapshot.status,200);
    const html=await snapshot.text();
    assert.match(html,/通知说明/);
    assert.match(html,new RegExp(`/reader/${articleId}/revisions/${revision.id}/attachment-1\\.pdf`));
    assert.doesNotMatch(html,/<script|javascript:|srcdoc=|http-equiv/i);
    assert.equal((await mf.dispatchFetch('https://feed.test'+detail.attachments.at(-1).url)).status,401);
    auth.setAccess(false);
    assert.equal((await read(`/api/articles/${articleId}`)).status,403);
    auth.setAccess(true);

    const legacyRange=await read(`/api/files/${articleId}/attachment-1.pdf`,{headers:{Cookie:cookie,Range:'bytes=0-4'}});
    assert.equal(legacyRange.status,206);
    assert.equal(await legacyRange.text(),'%PDF-');

    const switched=await mf.dispatchFetch('https://feed.test/fixture/read-switch',{method:'POST',body:'false'});
    assert.equal(await switched.text(),'false');
    const legacyDetail=await(await read(`/api/articles/${articleId}`)).json();
    assert.equal(legacyDetail.article.bodyText,'通知说明\n\n'+pdfText);
    const legacySearch=await(await read('/api/articles?'+new URLSearchParams({q:native?'page':'资助名单'}))).json();
    assert.deepEqual(legacySearch.articles.map(row=>row.id),[articleId]);
    const legacySnapshot=await read(`/api/snapshots/${articleId}`);
    assert.equal(legacySnapshot.status,200);
    assert.match(await legacySnapshot.text(),/通知说明/);

    await mf.dispatchFetch('https://feed.test/fixture/read-switch',{method:'POST',body:'true'});
    const switchedDetail=await(await read(`/api/articles/${articleId}`)).json();
    assert.equal(switchedDetail.revision.id,revision.id);
    assert.equal((await(await read(`/api/articles/${articleId}/revisions`)).json()).revisions.length,1);
    const replay=await admin('/internal/archive-migration',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({requestId:'mvp-local-001',batchSize:20})});
    assert.equal(replay.status,202,await replay.clone().text());
    assert.equal((await replay.json()).processed,0);
    const replayStatus=await(await admin('/internal/archive-migration')).json();
    assert.equal(replayStatus.report.imported.revisions,1);
    assert.equal(replayStatus.report.imported.contentEvents,1);
  }finally{
    await mf.dispose();
  }
});

test('a complete legacy record stays blocked until its original PDF OCR is recovered',async()=>{
  const {mf,auth,db,bucket,legacy}=await fixture();
  try{
    await bucket.delete(legacy.keys.ocr);
    await db.prepare("UPDATE pdf_ocr_jobs SET status='failed' WHERE id='legacy-ocr-1'").run();
    const cookie=await login(mf,auth);
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    const read=path=>mf.dispatchFetch('https://feed.test'+path,{headers:{Cookie:cookie}});
    const submitted=await admin('/internal/archive-migration',{requestId:'mvp-missing-ocr',batchSize:20});
    assert.equal(submitted.status,202,await submitted.clone().text());
    assert.equal((await submitted.json()).run.state,'blocked');
    const status=await(await admin('/internal/archive-migration')).json();
    assert.equal(status.report.imported.blocked,1);
    assert.equal(status.report.imported.contentEvents,0);
    assert.ok(status.report.comparison.differences.includes('ocr_result_missing'));
    const detail=await(await read(`/api/articles/${articleId}`)).json();
    const revisionId=detail.revision.id;
    assert.equal(detail.revision.state,'blocked');
    assert.equal((await(await read('/api/articles')).json()).articles[0].status,'partial');
    assert.equal((await read(`/api/articles/${articleId}/revisions/${revisionId}/files/attachment-1.pdf`)).status,409);

    await bucket.put(legacy.keys.ocr,JSON.stringify(legacy.ocrResult),{httpMetadata:{contentType:'application/json'}});
    await db.prepare("UPDATE pdf_ocr_jobs SET status='complete' WHERE id='legacy-ocr-1'").run();
    const repaired=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(repaired.status,202,await repaired.clone().text());
    assert.equal((await repaired.json()).state,'ready');
    const ready=await(await read(`/api/articles/${articleId}`)).json();
    assert.equal(ready.revision.id,revisionId);
    assert.equal(ready.revision.state,'ready');
    assert.equal(ready.article.bodyText,'通知说明\n\n扫描通知 资助名单');
    assert.deepEqual((await(await read('/api/articles?'+new URLSearchParams({q:'资助名单'}))).json()).articles.map(row=>row.id),[articleId]);
    assert.equal((await(await read(`/api/articles/${articleId}/revisions`)).json()).revisions.length,1);
    await admin('/internal/archive-migration/repair',{articleId});
    const replay=await(await admin('/internal/archive-migration')).json();
    assert.equal(replay.report.imported.contentEvents,1);
    assert.equal(replay.report.imported.historyOnlyEvents,1);
    assert.equal(replay.report.imported.blocked,0);
  }finally{await mf.dispose();}
});

test('migration repair uses the frozen original hash even if legacy metadata later changes',async()=>{
  const {mf,auth,db,bucket,legacy}=await fixture();
  try{
    const original=await(await bucket.get(legacy.keys.normal)).arrayBuffer();
    await bucket.delete(legacy.keys.normal);
    const cookie=await login(mf,auth);
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    const read=path=>mf.dispatchFetch('https://feed.test'+path,{headers:{Cookie:cookie}});
    const submitted=await admin('/internal/archive-migration',{requestId:'mvp-original-file',batchSize:20});
    assert.equal(submitted.status,202,await submitted.clone().text());
    assert.equal((await submitted.json()).run.state,'blocked');
    const first=await(await read(`/api/articles/${articleId}`)).json();
    const changed='%PDF-1.7\n后来替换的附件';
    await bucket.put(legacy.keys.normal,changed,{httpMetadata:{contentType:'application/pdf'}});
    await db.prepare('UPDATE attachments SET sha256=?,bytes=? WHERE id=?')
      .bind(sha256(changed),Buffer.byteLength(changed),'legacy-file-2').run();
    const rejected=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(rejected.status,202,await rejected.clone().text());
    assert.equal((await rejected.json()).state,'blocked');
    assert.equal((await(await admin('/internal/archive-migration')).json()).report.imported.contentEvents,0);

    await bucket.put(legacy.keys.normal,original,{httpMetadata:{contentType:'application/pdf'}});
    const repaired=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(repaired.status,202,await repaired.clone().text());
    assert.equal((await repaired.json()).state,'ready');
    const detail=await(await read(`/api/articles/${articleId}`)).json();
    assert.equal(detail.revision.id,first.revision.id);
    const saved=await read(detail.attachments.find(row=>row.filename==='attachment-2.pdf').url);
    assert.equal(saved.status,200);
    assert.deepEqual(new Uint8Array(await saved.arrayBuffer()),new Uint8Array(original));
    assert.equal((await(await read(`/api/articles/${articleId}/revisions`)).json()).revisions.length,1);

    // Firecrawl returns HTML text before collect appends PDF reader text.
    for(const [taskId,body,changeKind] of [
      ['abcdefabcdefabcdef123456','通知说明','presentation_only'],
      ['abcdefabcdefabcdef123457','通知说明：申请截止日期已延期','substantive'],
    ]){
      const clock=Date.now();
      await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
        VALUES (?,'capture',?,'jwc',?,'{}','running',?,1,?,?)`)
        .bind(taskId,taskId,articleId,clock,clock,clock).run();
      await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
        VALUES (?,1,?,'running',?)`).bind(taskId,taskId,clock).run();
      const snapshot=await(await bucket.get(legacy.keys.snapshot)).text();
      const files=[{filename:'attachment-1.pdf',key:legacy.keys.pdf,url:'https://jwc.cqu.edu.cn/body.pdf',name:'正文.pdf',role:'body-pdf'},
        {filename:'attachment-2.pdf',key:legacy.keys.normal,url:'https://jwc.cqu.edu.cn/normal.pdf',name:'普通附件.pdf',role:'attachment'}];
      const artifacts=await Promise.all(files.map(async file=>({name:file.filename,contentType:'application/pdf',
        base64:Buffer.from(await(await bucket.get(file.key)).arrayBuffer()).toString('base64')})));
      artifacts.push({name:'offline.html',contentType:'text/html',base64:Buffer.from(snapshot).toString('base64')});
      const recaptured=await mf.dispatchFetch('https://feed.test/fixture/capture',{method:'POST',body:JSON.stringify({taskId,
        page:{bodyRecognized:true,page:{url:articleUrl,title:'迁移通知'},bodyText:body,errors:[],artifacts,
          attachmentCandidates:files.map(file=>({url:file.url,name:file.name,role:file.role})),
          downloads:files.map(file=>({url:file.url,role:file.role,kind:'pdf',originalFile:true,saved:{name:file.filename},fetchedAt:new Date(clock).toISOString()}))}})});
      assert.equal(recaptured.status,200,await recaptured.clone().text());
      const captured=await recaptured.json();
      assert.ok(captured.revisionId,JSON.stringify(captured));
      const sameSource=await(await read(`/api/articles/${articleId}/revisions`)).json();
      assert.equal(sameSource.revisions[0].changeKind,changeKind);
    }
  }finally{await mf.dispose();}
});

test('bounded migration batches resume concurrently and expose paged comparison evidence',async()=>{
  const {mf,auth,db,bucket,legacy}=await fixture();
  const secondId='2234567890abcdef12345678';
  try{
    const secondPrefix=`articles/${secondId}/old`;
    await bucket.put(`${secondPrefix}/body.txt`,'第二篇旧通知');
    await bucket.put(`${secondPrefix}/offline.html`,'<html><body>第二篇旧通知</body></html>');
    await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,captured_at,status,
      body_text,excerpt,prefix,attachment_count,snapshot_key) VALUES (?,'jwc',?,'第二篇旧通知','2026-10-08',
      '2026-10-09T08:00:00Z','2026-10-10T09:00:00Z','complete','第二篇旧通知','第二篇旧通知',?,0,?)`)
      .bind(secondId,'https://jwc.cqu.edu.cn/second.htm',secondPrefix,`${secondPrefix}/offline.html`).run();
    await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,'jwc',1791532800000,1791622800000,
      'migrated','2026-10-08','2026-10-08','day','Asia/Shanghai')`).bind(secondId).run();
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    const first=await admin('/internal/archive-migration',{requestId:'mvp-bounded-batch',batchSize:1});
    assert.equal(first.status,202,await first.clone().text());
    const initial=await first.json();
    assert.equal(initial.processed,1);
    assert.equal(initial.remaining,1);
    assert.equal(initial.run.state,'running');
    const pageResponse=await admin('/internal/archive-migration/articles?limit=1');
    assert.equal(pageResponse.status,200,await pageResponse.clone().text());
    const firstPage=await pageResponse.json();
    assert.equal(firstPage.articles.length,1);
    assert.equal(firstPage.articles[0].articleId,articleId);
    assert.equal(firstPage.articles[0].comparison.actual.adoptedOcr[0].inputHash,legacy.ocrResult.sourceHash);
    assert.equal(firstPage.articles[0].comparison.expected.attachmentHashes.length,2);
    const original=firstPage.articles[0].comparison.actual.originals.find(row=>row.filename==='attachment-1.pdf');
    assert.equal(original.sha256,legacy.ocrResult.sourceHash);
    assert.equal(original.state,'fulfilled');

    const continued=await Promise.all([admin('/internal/archive-migration/process',{batchSize:1}),
      admin('/internal/archive-migration/process',{batchSize:1})]);
    for(const response of continued)assert.equal(response.status,202,await response.clone().text());
    const status=await(await admin('/internal/archive-migration')).json();
    assert.equal(status.run.state,'succeeded');
    assert.equal(status.remaining,0);
    assert.equal(status.report.imported.revisions,2);
    assert.equal(status.report.imported.historyOnlyEvents,2);
    const secondPage=await(await admin('/internal/archive-migration/articles?'+new URLSearchParams({limit:'1',after:articleId}))).json();
    assert.deepEqual(secondPage.articles.map(row=>row.articleId),[secondId]);
    const source=secondPage.articles[0].comparison.actual.sources[0];
    assert.equal(source.datePrecision,'day');
    assert.equal(source.publishedDay,'2026-10-08');
    assert.equal(source.publishedAt,'2026-10-08');
    assert.equal(source.firstSeenAt,1791532800000);
    assert.equal((await admin('/internal/archive-migration/articles?limit=0')).status,400);
    assert.equal((await mf.dispatchFetch('https://feed.test/internal/archive-migration/articles')).status,401);
    const cookie=await login(mf,auth);
    for(const id of [articleId,secondId]){
      const revisions=await(await mf.dispatchFetch(`https://feed.test/api/articles/${id}/revisions`,{headers:{Cookie:cookie}})).json();
      assert.equal(revisions.revisions.length,1);
    }
    const replay=await admin('/internal/archive-migration',{requestId:'mvp-bounded-batch',batchSize:1});
    assert.equal((await replay.json()).processed,0);
  }finally{await mf.dispose();}
});

test('legacy OCR must identify the original PDF and cover every scanned page',async()=>{
  const {mf,bucket,legacy}=await fixture({pageCount:2});
  try{
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    await bucket.put(legacy.keys.ocr,JSON.stringify({...legacy.ocrResult,pages:legacy.ocrResult.pages.slice(0,1)}));
    const first=await admin('/internal/archive-migration',{requestId:'mvp-partial-pages',batchSize:20});
    assert.equal(first.status,202,await first.clone().text());
    assert.equal((await first.json()).run.state,'blocked');
    const unidentified={...legacy.ocrResult};delete unidentified.sourceHash;
    await bucket.put(legacy.keys.ocr,JSON.stringify(unidentified));
    const unsafe=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(unsafe.status,202,await unsafe.clone().text());
    assert.equal((await unsafe.json()).state,'blocked');
    assert.equal((await(await admin('/internal/archive-migration')).json()).report.imported.contentEvents,0);
    await bucket.put(legacy.keys.ocr,JSON.stringify(legacy.ocrResult));
    const complete=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(complete.status,202,await complete.clone().text());
    assert.equal((await complete.json()).state,'ready');
    const report=await(await admin('/internal/archive-migration')).json();
    assert.equal(report.report.imported.revisions,1);
    assert.equal(report.report.imported.historyOnlyEvents,1);
  }finally{await mf.dispose();}
});

test('migration resumes after storage succeeds but the database import is interrupted',async()=>{
  const {mf}=await fixture();
  try{
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/fail-batch',{method:'POST'});
    const interrupted=await admin('/internal/archive-migration',{requestId:'mvp-interrupted-write',batchSize:1});
    assert.equal(interrupted.status,202,await interrupted.clone().text());
    assert.equal((await interrupted.json()).run.state,'failed');
    const failed=await(await admin('/internal/archive-migration')).json();
    assert.equal(failed.remaining,1);
    assert.equal(failed.report.imported.contentEvents,0);
    const repaired=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(repaired.status,202,await repaired.clone().text());
    assert.equal((await repaired.json()).state,'ready');
    const completed=await(await admin('/internal/archive-migration')).json();
    assert.equal(completed.run.state,'succeeded');
    assert.equal(completed.remaining,0);
    assert.equal(completed.report.imported.revisions,1);
    assert.equal(completed.report.imported.historyOnlyEvents,1);
    const replay=await admin('/internal/archive-migration',{requestId:'mvp-interrupted-write',batchSize:1});
    assert.equal((await replay.json()).processed,0);
  }finally{await mf.dispose();}
});

test('recovering a missing body PDF requires OCR and preserves unconfirmed migration evidence',async()=>{
  const {mf,db,bucket,legacy}=await fixture();
  try{
    await db.prepare('UPDATE articles SET discovered_at=?,captured_at=NULL WHERE id=?')
      .bind('not-a-date',articleId).run();
    const pdf=await(await bucket.get(legacy.keys.pdf)).arrayBuffer();
    await bucket.delete(legacy.keys.pdf);
    const admin=(path,body)=>mf.dispatchFetch('https://feed.test'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer migration-admin','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    const first=await admin('/internal/archive-migration',{requestId:'mvp-body-pdf-recover',batchSize:20});
    assert.equal(first.status,202,await first.clone().text());
    assert.equal((await first.json()).run.state,'blocked');
    const initial=await(await admin('/internal/archive-migration')).json();
    assert.ok(initial.report.comparison.differences.includes('observed_time_missing'));
    await bucket.put(legacy.keys.pdf,pdf,{httpMetadata:{contentType:'application/pdf'}});
    await bucket.delete(legacy.keys.ocr);
    const waiting=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(waiting.status,202,await waiting.clone().text());
    assert.equal((await waiting.json()).state,'blocked');
    assert.equal((await(await admin('/internal/archive-migration')).json()).report.imported.contentEvents,0);
    const partialReport=await(await admin('/internal/archive-migration/articles')).json();
    assert.equal(partialReport.articles[0].comparison.actual.originals.find(row=>row.filename==='attachment-1.pdf').state,'fulfilled');
    assert.equal(partialReport.articles[0].comparison.actual.adoptedOcr.length,0);
    assert.equal((await(await admin('/internal/archive-migration/repair',{articleId})).json()).state,'blocked');
    const repeated=await(await admin('/internal/archive-migration/articles')).json();
    assert.deepEqual(repeated.articles[0].differences,partialReport.articles[0].differences,
      'Retrying the same incomplete repair must not duplicate diagnostic evidence');
    await bucket.put(legacy.keys.ocr,JSON.stringify(legacy.ocrResult));
    const repaired=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal(repaired.status,202,await repaired.clone().text());
    assert.equal((await repaired.json()).state,'ready');
    const report=await(await admin('/internal/archive-migration')).json();
    assert.equal(report.report.imported.revisions,1);
    assert.equal(report.report.imported.historyOnlyEvents,1);
    assert.ok(report.report.comparison.differences.includes('observed_time_missing'),
      'Repairing the PDF and OCR must not erase unconfirmed original capture time');
    const finalArticles=await(await admin('/internal/archive-migration/articles')).json();
    assert.equal(finalArticles.articles[0].differences.filter(item=>item.code==='observed_time_missing').length,1);
    const again=await admin('/internal/archive-migration/repair',{articleId});
    assert.equal((await again.json()).repaired,false);
  }finally{await mf.dispose();}
});

async function fixture({pageCount=1,model='mistral-ocr-4-1',ocrRole='body-pdf',caption='',native=false}={}){
  const bundle=await build({stdin:{contents:`
    import worker from './worker/index.mjs';
    import {createArchive} from './worker/archive.mjs';
    import {createCollector} from './worker/collect.mjs';
    let reads=true,failBatch=false;
    export default{
      async fetch(request,raw){
        if(new URL(request.url).pathname==='/fixture/capture'){
          const {taskId,page}=await request.json();
          const collector=createCollector({scrape:async()=>({markdown:page.bodyText,metadata:{statusCode:200,creditsUsed:1},
            actions:{javascriptReturns:[{value:JSON.stringify(page)}]}})});
          return Response.json(await createArchive(raw,{collector}).captureTask(taskId,1));
        }
        if(new URL(request.url).pathname==='/fixture/read-switch'&&request.method==='POST'){
          reads=await request.text()==='true';return new Response(String(reads));
        }
        if(new URL(request.url).pathname==='/fixture/fail-batch'&&request.method==='POST'){
          failBatch=true;return new Response('armed');
        }
        const db=new Proxy(raw.DB,{get(target,key){
          if(key==='batch')return async statements=>{
            if(failBatch){failBatch=false;throw new Error('controlled database interruption');}
            return target.batch(statements);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        return worker.fetch(request,{...raw,DB:db,ARCHIVE_READS_ENABLED:String(reads)});
      },
    };
  `,resolveDir:process.cwd(),sourcefile:'archive-migration-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'browser',external:['node:*','cloudflare:workers']});
  const auth=oauthProvider();
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    serviceBindings:{AUTH:request=>auth.fetch(request)},
    bindings:{...auth.bindings,ADMIN_TOKEN:'migration-admin',BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge-secret',
      TASK_RUNTIME_ENABLED:'true',ARCHIVE_VERSIONS_ENABLED:'true',PDF_OCR_ENABLED:'false',PDF_OCR_MODEL:'mistral-ocr-4-1'}}));
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  try{
    for(const name of ['0001_feed.sql','0002_auth.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql','0009_subscriptions.sql','0010_subscription_editing.sql','0011_archive_migration.sql']){
      await applyMigration(db,await readFile('migrations/'+name,'utf8'));
    }
    const legacy=await seedLegacyArchive({db,bucket,pageCount,model,ocrRole,caption,native});
    return {mf,auth,db,bucket,legacy};
  }catch(error){
    await mf.dispose();throw error;
  }
}

async function seedLegacyArchive({db,bucket,pageCount=1,model='mistral-ocr-4-1',ocrRole='body-pdf',caption='',native=false}){
  const pdf=scannedPdf(pageCount,caption),normalAttachment='%PDF-1.7\n普通附件';
  const pdfHash=sha256(pdf),normalHash=sha256(normalAttachment);
  const body='通知说明\n\nPDF 正文暂未提取到可搜索文字；可在下方阅读原文件。';
  const snapshot=`<html><body><main><h1>迁移通知</h1><p>通知说明</p><iframe data-feed-pdf="attachment-1.pdf" src="https://jwc.cqu.edu.cn/old.pdf" width="700"></iframe></main><script>alert(1)</script></body></html>`;
  const keys={
    body:`${prefix}/body.txt`,snapshot:`${prefix}/offline.html`,
    pdf:`${prefix}/attachment-1.pdf`,normal:`${prefix}/attachment-2.pdf`,
    ocr:`derived/pdf/${pdfHash}/${model}/${model==='textin-xparse-auto'?'v1-no-text-75eefb13df7f1ce9':'v1'}/result.json`,
  };
  await bucket.put(keys.body,new TextEncoder().encode(body),{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
  await bucket.put(keys.snapshot,new TextEncoder().encode(snapshot),{httpMetadata:{contentType:'text/html; charset=utf-8'}});
  await bucket.put(keys.pdf,new TextEncoder().encode(pdf),{httpMetadata:{contentType:'application/pdf'}});
  await bucket.put(keys.normal,new TextEncoder().encode(normalAttachment),{httpMetadata:{contentType:'application/pdf'}});
  const text=native?caption:'扫描通知 资助名单';
  const ocrResult={sourceHash:pdfHash,model,totalPages:pageCount,
    pages:Array.from({length:pageCount},(_,index)=>({index,text,markdown:text,source:native?'native':'ocr'})),createdAt:'2026-10-10T08:00:00Z'};
  await bucket.put(keys.ocr,new TextEncoder().encode(JSON.stringify(ocrResult)),{httpMetadata:{contentType:'application/json'}});
  const now=Date.parse('2026-10-10T09:00:00Z');
  await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,captured_at,status,attempts,body_text,excerpt,prefix,content_hash,attachment_count,snapshot_key,ocr_result_key,ocr_model,ocr_updated_at)
    VALUES (?,'jwc',?,'迁移通知','unknown','2026-10-09T08:00:00Z','2026-10-10T09:00:00Z','complete',0,?,?,?,?,2,?,?,?,'2026-10-10T10:00:00Z')`)
    .bind(articleId,articleUrl,'通知说明\n\n'+text,'通知说明',prefix,sha256('通知说明\n\n'+text),keys.snapshot,keys.ocr,model).run();
  await db.prepare(`INSERT INTO attachments(id,article_id,name,original_url,filename,object_key,bytes,content_type,sha256,status,role)
    VALUES ('legacy-file-1',?,'正文.pdf','https://jwc.cqu.edu.cn/body.pdf','attachment-1.pdf',?,?,?,?, 'complete',?),
      ('legacy-file-2',?,'普通附件.pdf','https://jwc.cqu.edu.cn/normal.pdf','attachment-2.pdf',?,?,?,?, 'complete','attachment')`)
    .bind(articleId,keys.pdf,Buffer.byteLength(pdf),'application/pdf',pdfHash,ocrRole,articleId,keys.normal,Buffer.byteLength(normalAttachment),'application/pdf',normalHash).run();
  await db.prepare(`INSERT INTO pdf_ocr_jobs(id,article_id,attachment_id,source_hash,source_key,filename,model,status,attempts,total_pages,ocr_pages,result_key,created_at,updated_at)
    VALUES ('legacy-ocr-1',?,'legacy-file-1',?,?,?,?, 'complete',1,?,?,?, ?,?)`)
    .bind(articleId,pdfHash,keys.pdf,'attachment-1.pdf',model,pageCount,native?0:pageCount,keys.ocr,now,now).run();
  await db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone)
    VALUES (?,'jwc',?,?,?,?,?,'unknown','Asia/Shanghai')`)
    .bind(articleId,Date.parse('2026-10-09T08:00:00Z'),Date.parse('2026-10-10T09:00:00Z'),'migrated',null,null).run();
  return {keys,ocrResult};
}

function scannedPdf(pageCount=1,caption=''){
  const stream='q 200 0 0 200 20 20 cm /Im0 Do Q'+(caption?' BT /F1 12 Tf 72 120 Td ('+caption+') Tj ET':'');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,index)=>`${3+index*3} 0 R`).join(' ')}] /Count ${pageCount} >>`];
  for(let index=0;index<pageCount;index++){
    const page=3+index*3;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /XObject << /Im0 ${page+2} 0 R >> >> /Contents ${page+1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nP\nendstream');
  }
  return buildPdf(objects);
}

function buildPdf(objects){
  let pdf='%PDF-1.7\n';const offsets=[];
  objects.forEach((object,index)=>{offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const start=pdf.length;
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('');
  return pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
}

function sha256(value){
  return createHash('sha256').update(value).digest('hex');
}

async function applyMigration(db,sql){
  for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|INSERT|UPDATE|$)/).map(value=>value.trim()).filter(Boolean)){
    if(!/^PRAGMA\b/i.test(statement))await db.prepare(statement).run();
  }
}
