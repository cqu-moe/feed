import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

import {oauthProvider,login} from './helpers/oauth-provider.mjs';

const sharedArticleUrl='https://a.test/info/2026/1.htm';

const workersPlugin={
  name:'sources-workers-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'sources-workers-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'sources-workers-stub'},()=>({
      loader:'js',contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

const firecrawlPlugin={
  name:'sources-firecrawl-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/\.\/firecrawl\.mjs$/},()=>({path:'firecrawl',namespace:'sources-firecrawl-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'sources-firecrawl-stub'},()=>({
      loader:'js',
      contents:`
        const calls=[];
        globalThis.SOURCES_SCRAPES=calls;
        globalThis.SOURCES_FAIL_LIST='';
        globalThis.SOURCES_EXTRA_DATES=false;
        globalThis.SOURCES_FAULT_NEXT_LIST_COMMIT=false;
        globalThis.SOURCES_FAIL_BATCH=false;
        globalThis.SOURCES_FAIL_BEFORE_BATCH=false;
        globalThis.SOURCES_FAULT_BEFORE_COMMIT=false;
        const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
        const list=(url,page)=>{
          const origin=new URL(url).origin;
          return {
            title:'通知列表',
            articles:[{url:sharedArticleUrl,title:'共享通知',publishedAt:null},...(globalThis.SOURCES_EXTRA_DATES?[{url:origin+'/info/2026/2.htm',title:'共享通知',publishedAt:'2026-10-12 09:30'},{url:origin+'/info/2026/3.htm',title:'日级通知',publishedAt:'2026-10-12'}]:[])],
            next:page===1?[url.replace(/\\.htm$/,'-2.htm')]:[],
          };
        };
        const body=(url)=>{
          const snapshot='<html><body><main><h1>共享通知</h1><p>多来源样本正文</p></main></body></html>';
          const pdf='%PDF-1.7\\n样本附件';
          return {
            bodyRecognized:true,page:{url},bodyText:'多来源样本正文'.repeat(20),errors:[],
            attachmentCandidates:[{url:url+'/file.pdf',name:'样本附件.pdf',role:'attachment'}],
            downloads:[{url:url+'/file.pdf',originalFile:true,saved:{name:'attachment-1.pdf',bytes:pdf.length,uploaded:false}}],
            artifacts:[
              {name:'attachment-1.pdf',base64:base64(pdf),contentType:'application/pdf'},
              {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
              {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
            ],
            bridge:{opened:true,ready:true,closed:true},
          };
        };
        export async function scrape(_env,url){
          calls.push(url);
          await _env.TEST_GATE.fetch('https://gate.test/?url='+encodeURIComponent(url));
          if(globalThis.SOURCES_FAIL_LIST&&url===globalThis.SOURCES_FAIL_LIST){
            throw new Error('Firecrawl HTTP 429: rate limit exceeded');
          }
          const path=new URL(url).pathname;
          const page=/\\/list(?:-[ab])?(?:-2)?\\.htm$/.test(path)?(path.includes('-2')?2:1):0;
          const value=page?list(url,page):body(url);
          if(page&&globalThis.SOURCES_FAULT_BEFORE_COMMIT){globalThis.SOURCES_FAULT_BEFORE_COMMIT=false;globalThis.SOURCES_FAIL_BEFORE_BATCH=true;}
          if(page&&globalThis.SOURCES_FAULT_NEXT_LIST_COMMIT){
            globalThis.SOURCES_FAULT_NEXT_LIST_COMMIT=false;
            globalThis.SOURCES_FAIL_BATCH=true;
          }
          return {
            markdown:'多来源样本正文',rawHtml:'<html></html>',
            metadata:{statusCode:200,creditsUsed:1,proxyUsed:true},
            actions:{javascriptReturns:[{value:JSON.stringify(value)}]},
          };
        }
      `.replace(/sharedArticleUrl/g,JSON.stringify(sharedArticleUrl)),
    }));
  },
};

async function fixture({versioned=false,notifications=false}={}){
  const bundle=await build({
    stdin:{
      contents:`
        import worker from './worker/index.mjs';
        import {createSources} from './worker/sources.mjs';
        import {createTaskRuntime,handleFeedJobs} from './worker/task-runtime.mjs';
        import {createNotifications} from './worker/notifications.mjs';
        import {CaptureWorkflow} from './worker/capture-workflow.mjs';
        import {DiscoveryWorkflow} from './worker/discovery-workflow.mjs';
        import {issueGrant} from './worker/bridge.mjs';

        globalThis.SOURCES_WORKFLOW_CALLS=[];
        globalThis.SOURCES_WORKFLOW_MODE='run';
        globalThis.SOURCES_ACTIVE_WORKFLOWS=[];
        const step={async do(_name,_options,fn){return (typeof _options==='function'?_options:fn)();},async sleep(){}};
        const instances=new Map();
        let clockOffset=0;
        const runtimeNow=()=>Date.now()+clockOffset;
        const notificationsEnabled=${notifications};
        const instance=id=>{
          if(!instances.has(id))throw new Error('Workflow instance not found');
          return {id,status:async()=>({status:instances.get(id).status,error:instances.get(id).error})};
        };
        const workflow={
          async create({id,params}){
            globalThis.SOURCES_WORKFLOW_CALLS.push({op:'create',id});
            if(instances.has(id))throw new Error('Workflow instance already exists');
            if(globalThis.SOURCES_WORKFLOW_MODE==='platform'){
              instances.set(id,{status:'running',error:null});
              return instance(id);
            }
            const task=await globalThis.SOURCES_ENV.DB.prepare('SELECT kind FROM tasks WHERE id=?').bind(params.taskId).first();
            const Workflow=task?.kind==='discover'?DiscoveryWorkflow:CaptureWorkflow;
            const execution=new Workflow(globalThis.SOURCES_ENV).run({instanceId:id,payload:params},step);
            instances.set(id,{status:'running',error:null,execution});
            globalThis.SOURCES_ACTIVE_WORKFLOWS.push(execution);
            execution.then(()=>{instances.get(id).status='complete';})
              .catch(error=>{instances.get(id).status='errored';instances.get(id).error=error;});
            return instance(id);
          },
          async get(id){
            globalThis.SOURCES_WORKFLOW_CALLS.push({op:'get',id});
            return instance(id);
          },
        };
        function prepareEnv(rawEnv){
          const actualQueue=rawEnv.FEED_JOBS;
          const database=rawEnv.DB;
          const env={...rawEnv,DB:{prepare:sql=>database.prepare(sql),async batch(statements){
            if(globalThis.SOURCES_FAIL_BEFORE_BATCH){globalThis.SOURCES_FAIL_BEFORE_BATCH=false;throw new Error('Injected D1 unavailable before commit');}
            const result=await database.batch(statements);
            if(globalThis.SOURCES_FAIL_BATCH){globalThis.SOURCES_FAIL_BATCH=false;throw new Error('Injected lost D1 commit response');}
            return result;
          }},CAPTURE:workflow,DISCOVERY:workflow,FEED_JOBS:{
            async send(body,options){return await actualQueue.send(body,options);},
          }};
          globalThis.SOURCES_ENV=env;
          return env;
        }
        export default {
          async fetch(request,rawEnv){
            const env=prepareEnv(rawEnv),url=new URL(request.url);
            if(url.pathname==='/fixture/extra-dates'){globalThis.SOURCES_EXTRA_DATES=true;return Response.json({ok:true});}
            if(url.pathname==='/fixture/recover'){
              clockOffset=3600000;
              return Response.json(await createTaskRuntime(env,{now:runtimeNow}).recover());
            }
            if(url.pathname==='/fixture/fault-before-commit'){
              globalThis.SOURCES_FAULT_BEFORE_COMMIT=true;return Response.json({armed:true});
            }
            if(url.pathname==='/fixture/fault-commit'){
              globalThis.SOURCES_FAULT_NEXT_LIST_COMMIT=true;
              return Response.json({armed:true});
            }
            if(url.pathname==='/fixture/fail-list'){
              if(request.method==='POST')globalThis.SOURCES_FAIL_LIST=(await request.json()).listUrl??'';
              return Response.json({listUrl:globalThis.SOURCES_FAIL_LIST});
            }
            if(url.pathname==='/fixture/scrapes')return Response.json({calls:globalThis.SOURCES_SCRAPES});
            if(url.pathname==='/fixture/workflows')return Response.json({calls:globalThis.SOURCES_WORKFLOW_CALLS});
            if(url.pathname==='/fixture/grant'){
              const source=await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(url.searchParams.get('sourceId')).first();
              if(!source)return Response.json({error:'missing source'},404);
              return Response.json(await issueGrant(env,{id:source.id,url:source.url},crypto.randomUUID(),'000000000000000000000000'));
            }
            if(url.pathname==='/fixture/advance-schedule'){
              const {advanceMs}=await request.json();
              clockOffset=advanceMs;
              const result=await createSources(env,{now:runtimeNow}).scheduleDue();
              await createTaskRuntime(env,{now:runtimeNow}).dispatchDueOutbox();
              return Response.json(result);
            }
            if(notificationsEnabled&&url.pathname==='/fixture/drain-matches'){
              return Response.json(await createNotifications(env,{now:runtimeNow}).drainDue(100));
            }
            return worker.fetch(request,env);
          },
          async queue(batch,rawEnv){
            const env=prepareEnv(rawEnv);
            const messages=batch.messages.map(message=>message.body);
            if(messages.some(payload=>payload?.type==='match-source'||payload?.type==='event-ready')){
              const notifications=createNotifications(env,{now:runtimeNow});
              for(const payload of messages){
                if(payload.type==='match-source')await notifications.processMatchTask(payload);
                else if(payload.type==='event-ready')await notifications.enqueueEvent(payload.eventId);
              }
            }else{
              await handleFeedJobs(batch,env,{workflow,now:runtimeNow});
            }
            await Promise.allSettled(globalThis.SOURCES_ACTIVE_WORKFLOWS.splice(0));
          },
        }
      `,
      resolveDir:process.cwd(),
      sourcefile:'sources-fixture.mjs',
    },
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','node:*'],
    plugins:[workersPlugin,firecrawlPlugin],
  });
  const provider=oauthProvider();
  const gate={url:null,held:false,release:null};
  const policyScript=`
    import {WorkerEntrypoint} from 'cloudflare:workers';
    export class AuthService extends WorkerEntrypoint{
      async getFeedPolicy(request){
        if(request.contractVersion!==1||request.clientId!=='feed-rpc-client'||request.clientSecret!=='feed-rpc-secret')
          return {ok:false,code:'CLIENT_NOT_ALLOWED',retryable:false,requestId:'test'};
        return {ok:true,contractVersion:1,checkedAt:Date.now(),data:
          {access:true,subscriptionLimit:{kind:'limited',value:10}}};
      }
      async getFeedRecipient(request){
        if(request.contractVersion!==1||request.clientId!=='feed-rpc-client'||request.clientSecret!=='feed-rpc-secret')
          return {ok:false,code:'CLIENT_NOT_ALLOWED',retryable:false,requestId:'test'};
        return {ok:true,contractVersion:1,checkedAt:Date.now(),data:{
          policy:{access:true,subscriptionLimit:{kind:'limited',value:10}},
          recipient:{status:'verified',email:'reader@example.test'},
        }};
      }
    }
    export default{async fetch(){return new Response('Not found',{status:404});}};
  `;
  const feedServiceBindings={AUTH:request=>provider.fetch(request),TEST_GATE:request=>{
    if(new URL(request.url).searchParams.get('url')!==gate.url)return new Response('ready');
    gate.held=true;
    return new Promise(resolve=>{gate.release=()=>{gate.url=null;gate.held=false;resolve(new Response('ready'));};});
  }};
  if(notifications)feedServiceBindings.AUTH_FEED_RPC={name:'policy',entrypoint:'AuthService'};
  const workers=[{
    name:'feed',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
    serviceBindings:feedServiceBindings,
    bindings:{...provider.bindings,ADMIN_TOKEN:'test-admin-token',BASE_URL:'https://feed.test',BRIDGE_SECRET:'test-bridge-secret',
      FEED_AUTH_RPC_CLIENT_ID:'feed-rpc-client',FEED_AUTH_RPC_CLIENT_SECRET:'feed-rpc-secret',
      ARCHIVE_VERSIONS_ENABLED:String(versioned),ARCHIVE_READS_ENABLED:String(versioned),SOURCE_MANAGEMENT_ENABLED:'true',CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',PDF_OCR_ENABLED:'false',MAX_DISCOVERY_PAGES_PER_RUN:'2'},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    queueProducers:{FEED_JOBS:{queueName:'feed-jobs'},FEED_EVENTS:{queueName:'feed-events'}},
    queueConsumers:{'feed-jobs':{maxBatchSize:1,maxRetries:3,deadLetterQueue:'feed-jobs-dlq'},'feed-events':{maxBatchSize:1,maxRetries:3,deadLetterQueue:'feed-events-dlq'}},
  }];
  if(notifications)workers.push({
    name:'policy',modules:true,script:policyScript,compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({workers}));
  const db=await mf.getD1Database('DB');
  const migrationNames=['0001_feed.sql','0002_auth.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql'];
  for(const name of migrationNames){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await applyMigration(db,await readFile('migrations/0009_subscriptions.sql','utf8'));
  await db.prepare('DELETE FROM sources').run();
  for(const name of ['0010_subscription_editing.sql','0013_notification_matching.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  return {mf,db,provider,gate,read:async path=>mf.dispatchFetch('https://feed.test'+path,{headers:{Cookie:await login(mf,provider)}})};
}

test('admin verifies a saved source asynchronously before enabling it; duplicate requests reuse the task',async()=>{
  const {mf}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'样本站点',origin:'https://a.test'}});
    const saved=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(site.data.site.id,'https://a.test/list.htm')});
    assert.equal(saved.status,201,JSON.stringify(saved));
    const id=saved.data.source.id;
    const duplicateSave=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(site.data.site.id,'https://a.test/list.htm')});
    assert.equal(duplicateSave.status,201);
    assert.equal(duplicateSave.data.source.id,id);
    assert.equal((await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{enabled:true}})).status,409);
    const verified=await verify(mf,id,'validation-first-request');
    const duplicate=await request(mf,`/internal/sources/${id}/verify`,{method:'POST',body:{requestId:'validation-first-request'}});
    assert.equal(duplicate.status,202);
    assert.equal(duplicate.data.task.id,verified.task.id);
    const current=(await request(mf,`/internal/sources/${id}`)).data.source;
    assert.equal(current.enabled,false);
    assert.equal(current.validationState,'verified');
    assert.equal(current.validationJson.listPages,2);
    for(const key of ['paginationVerified','articleBody','attachmentSample','snapshotSample'])assert.equal(current.validationJson[key],true);
    const scrapes=await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json();
    assert.deepEqual(scrapes.calls,['https://a.test/list.htm','https://a.test/list-2.htm',sharedArticleUrl]);
    assert.equal((await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{enabled:true}})).status,200);
    const grant=await(await mf.dispatchFetch(`https://feed.test/fixture/grant?sourceId=${id}`)).json();
    const bridge=await mf.dispatchFetch(`https://feed.test/internal/bridge?grant=${encodeURIComponent(grant.token)}`);
    assert.equal(bridge.status,200);
    assert.match(await bridge.text(),/Temporary OCR bridge/);
    const renamed=await request(mf,`/internal/sites/${site.data.site.id}`,{method:'PATCH',body:{name:'改名站点'}});
    assert.equal(renamed.data.site.name,'改名站点');
  }finally{await mf.dispose();}
});

test('sites sharing an origin keep separate identities and retries do not rename an existing site',async()=>{
  const {mf}=await fixture();
  try{
    const command={name:'教务公告站',origin:'https://a.test',requestId:'site-create-intent-one'};
    const first=await request(mf,'/internal/sites',{method:'POST',body:command});
    const replay=await request(mf,'/internal/sites',{method:'POST',body:command});
    assert.equal(replay.status,201);
    assert.equal(replay.data.site.id,first.data.site.id);
    const second=await request(mf,'/internal/sites',{method:'POST',body:{name:'竞赛事务站',origin:'https://a.test',requestId:'site-create-intent-two'}});
    assert.equal(second.status,201);
    assert.notEqual(second.data.site.id,first.data.site.id);
    const firstSource=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(first.data.site.id,'https://a.test/list.htm')});
    const secondSource=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(second.data.site.id,'https://a.test/list.htm')});
    assert.equal(firstSource.status,201);assert.equal(secondSource.status,201);
    assert.notEqual(firstSource.data.source.id,secondSource.data.source.id);
    const conflict=await request(mf,'/internal/sites',{method:'POST',body:{...command,name:'冲突名称'}});
    assert.equal(conflict.status,409);
    await request(mf,`/internal/sites/${first.data.site.id}`,{method:'PATCH',body:{name:'管理员改名'}});
    const replayAfterEdit=await request(mf,'/internal/sites',{method:'POST',body:command});
    assert.equal(replayAfterEdit.status,201);
    assert.equal(replayAfterEdit.data.site.name,'管理员改名');
    const sites=(await request(mf,'/internal/sites')).data.sites.filter(site=>site.origin==='https://a.test');
    assert.deepEqual(sites.map(site=>site.name).sort(),['管理员改名','竞赛事务站'].sort());
  }finally{await mf.dispose();}
});

test('two discovered columns share one notification and capture while all finite pages finish and both filters find it',async()=>{
  const {mf,read,provider}=await fixture({versioned:true});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'多栏目站点',origin:'https://a.test'}});
    const a=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
    const b=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-b.htm');
    const scheduled=await request(mf,'/internal/sources/schedule',{method:'POST'});
    assert.equal(scheduled.status,202);
    assert.equal(scheduled.data.scheduled.length,2);
    await waitFor(async()=>{
      const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks;
      assert.equal(tasks.filter(task=>task.kind==='discover').length,6);
      assert.ok(tasks.every(task=>task.state==='succeeded'),JSON.stringify(tasks));
      assert.equal(tasks.filter(task=>task.kind==='capture').length,1);
    });
    await waitFor(async()=>{
      const result=await (await read(`/api/articles?source=${a}`)).json();
      assert.equal(result.total,1);
    });
    let identity;
    for(const id of [a,b]){
      const response=await read(`/api/articles?source=${id}`);
      assert.equal(response.status,200,await response.clone().text());
      const reading=await response.json();
      assert.equal(reading.total,1);
      const article=reading.articles[0];
      assert.equal(article.url,sharedArticleUrl);
      assert.equal(article.publishedAt,null);
      identity??=article.id;
      assert.equal(article.id,identity);
    }
    const sources=(await request(mf,'/internal/sources')).data.sources;
    assert.equal(sources.find(source=>source.id===a).articleCount,1);
    assert.equal(sources.find(source=>source.id===b).articleCount,1);
    assert.equal((await mf.dispatchFetch('https://feed.test/api/articles')).status,401);
    provider.setAccess(false);
    assert.equal((await read('/api/articles')).status,403);
  }finally{await mf.dispose();}
});

test('a later column association fans out an already ready shared event',async()=>{
  const {mf,provider}=await fixture({versioned:true,notifications:true});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'晚到关联站点',origin:'https://a.test'}});
    const first=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
    await request(mf,'/internal/sources/schedule',{method:'POST'});
    let eventId;
    await waitFor(async()=>{
      const events=(await request(mf,'/internal/notification-events')).data.events;
      assert.equal(events.length,1,JSON.stringify(events));
      eventId=events[0].id;
    });

    const second=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-b.htm');
    const cookie=await login(mf,provider);
    const created=await userRequest(mf,cookie,'/api/subscriptions',{
      method:'POST',
      body:{requestId:'late-column-subscription',name:'晚到栏目',siteIds:[],sourceIds:[second],emailMode:'immediate'},
    });
    assert.equal(created.status,201,JSON.stringify(created));
    await request(mf,'/internal/sources/schedule',{method:'POST'});
    await waitFor(async()=>{
      assert.equal((await request(mf,`/internal/sources/${second}/discoveries`)).data.discoveries.length,1);
    });

    const before=(await request(mf,`/internal/notification-events/${eventId}`)).data;
    assert.deepEqual(before.sources.map(source=>source.sourceId).sort(),[first,second].sort());
    assert.equal(before.matchTasks.length,2);
    const verified=await request(mf,`/internal/notification-events/${eventId}/date-verification`,{
      method:'POST',
      body:{requestId:'late-column-date-verification',sourceId:second,verifiedBy:'feed-admin',
        datePrecision:'minute',publishedAt:new Date(Date.now()+60_000).toISOString(),evidence:{method:'source-page'}},
    });
    assert.equal(verified.status,202,JSON.stringify(verified));
    const drained=await(await mf.dispatchFetch('https://feed.test/fixture/drain-matches')).json();
    assert.equal(drained.pendingPages,0,JSON.stringify(drained));

    const detail=await userRequest(mf,cookie,`/api/subscriptions/${created.data.subscription.id}`);
    assert.equal(detail.status,200,JSON.stringify(detail));
    assert.deepEqual(detail.data.subscription.notificationMatches.map(match=>[match.eventId,match.status]),
      [[eventId,'pending_immediate']]);
    const after=(await request(mf,`/internal/notification-events/${eventId}`)).data;
    assert.equal(after.sources.find(source=>source.sourceId===second).datePrecision,'minute');
    assert.equal(after.delivery.kind,'immediate');
  }finally{await mf.dispose();}
});

test('rate limiting defers only the failing source and pausing a source stops scheduling without hiding its saved notices',async()=>{
  const {mf,read}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'独立失败站点',origin:'https://a.test'}});
    const a=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
    const b=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-b.htm');
    await request(mf,'/internal/sources/schedule',{method:'POST'});
    await waitFor(async()=>{
      const sources=(await request(mf,'/internal/sources')).data.sources;
      assert.equal(sources.find(source=>source.id===a).articleCount,1);
      assert.equal(sources.find(source=>source.id===b).articleCount,1);
      const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks;
      assert.equal(tasks.length,7);
      assert.ok(tasks.every(task=>task.state==='succeeded'));
    });
    await mf.dispatchFetch('https://feed.test/fixture/fail-list',{method:'POST',body:JSON.stringify({listUrl:'https://a.test/list-b.htm'})});
    const paused=await request(mf,`/internal/sources/${a}`,{method:'PATCH',body:{enabled:false}});
    assert.equal(paused.status,200);
    const scheduled=await(await mf.dispatchFetch('https://feed.test/fixture/advance-schedule',{method:'POST',body:JSON.stringify({advanceMs:1800001})})).json();
    assert.equal(scheduled.scheduled.length,1);
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${scheduled.scheduled[0]}`)).data.task;
      assert.equal(task.state,'deferred');
      assert.match(task.lastError,/429|rate limit/i);
    });
    assert.equal((await request(mf,`/internal/sources/${b}`,{method:'PATCH',body:{enabled:false}})).status,200);
    const stopped=await(await mf.dispatchFetch('https://feed.test/fixture/advance-schedule',{method:'POST',body:JSON.stringify({advanceMs:3600001})})).json();
    assert.equal(stopped.scheduled.length,0);
    assert.equal((await(await read(`/api/articles?source=${b}`)).json()).total,1);
  }finally{await mf.dispose();}
});

test('a result from an old configuration cannot verify an edited source',async()=>{
  const {mf,gate}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'配置竞态站点',origin:'https://a.test'}});
    const saved=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(site.data.site.id,'https://a.test/list.htm')});
    const id=saved.data.source.id;
    gate.url='https://a.test/list.htm';
    const pending=await request(mf,`/internal/sources/${id}/verify`,{method:'POST',body:{requestId:'old-config-check'}});
    assert.equal(pending.status,202);
    await waitFor(async()=>assert.equal(gate.held,true));
    const changed=await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{listUrl:'https://a.test/list-b.htm'}});
    assert.equal(changed.status,200);
    assert.equal(changed.data.source.configVersion,2);
    gate.release();
    await waitFor(async()=>{const task=(await request(mf,`/internal/capture-tasks/${pending.data.task.id}`)).data.task;assert.equal(task.state,'succeeded',JSON.stringify(task));});
    const current=(await request(mf,`/internal/sources/${id}`)).data.source;
    assert.equal(current.validationState,'draft');
    assert.equal(current.validationJson,null);
    assert.equal((await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{enabled:true}})).status,409);
    await verify(mf,id,'new-config-check');
    assert.equal((await request(mf,`/internal/sources/${id}`)).data.source.validationState,'verified');
  }finally{gate.release?.();await mf.dispose();}
});

test('a lost discovery commit response resumes the saved continuation without charging for the first page again',async()=>{
  const {mf,read}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'恢复站点',origin:'https://a.test'}});
    const id=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list.htm');
    await mf.dispatchFetch('https://feed.test/fixture/fault-commit',{method:'POST'});
    const scheduled=await request(mf,'/internal/sources/schedule',{method:'POST'});
    await waitFor(async()=>assert.equal((await request(mf,`/internal/capture-tasks/${scheduled.data.scheduled[0]}`)).data.task.state,'succeeded'));
    await request(mf,'/internal/capture-tasks/recover',{method:'POST'});
    await waitFor(async()=>{
      const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks;
      assert.equal(tasks.length,4);
      assert.ok(tasks.every(task=>task.state==='succeeded'),JSON.stringify(tasks));
    });
    const scrapes=(await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls;
    assert.equal(scrapes.filter(url=>url==='https://a.test/list.htm').length,2); // one validation + one discovery
    assert.equal(scrapes.filter(url=>url==='https://a.test/list-2.htm').length,2);
    assert.equal((await(await read(`/api/articles?source=${id}`)).json()).total,1);
  }finally{await mf.dispose();}
});

test('a saved list survives D1 failure before commit and retries without fetching that paid page again',async()=>{
  const {mf,read}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'持久列表',origin:'https://a.test'}});
    const id=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list.htm');
    await mf.dispatchFetch('https://feed.test/fixture/fault-before-commit',{method:'POST'});
    const scheduled=await request(mf,'/internal/sources/schedule',{method:'POST'});
    const taskId=scheduled.data.scheduled[0];
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${taskId}`)).data.task;
      assert.equal(task.state,'deferred',JSON.stringify(task));
    });
    assert.equal((await request(mf,`/internal/sources/${id}/discoveries`)).data.discoveries.length,0);
    await mf.dispatchFetch('https://feed.test/fixture/recover',{method:'POST'});
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${taskId}`)).data.task;
      assert.equal(task.state,'succeeded',JSON.stringify(task));
      assert.equal(task.attemptNo,2);
    });
    const scrapes=(await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls;
    assert.equal(scrapes.filter(url=>url==='https://a.test/list.htm').length,2); // sample check + original discovery, never retry scrape
    assert.equal((await(await read(`/api/articles?source=${id}`)).json()).total,1);
  }finally{await mf.dispose();}
});

test('discovery preserves unknown, day and source-local minute precision; different URLs do not merge',async()=>{
  const {mf,read}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'日期证据',origin:'https://a.test'}});
    const saved=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(site.data.site.id,'https://a.test/list.htm')});
    const id=saved.data.source.id;
    await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{baselineCutoffAt:'2026-10-12'}});
    await verify(mf,id,'verify-dates');
    await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{enabled:true}});
    await mf.dispatchFetch('https://feed.test/fixture/extra-dates',{method:'POST'});
    await request(mf,'/internal/sources/schedule',{method:'POST'});
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${id}/discoveries`)).data.discoveries.length,3));
    const observations=(await request(mf,`/internal/sources/${id}/discoveries`)).data.discoveries;
    assert.deepEqual(observations.map(row=>[row.datePrecision,row.publishedDay,row.publishedAt]).sort(),[
      ['day','2026-10-12',null],['minute','2026-10-12','2026-10-12T01:30:00.000Z'],['unknown',null,null],
    ]);
    for(const row of observations){assert.equal(row.timezone,'Asia/Shanghai');assert.equal(row.discoveryClass,'live');assert.ok(row.firstSeenAt>0);assert.ok(row.lastSeenAt>=row.firstSeenAt);}
    const reading=await(await read(`/api/articles?source=${id}`)).json();
    assert.equal(reading.total,3);
    assert.equal(new Set(reading.articles.map(row=>row.id)).size,3);
  }finally{await mf.dispose();}
});

function sourceCommand(siteId,listUrl){
  return {siteId,name:listUrl.includes('list-a')?'栏目 A':'栏目 B',listUrl,
    articlePattern:'^/info/[0-9]+/[0-9]+[.]htm$',refreshIntervalSec:1800,sampleArticleUrl:sharedArticleUrl,timezone:'Asia/Shanghai'};
}
async function createVerifiedSource(mf,siteId,listUrl){
  const saved=await request(mf,'/internal/sources',{method:'POST',body:sourceCommand(siteId,listUrl)});
  assert.equal(saved.status,201,JSON.stringify(saved));
  const id=saved.data.source.id;
  await verify(mf,id,crypto.randomUUID());
  const enabled=await request(mf,`/internal/sources/${id}`,{method:'PATCH',body:{enabled:true}});
  assert.equal(enabled.status,200,JSON.stringify(enabled));
  return id;
}
async function verify(mf,id,requestId){
  const submitted=await request(mf,`/internal/sources/${id}/verify`,{method:'POST',body:{requestId}});
  assert.equal(submitted.status,202,JSON.stringify(submitted));
  await waitFor(async()=>{
    const source=(await request(mf,`/internal/sources/${id}`)).data.source;
    assert.equal(source.validationState,'verified',JSON.stringify(source));
    const task=(await request(mf,`/internal/capture-tasks/${submitted.data.task.id}`)).data.task;
    assert.equal(task.state,'succeeded');
  });
  return submitted.data;
}
async function request(mf,path,{method='GET',body}={}){
  if(path==='/internal/sites'&&method==='POST')body={requestId:crypto.randomUUID(),...body};
  const response=await mf.dispatchFetch('https://feed.test'+path,{
    method,headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
  });
  return {status:response.status,data:await response.json()};
}
async function userRequest(mf,cookie,path,{method='GET',body}={}){
  const response=await mf.dispatchFetch('https://feed.test'+path,{
    method,
    headers:{Cookie:cookie,Origin:'https://feed.test','Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  return {status:response.status,data:await response.json()};
}
async function waitFor(check){
  let lastError;
  for(let i=0;i<160;i++){
    try{return await check();}catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,25));}
  }
  throw lastError;
}

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|CREATE INDEX|INSERT|UPDATE|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}
