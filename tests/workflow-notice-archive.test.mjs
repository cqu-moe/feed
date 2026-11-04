import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mixedPdf} from './helpers/mixed-pdf.mjs';

const articleId='a1b2c3d4e5f6a1b2c3d4e5f6';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/900.htm';
const bundle=await build({entryPoints:['tests/helpers/archive-workflow-worker.mjs'],bundle:true,write:false,format:'esm',platform:'browser',external:['node:*','cloudflare:workers']});

// Owner: native CaptureWorkflow -> real Archive/D1/R2 -> task and event records.
// Existing version tests execute in Queue and cannot detect Workflow retry policy.
for(const response of [
  {success:false,error:'Provider quota exhausted',retryable:true},
  {success:false,error:'Payment required',code:'quota_exhausted',retryable:true,httpStatus:402},
]){
  test(`Workflow capture blocks ${response.error} without retrying a provider retry hint`,async()=>{
    const f=await fixture({responses:[response]});
    try{
      const {task}=await f.post('/capture',{articleId,requestId:'workflow-quota-001'});
      await f.post('/launch');
      const status=await f.finished(task.id);
      assert.equal(status.state,'blocked',JSON.stringify(status));
      assert.equal(status.errorCode,'quota_exhausted');
      assert.equal(f.browser.calls.length,1,'quota exhaustion must not make another origin request');
      assert.deepEqual(f.waits,[],'quota exhaustion must not enter the transient retry loop');
      assert.deepEqual(await f.get('/revisions?articleId='+articleId),[]);
    }finally{await f.mf.dispose();}
  });
}

test('native capture records a permanent origin error once without retrying or publishing content',async()=>{
  const f=await fixture({responses:[{success:false,error:'Origin HTTP 404',httpStatus:404,retryable:false}]});
  try{
    const {task}=await f.post('/capture',{articleId,requestId:'workflow-permanent-001'});
    await f.post('/launch');
    const status=await f.finished(task.id);
    assert.equal(status.state,'failed',JSON.stringify(status));
    assert.equal(status.errorCode,'capture_failed');
    assert.equal(f.browser.calls.length,1);
    assert.deepEqual(f.waits,[]);
    assert.deepEqual(await f.get('/revisions?articleId='+articleId),[]);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,0);
  }finally{await f.mf.dispose();}
});

// Capacity is pre-execution; only the 429, disconnect and success consume the
// three permitted origin attempts. No Cron or recover endpoint runs here.
test('native capture waits outside the site, honors Retry-After and survives disconnects in one attempt',async()=>{
  const f=await fixture({responses:[...Array(4).fill({capacity:true}),
    {success:false,error:'Origin HTTP 429',httpStatus:429,retryable:true,retryAfter:'720'},
    {disconnect:true},notice('甲')]});
  try{
    const {task}=await f.post('/capture',{articleId,requestId:'workflow-transient-001'});
    await f.post('/launch');
    const status=await f.finished(task.id);
    assert.equal(status.state,'succeeded',JSON.stringify(status));
    assert.equal(status.attemptNo,1);
    assert.equal(status.workflowInstanceId,`task-${task.id}-a1`);
    assert.equal(f.browser.calls.length,7);
    assert.deepEqual(f.waits.map(wait=>wait.duration),[30000,60000,90000,120000,720000,120000]);
    assert.ok(f.waits.every(wait=>wait.siteOwners===0),'waiting Workflows must release the site');
    await f.post('/events');
    const revisions=await f.get('/revisions?articleId='+articleId);
    assert.equal(revisions.length,1);
    const saved=await f.get(`/read?articleId=${articleId}&revisionId=${revisions[0].id}`);
    assert.equal(saved.revision.state,'ready');
    assert.equal(saved.article.bodyText,'归档正文甲');
    assert.deepEqual((await f.db.prepare('SELECT kind FROM content_events').all()).results,[{kind:'initial'}]);
    await f.post('/launch');
    await f.post('/events');
    assert.equal(f.browser.calls.length,7);
    assert.equal((await f.get('/revisions?articleId='+articleId)).length,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,1);
  }finally{await f.mf.dispose();}
});

// Storage acknowledgements may be lost before or after the atomic archive
// commit. The provider has already returned original bytes in all three cases.
for(const stage of ['journal-write','before-commit','after-commit']){
  test(`native capture reuses its journal after ${stage} interruption without duplicate versions or events`,async()=>{
    const f=await fixture({responses:[notice('原件')],fault:{stage,remaining:1}});
    try{
      const {task}=await f.post('/capture',{articleId,requestId:'workflow-journal-'+stage});
      await f.post('/launch');
      const status=await f.finished(task.id);
      assert.equal(status.state,'succeeded',JSON.stringify(status));
      assert.equal(status.attemptNo,1);
      assert.equal(f.faults.length,1,'the storage interruption must actually fire');
      assert.equal(f.faults[0].siteOwners,0,'archive storage must not hold the site');
      assert.equal(f.browser.calls.length,1,'saved originals must not be fetched again');
      assert.equal(f.waits.length,stage==='after-commit'?0:1);
      await f.post('/events');
      const [revision]=await f.get('/revisions?articleId='+articleId);
      const read=await f.get(`/read?articleId=${articleId}&revisionId=${revision.id}`);
      assert.equal(read.article.bodyText,'归档正文原件');
      assert.equal(read.revision.state,'ready');
      await f.post('/launch');
      await f.post('/events');
      assert.equal((await f.get('/revisions?articleId='+articleId)).length,1);
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,1);
      assert.equal(f.browser.calls.length,1);
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM capture_observations').first()).n,1);
    }finally{await f.mf.dispose();}
  });
}

test('native recheck retries and resumes saved originals while preserving old versions and suppressing unchanged updates',async()=>{
  const f=await fixture({responses:[notice('甲'),
    {success:false,error:'Origin HTTP 429',httpStatus:429,retryable:true,retryAfter:'180'},notice('乙'),notice('乙')],
    fault:{stage:'before-commit',remaining:2,afterCalls:3}});
  try{
    const {task}=await f.post('/capture',{articleId,requestId:'workflow-recheck-baseline'});
    await f.post('/launch');
    assert.equal((await f.finished(task.id)).state,'succeeded');
    await f.post('/events');
    const [original]=await f.get('/revisions?articleId='+articleId);

    const recheck=await f.recheck();
    await f.post('/launch');
    const status=await f.finished(recheck);
    assert.equal(status.kind,'recheck');
    assert.equal(status.state,'succeeded',JSON.stringify(status));
    assert.equal(status.attemptNo,1);
    assert.equal(status.workflowInstanceId,`task-${recheck}-a1`);
    assert.equal(f.browser.calls.length,3,'archive commit retries must reuse originals');
    assert.equal(f.faults.length,2);
    assert.deepEqual(f.waits.map(wait=>wait.duration),[180000,60000,120000]);
    await f.post('/events');
    const revisions=await f.get('/revisions?articleId='+articleId);
    assert.equal(revisions.length,2);
    assert.equal((await f.get(`/read?articleId=${articleId}&revisionId=${original.id}`)).article.bodyText,'归档正文甲');
    assert.equal((await f.get(`/read?articleId=${articleId}&revisionId=${revisions[0].id}`)).article.bodyText,'归档正文乙');
    assert.deepEqual((await f.db.prepare('SELECT kind FROM content_events ORDER BY ready_at,id').all()).results,[{kind:'initial'},{kind:'update'}]);

    const unchanged=await f.recheck();
    await f.post('/launch');
    assert.equal((await f.finished(unchanged)).state,'succeeded');
    await f.post('/events');
    await f.post('/launch');
    await f.post('/events');
    assert.equal(f.browser.calls.length,4);
    assert.equal((await f.get('/revisions?articleId='+articleId)).length,2);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,2);
    assert.equal((await f.db.prepare('SELECT outcome FROM capture_observations WHERE task_id=?').bind(unchanged).first()).outcome,'unchanged');
  }finally{await f.mf.dispose();}
});

for(const kind of ['capture','recheck']){
  test(`native ${kind} stops returned source errors at the origin attempt limit`,async()=>{
    const rateLimited={success:false,error:'Origin HTTP 429',httpStatus:429,retryable:true};
    const f=await fixture({responses:kind==='recheck'?[notice('基线'),rateLimited]:[rateLimited]});
    try{
      let taskId;
      if(kind==='recheck'){
        const {task}=await f.post('/capture',{articleId,requestId:'workflow-limit-baseline'});
        await f.post('/launch');
        assert.equal((await f.finished(task.id)).state,'succeeded');
        await f.post('/events');
        taskId=await f.recheck();
      }else taskId=(await f.post('/capture',{articleId,requestId:'workflow-limit-capture'})).task.id;
      await f.post('/launch');
      const status=await f.finished(taskId);
      assert.equal(status.state,'blocked',JSON.stringify(status));
      assert.equal(status.errorCode,'rate_limited');
      assert.equal(status.attemptNo,1);
      assert.equal(f.browser.calls.length,kind==='recheck'?4:3);
      assert.deepEqual(f.waits.map(wait=>wait.duration),[60000,120000]);
      await f.post('/events');
      assert.equal((await f.get('/revisions?articleId='+articleId)).length,kind==='recheck'?1:0);
      assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,kind==='recheck'?1:0);
      await f.post('/launch');
      assert.equal(f.browser.calls.length,kind==='recheck'?4:3);
    }finally{await f.mf.dispose();}
  });
}

test('two native list Workflows associate one notice with both columns and launch one immediate capture',async()=>{
  const f=await fixture({seedArticle:false,onScrape:async input=>{
    await new Promise(resolve=>setTimeout(resolve,30));
    return input.formats.includes('links')?{success:true,data:{actions:{javascriptReturns:[{value:JSON.stringify({
      articles:[{url:articleUrl,title:'归档通知',publishedAt:new Date().toISOString()}],next:[],
    })}]}}}:notice('多栏目');
  }});
  try{
    await f.db.prepare("UPDATE sources SET next_discovery_at=0 WHERE id='jwc'").run();
    await f.db.prepare(`INSERT INTO sources(id,name,url,site_id,list_url,config_json,enabled,validation_state,next_discovery_at)
      SELECT 'jwc-second','另一栏目',url,site_id,'https://jwc.cqu.edu.cn/second.htm',config_json,1,'verified',0 FROM sources WHERE id='jwc'`).run();
    const scheduled=await f.post('/discover');
    assert.equal(scheduled.scheduled.length,2);
    await f.post('/launch');
    for(const taskId of scheduled.scheduled)assert.equal((await f.finished(taskId)).state,'succeeded');
    const associations=(await f.db.prepare('SELECT article_id,source_id FROM article_sources ORDER BY source_id').all()).results;
    assert.equal(associations.length,2);
    assert.deepEqual(associations.map(row=>row.source_id),['jwc','jwc-second']);
    assert.equal(associations[0].article_id,associations[1].article_id);
    const captures=(await f.db.prepare("SELECT id,article_id,due_at FROM tasks WHERE kind='capture'").all()).results;
    assert.equal(captures.length,1);
    assert.ok(captures[0].due_at<=Date.now(),'first capture must not wait for the next hourly scan');
    await f.post('/launch');
    assert.equal((await f.finished(captures[0].id)).state,'succeeded');
    await f.post('/events');
    assert.equal(f.browser.maxPerSite,1,'list and capture access must share site exclusion');
    assert.equal(f.browser.calls.filter(call=>!call.formats.includes('links')).length,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM event_sources').first()).n,2);
  }finally{await f.mf.dispose();}
});

test('native archive publishes no content event for missing attachments or pending OCR and publishes once after OCR completes',async()=>{
  const f=await fixture({responses:[notice('缺附件',{missingAttachment:true}),notice('需识别',{bodyPdf:true})]});
  try{
    const first=(await f.post('/capture',{articleId,requestId:'workflow-missing-attachment'})).task.id;
    await f.post('/launch',{taskId:first});
    assert.equal((await f.finished(first)).state,'succeeded');
    await f.post('/events');
    const [incomplete]=await f.get('/revisions?articleId='+articleId);
    const partial=await f.get(`/read?articleId=${articleId}&revisionId=${incomplete.id}`);
    assert.equal(partial.revision.state,'blocked');
    assert.equal(partial.attachments[0].status,'failed');
    assert.equal(partial.attachments[0].url,null);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,0);

    const second=(await f.post('/capture',{articleId,requestId:'workflow-pending-ocr'})).task.id;
    await f.post('/launch',{taskId:second});
    assert.equal((await f.finished(second)).state,'succeeded');
    await f.post('/events');
    const [candidate]=await f.get('/revisions?articleId='+articleId);
    const pending=await f.get(`/read?articleId=${articleId}&revisionId=${candidate.id}`);
    assert.equal(pending.revision.state,'assembling');
    assert.ok(pending.requirements.some(row=>row.kind==='body_ocr'&&row.state==='pending'));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,0);
    const ocr=await f.db.prepare("SELECT id FROM tasks WHERE kind='ocr'").first();
    assert.ok(ocr,'capture must durably enqueue its independent OCR requirement');
    await f.post('/launch',{taskId:ocr.id});
    assert.equal((await f.finished(ocr.id)).state,'succeeded');
    await f.post('/events');
    const ready=await f.get(`/read?articleId=${articleId}&revisionId=${candidate.id}`);
    assert.equal(ready.revision.state,'ready');
    assert.match(ready.article.bodyText,/归档识别内容/);
    assert.match(ready.article.bodyText,/CQU mixed notice first page/);
    assert.equal(ready.attachments[0].status,'complete');
    await f.post('/launch');
    await f.post('/events');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM content_events').first()).n,1);
    assert.equal(f.ocr.calls,1);
    assert.equal(f.browser.calls.length,2);
  }finally{await f.mf.dispose();}
});

test('native capture hands a ready same-site successor the container and releases the site before archive storage',async()=>{
  let releaseOrigin,releaseStorage;
  const origin=new Promise(resolve=>{releaseOrigin=resolve;});
  const storage=new Promise(resolve=>{releaseStorage=resolve;});
  const fault={stage:'before-commit',remaining:1};
  const f=await fixture({fault,onFault:()=>storage,onScrape:async input=>{
    if(input.url===articleUrl)await origin;
    return notice('并发',{url:input.url});
  }});
  try{
    const secondId='bbbbbbbbbbbbbbbbbbbbbbbb',otherId='cccccccccccccccccccccccc';
    await f.db.prepare("INSERT OR IGNORE INTO sources(id,name,url) VALUES ('intex','国际处','https://intex.cqu.edu.cn/')").run();
    await f.db.prepare("UPDATE sources SET site_id='1922681dab068aba5ab31dd8',config_json=?,list_url='https://intex.cqu.edu.cn/list.htm' WHERE id='intex'")
      .bind(JSON.stringify({articlePattern:'^/info/\\d+/\\d+\\.htm$'})).run();
    for(const [id,sourceId,url] of [[secondId,'jwc','https://jwc.cqu.edu.cn/info/1082/901.htm'],[otherId,'intex','https://intex.cqu.edu.cn/info/1082/902.htm']]){
      await f.db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at) VALUES (?,?,?,'并发通知','2026-11-04',?)")
        .bind(id,sourceId,url,new Date().toISOString()).run();
    }
    const first=(await f.post('/capture',{articleId,requestId:'workflow-handoff-first'})).task.id;
    const second=(await f.post('/capture',{articleId:secondId,requestId:'workflow-handoff-second'})).task.id;
    const other=(await f.post('/capture',{articleId:otherId,requestId:'workflow-handoff-other'})).task.id;
    fault.taskId=first;
    await f.post('/launch',{taskId:first});
    await until(()=>f.browser.calls.some(call=>call.url===articleUrl));
    await f.post('/launch',{taskId:other});
    assert.equal((await f.finished(other)).state,'succeeded','another site must finish while the first origin is held');
    releaseOrigin();
    await until(()=>f.faults.length===1);
    const firstJob=f.browser.calls.find(call=>call.url===articleUrl);
    assert.equal(f.browser.completions.find(call=>call.jobId===firstJob.jobId).stop,false,'ready same-site work must reuse the browser');
    await f.post('/launch',{taskId:second});
    assert.equal((await f.finished(second)).state,'succeeded','same-site successor must finish while earlier archive storage is held');
    const lastJob=f.browser.calls.find(call=>call.url.endsWith('/901.htm'));
    assert.equal(f.browser.completions.find(call=>call.jobId===lastJob.jobId).stop,true,'idle site must request container shutdown');
    assert.equal(f.browser.maxPerSite,1);
    releaseStorage();
    assert.equal((await f.finished(first)).state,'succeeded');
    assert.equal(f.browser.calls.length,3);
  }finally{releaseOrigin();releaseStorage();await f.mf.dispose();}
});

async function until(check){
  for(let n=0;n<300;n++){
    if(await check())return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Expected Workflow boundary was not reached');
}

function notice(variant,{missingAttachment=false,bodyPdf=false,url=articleUrl}={}){
  const html='<html><body><main>归档正文'+variant+'</main></body></html>';
  const encoded=value=>Buffer.from(value).toString('base64');
  const page={bodyRecognized:true,page:{url},bodyText:'归档正文'+variant,errors:[],
    artifacts:[{name:'snapshot.html',base64:encoded(html),contentType:'text/html'},{name:'offline.html',base64:encoded(html),contentType:'text/html'}],
    attachmentCandidates:[],downloads:[]};
  if(missingAttachment||bodyPdf){
    page.attachmentCandidates=[{url:'https://jwc.cqu.edu.cn/document.pdf',name:'正文.pdf',role:bodyPdf?'body-pdf':'attachment'}];
  }
  if(bodyPdf){
    page.artifacts.push({name:'attachment-1.pdf',base64:encoded(mixedPdf()),contentType:'application/pdf'});
    page.downloads=[{url:'https://jwc.cqu.edu.cn/document.pdf',originalFile:true,role:'body-pdf',kind:'pdf',
      saved:{name:'attachment-1.pdf'},fetchedAt:new Date().toISOString()}];
  }
  return {success:true,data:{markdown:page.bodyText,rawHtml:html,metadata:{statusCode:200},actions:{javascriptReturns:[{value:JSON.stringify(page)}]}}};
}

async function fixture({responses=[],fault,onFault,onScrape,seedArticle=true}={}){
  const ocr={calls:0},waits=[],faults=[],browser={calls:[],completions:[],active:new Map(),maxPerSite:0};
  let db;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    workflows:{CAPTURE:{name:'test-capture',className:'TestCaptureWorkflow'},DISCOVERY:{name:'test-discovery',className:'TestDiscoveryWorkflow'},ARCHIVE_OCR:{name:'test-archive-ocr',className:'TestArchiveOcrWorkflow'}},
    bindings:{BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge',CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',
      COLLECTION_EXECUTOR:'workflow',ARCHIVE_VERSIONS_ENABLED:'true',ARCHIVE_READS_ENABLED:'true',SOURCE_MANAGEMENT_ENABLED:'true',
      PDF_OCR_ENABLED:'true',PDF_OCR_MODEL:'mistral-ocr-4-1',MISTRAL_API_KEY:'test-mistral',
      MAX_TASK_ATTEMPTS:'3',TASK_RETRY_BASE_DELAY_MS:'60000'},
    serviceBindings:{TEST_OCR:async request=>{
      assert.equal(request.url,'https://api.mistral.ai/v1/ocr');
      const body=await request.json();ocr.calls++;
      assert.deepEqual(body.pages,[1]);
      return Response.json({model:'mistral-ocr-4-1',pages:[{index:1,markdown:'归档识别内容',tables:[]}],usage_info:{pages_processed:1,doc_size_bytes:mixedPdf().length}});
    },TEST_FAULT:async request=>{
      const signal=await request.json();
      const fail=fault?.stage===signal.stage&&fault.remaining>0&&(!fault.taskId||signal.taskId===fault.taskId)&&browser.calls.length>=(fault.afterCalls??0);
      if(fail){
        fault.remaining--;
        const {n:siteOwners}=await db.prepare('SELECT COUNT(*) AS n FROM site_execution_leases WHERE owner_task_id IS NOT NULL').first();
        faults.push({...signal,siteOwners});
        await onFault?.();
      }
      return Response.json({fail});
    },TEST_WAIT:async request=>{const wait=await request.json();
        wait.siteOwners=(await db.prepare('SELECT COUNT(*) AS n FROM site_execution_leases WHERE owner_task_id IS NOT NULL').first()).n;
        waits.push(wait);return new Response('ok');},
      TEST_BROWSER:async request=>{
        const input=await request.json();
        if(new URL(request.url).pathname==='/scrape-complete'){browser.completions.push(input);return Response.json({ok:true});}
        browser.calls.push(input);
        const active=(browser.active.get(input.siteId)??0)+1;
        browser.active.set(input.siteId,active);browser.maxPerSite=Math.max(browser.maxPerSite,active);
        let response;
        try{response=onScrape?await onScrape(input):responses[Math.min(browser.calls.length-1,responses.length-1)];}
        finally{browser.active.set(input.siteId,active-1);}
        if(response.capacity)return new Response('Container capacity busy',{status:503});
        if(response.disconnect)throw new TypeError('network connection disconnected');
        return Response.json(response,{headers:{'x-feed-browser-job-id':request.headers.get('x-feed-browser-job-id')}});
      }},
  }));
  db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()){
    const sql=await readFile('migrations/'+name,'utf8');
    for(const statement of sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|INSERT|UPDATE|$)/).map(s=>s.trim()).filter(s=>s&&!/^PRAGMA\b/.test(s)))await db.prepare(statement).run();
  }
  await db.prepare("UPDATE sources SET enabled=0").run();
  await db.prepare("INSERT OR IGNORE INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
  await db.prepare("UPDATE sources SET enabled=1,site_id='7fd03676e5751e9b6dd95ecb',list_url='https://jwc.cqu.edu.cn/list.htm',config_json=?,next_discovery_at=? WHERE id='jwc'")
    .bind(JSON.stringify({articlePattern:'^/info/\\d+/\\d+\\.htm$'}),Date.now()+86400_000).run();
  if(seedArticle)await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at) VALUES (?,'jwc',?,'归档通知','2026-11-04',?)")
    .bind(articleId,articleUrl,new Date().toISOString()).run();
  const invoke=async(path,body)=>{
    const response=await mf.dispatchFetch('https://feed.test'+path,body?{method:'POST',body:JSON.stringify(body)}:{});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  let due=0;
  return {mf,db,browser,waits,faults,ocr,get:path=>invoke(path),post:(path,body={})=>invoke(path,body),
    async recheck(){
      await db.prepare('UPDATE articles SET next_recheck_at=? WHERE id=?').bind(++due,articleId).run();
      const result=await invoke('/recheck',{});
      assert.equal(result.scheduled.length,1,JSON.stringify(result));
      return result.scheduled[0];
    },
    async finished(id){
      let status;
      for(let n=0;n<300;n++){
        status=await invoke('/status?id='+id);
        if(!['queued','starting','running'].includes(status.state))return status;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail('Workflow did not finish: '+JSON.stringify(status));
    }};
}
