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
        globalThis.SOURCES_BACKFILL_DATES=false;
        globalThis.SOURCES_LIST_OPTIONS={};
        globalThis.SOURCES_FAULT_NEXT_LIST_COMMIT=false;
        globalThis.SOURCES_FAIL_BATCH=false;
        globalThis.SOURCES_FAIL_BEFORE_BATCH=false;
        globalThis.SOURCES_FAULT_BEFORE_COMMIT=false;
        const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
        const list=(url,page)=>{
          const origin=new URL(url).origin;
          const articles=[{url:sharedArticleUrl,title:'共享通知',publishedAt:null}];
          if(globalThis.SOURCES_EXTRA_DATES)articles.push(
            {url:origin+'/info/2026/2.htm',title:'共享通知',publishedAt:'2026-10-12 09:30'},
            {url:origin+'/info/2026/3.htm',title:'日级通知',publishedAt:'2026-10-12'},
          );
          if(globalThis.SOURCES_BACKFILL_DATES)articles.push(
            {url:origin+'/info/2025/4.htm',title:'一年外通知',publishedAt:'2025-09-30'},
            {url:origin+'/info/2026/4.htm',title:'一年内通知',publishedAt:'2026-04-01'},
          );
          return {
            title:'通知列表',
            articles:globalThis.SOURCES_LIST_OPTIONS.articles??articles,
            next:globalThis.SOURCES_LIST_OPTIONS.chainPages ? (Number(new URL(url).searchParams.get('page')??1)<globalThis.SOURCES_LIST_OPTIONS.chainPages?[origin+'/list.htm?page='+(Number(new URL(url).searchParams.get('page')??1)+1)]:[]) : page===1?[url.replace(/\\.htm$/,'-2.htm')]:[],
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
            throw new Error(globalThis.SOURCES_LIST_OPTIONS.error??'Firecrawl HTTP 429: rate limit exceeded');
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

async function fixture({versioned=false,notifications=false,discoveryPages=2,env={}}={}){
  const bundle=await build({
    stdin:{
      contents:`
        import worker from './worker/index.mjs';
        import {createSources} from './worker/sources.mjs';
        import {createTaskRuntime,handleFeedJobs} from './worker/task-runtime.mjs';
        import {replayMatchOutbox} from './tests/helpers/notification-replay.mjs';
        import {CaptureWorkflow} from './worker/capture-workflow.mjs';
        import {DiscoveryWorkflow} from './worker/discovery-workflow.mjs';
        import {issueGrant} from './worker/bridge.mjs';

        const nativeNow=Date.now;
        let fixedNow=null;
        Date.now=()=>fixedNow??nativeNow();
        globalThis.SOURCES_WORKFLOW_CALLS=[];
        globalThis.SOURCES_SENT=[];
        globalThis.SOURCES_WORKFLOW_MODE='run';
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
            const Workflow=['discover','backfill'].includes(task?.kind)?DiscoveryWorkflow:CaptureWorkflow;
            const execution=globalThis.SOURCES_ENV.TEST_GATE.fetch('https://gate.test/?url=workflow-'+params.taskId)
              .then(()=>new Workflow(globalThis.SOURCES_ENV).run({instanceId:id,payload:params},step));
            instances.set(id,{status:'running',error:null,execution});
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
          const statementInfo=new WeakMap();
          const wrap=(statement,sql,args=[])=>{
            const wrapped={bind(...values){return wrap(statement.bind(...values),sql,values);},
              first(...values){return statement.first(...values);},all(...values){return statement.all(...values);},
              run(...values){return statement.run(...values);}};
            statementInfo.set(wrapped,{statement,sql,args});return wrapped;
          };
          const env={...rawEnv,DB:{prepare:sql=>wrap(database.prepare(sql),sql),async batch(statements){
            const entries=statements.map(statement=>statementInfo.get(statement));
            const association=entries.find(entry=>entry.sql.includes('INSERT INTO article_sources'));
            const match=entries.some(entry=>entry.sql.includes('INSERT INTO notification_matches'));
            const kind=entries.some(entry=>entry.sql.includes("backfill_state='running',backfill_window_days"))?'start':entries.some(entry=>entry.sql.includes('INSERT INTO content_events'))?'ready':match?'match':association?'association':null;
            if(kind)await rawEnv.TEST_COMMIT_GATE.fetch('https://gate.test/?kind='+kind+'&sourceId='+(association?.args[1]??''));
            if(globalThis.SOURCES_FAIL_BEFORE_BATCH){globalThis.SOURCES_FAIL_BEFORE_BATCH=false;throw new Error('Injected D1 unavailable before commit');}
            const result=await database.batch(entries.map(entry=>entry.statement));
            if(globalThis.SOURCES_FAIL_BATCH){globalThis.SOURCES_FAIL_BATCH=false;throw new Error('Injected lost D1 commit response');}
            return result;
          }},CAPTURE:workflow,DISCOVERY:workflow,FEED_JOBS:{
            async send(body,options){
              const task=await database.prepare('SELECT kind,source_id AS sourceId FROM tasks WHERE id=?').bind(body.taskId??'').first();
              globalThis.SOURCES_SENT.push({...body,...task});return await actualQueue.send(body,options);},
          }};
          globalThis.SOURCES_ENV=env;
          return env;
        }
        export default {
          async fetch(request,rawEnv){
            const env=prepareEnv(rawEnv),url=new URL(request.url);
            if(url.pathname==='/fixture/clock'){fixedNow=(await request.json()).now;return Response.json({now:fixedNow});}
            if(url.pathname==='/fixture/list-options'){globalThis.SOURCES_LIST_OPTIONS=await request.json();return Response.json({ok:true});}
            if(url.pathname==='/fixture/sent')return Response.json(globalThis.SOURCES_SENT);
            if(url.pathname==='/fixture/schedule-only')return Response.json(await createSources(env,{now:runtimeNow}).scheduleDue());
            if(url.pathname==='/fixture/dispatch')return Response.json(await createTaskRuntime(env,{now:runtimeNow}).dispatchDueOutbox((await request.json()).limit));
            if(url.pathname==='/fixture/extra-dates'){globalThis.SOURCES_EXTRA_DATES=true;return Response.json({ok:true});}
            if(url.pathname==='/fixture/backfill-dates'){globalThis.SOURCES_BACKFILL_DATES=true;return Response.json({ok:true});}
            if(url.pathname==='/fixture/recover'){
              clockOffset+=3600000;
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
            if(url.pathname==='/fixture/replay-associations'){
              const {sourceId}=await request.json();
              const rows=await env.DB.prepare("SELECT payload_json FROM outbox WHERE topic='feed-events' AND json_extract(payload_json,'$.type')='source-associated' AND json_extract(payload_json,'$.sourceId')=?").bind(sourceId).all();
              const messages=rows.results.map(row=>({body:JSON.parse(row.payload_json),acked:false,
                ack(){this.acked=true;},retry(){}}));
              await handleFeedJobs({messages},env,{now:runtimeNow});
              return Response.json(messages.map(message=>({acked:message.acked})));
            }
            if(url.pathname==='/fixture/grant'){
              const source=await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(url.searchParams.get('sourceId')).first();
              if(!source)return Response.json({error:'missing source'},404);
              return Response.json(await issueGrant(env,{id:source.id,url:source.url},crypto.randomUUID(),'000000000000000000000000'));
            }
            if(url.pathname==='/fixture/submit-backfill'){
              const command=await request.json();
              return Response.json(await createSources(env,{now:runtimeNow})
                .submitBackfill(command.sourceId,{requestId:command.requestId,windowDays:command.windowDays}));
            }
            if(url.pathname==='/fixture/advance-schedule'){
              const {advanceMs}=await request.json();
              clockOffset=advanceMs;
              const result=await createSources(env,{now:runtimeNow}).scheduleDue();
              await createTaskRuntime(env,{now:runtimeNow}).dispatchDueOutbox();
              return Response.json(result);
            }
            if(notificationsEnabled&&url.pathname==='/fixture/drain-matches'){
              return Response.json(await replayMatchOutbox(env,runtimeNow,100));
            }
            return worker.fetch(request,env);
          },
          async queue(batch,rawEnv){
            const env=prepareEnv(rawEnv);
            await handleFeedJobs(batch,env,{workflow,now:runtimeNow});
            const started=batch.messages.filter(message=>message.body.type==='start-job')
              .map(message=>instances.get('task-'+message.body.taskId+'-a'+message.body.attempt)?.execution)
              .filter(Boolean);
            await Promise.allSettled(started);
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
  const commits={ready:{},association:{},start:{},match:{}};
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
  const feedServiceBindings={AUTH:request=>provider.fetch(request),TEST_COMMIT_GATE:request=>{
    const url=new URL(request.url),hold=commits[url.searchParams.get('kind')];
    if(!hold?.hold||hold.sourceId&&hold.sourceId!==url.searchParams.get('sourceId'))return new Response('ready');
    hold.hold=false;hold.held=true;
    return new Promise(resolve=>{hold.release=()=>{hold.held=false;resolve(new Response('ready'));};});
  },TEST_GATE:request=>{
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
      ARCHIVE_VERSIONS_ENABLED:String(versioned),ARCHIVE_READS_ENABLED:String(versioned),SOURCE_MANAGEMENT_ENABLED:'true',CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',PDF_OCR_ENABLED:'false',MAX_DISCOVERY_PAGES_PER_RUN:String(discoveryPages),
      MAX_LIVE_DISCOVERY_TASKS_PER_RUN:String(env.liveBudget??20),MAX_BACKFILL_TASKS_PER_RUN:String(env.backfillBudget??5),MAX_TASK_ATTEMPTS:String(env.maxAttempts??3),MAX_BACKFILL_PAGES_PER_RUN:String(env.backfillPages??100),DEFAULT_BACKFILL_WINDOW_DAYS:String(env.backfillWindowDays??365),DISCOVERY_ADMISSION_RETENTION_MS:String(env.admissionRetentionMs??7*24*60*60*1000)},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    queueProducers:{FEED_JOBS:{queueName:'feed-jobs'},FEED_EVENTS:{queueName:'feed-events'}},
    queueConsumers:{'feed-jobs':{maxBatchSize:1,maxConcurrency:10,maxRetries:3,deadLetterQueue:'feed-jobs-dlq'},'feed-events':{maxBatchSize:1,maxConcurrency:10,maxRetries:3,deadLetterQueue:'feed-events-dlq'}},
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
  await applyMigration(db,await readFile('migrations/0015_history_backfill.sql','utf8'));
  return {mf,db,provider,gate,commitGate(kind,{arm,release,sourceId}={}){
    if(arm)Object.assign(commits[kind],{hold:true,held:false,sourceId});
    if(release)commits[kind].release?.();
    return {held:commits[kind].held===true};
  },read:async path=>mf.dispatchFetch('https://feed.test'+path,{headers:{Cookie:await login(mf,provider)}})};
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
      assert.ok(tasks.filter(task=>['discover','capture'].includes(task.kind)).every(task=>task.state==='succeeded'),JSON.stringify(tasks));
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

test('backfill stops at its finite page cap with a resumable cursor instead of claiming completion',async()=>{
  const {mf}=await fixture({versioned:true,env:{backfillPages:2,backfillBudget:10}});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'有限分页',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    await control(mf,'list-options',{chainPages:6});
    await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'bounded-pages-run'}});
    await waitFor(async()=>{
      const progress=(await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill;
      assert.equal(progress.state,'paused',JSON.stringify(progress));
      assert.equal(progress.seenPages,2);
      assert.equal(progress.remainingUrls,1);
      assert.match(progress.lastError,/page limit/i);
    });
    assert.equal((await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST'})).status,409);
    const resumed=await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST',body:{maxPages:6}});
    assert.equal(resumed.status,202,JSON.stringify(resumed));
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'completed'));
    assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.processedArticles,1);
  }finally{await mf.dispose();}
});

test('the hard thousand-page ceiling retains evidence without queueing an unreachable continuation',async()=>{
  const {mf,db}=await fixture({versioned:true,env:{backfillPages:1000}});
  const bucket=await mf.getR2Bucket('ARCHIVE');
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'硬上限站点',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    await control(mf,'list-options',{chainPages:1002});
    const submitted=await control(mf,'submit-backfill',{sourceId,requestId:'hard-thousand-page-ceiling'});
    const hardPageUrl='https://a.test/list.htm?page=1000';
    const checkpoint={nextUrls:[hardPageUrl],visited:[]};
    const task=await db.prepare('SELECT payload_json FROM tasks WHERE id=?').bind(submitted.task.id).first();
    const payload=JSON.parse(task.payload_json);
    payload.page=1000;
    payload.checkpoint=checkpoint;
    await db.batch([
      db.prepare('UPDATE tasks SET payload_json=? WHERE id=?').bind(JSON.stringify(payload),submitted.task.id),
      db.prepare(`UPDATE sources SET backfill_seen_pages=999,backfill_max_pages=1000,backfill_cursor=? WHERE id=?`)
        .bind(JSON.stringify(checkpoint),sourceId),
    ]);

    await control(mf,'dispatch',{});
    await waitFor(async()=>{
      const source=(await request(mf,`/internal/sources/${sourceId}`)).data.source;
      assert.equal(source.backfill.state,'paused',JSON.stringify(source.backfill));
      assert.equal(source.backfill.seenPages,1000);
      assert.deepEqual(source.backfillCursor.nextUrls,['https://a.test/list.htm?page=1001']);
      assert.match(source.backfill.lastError,/manual inspection/i);
    });
    assert.ok(await bucket.head(`discovery/${submitted.task.id}/list.json`));
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tasks
      WHERE kind='backfill' AND json_extract(payload_json,'$.page')=1001`).first()).n,0);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM outbox o JOIN tasks t ON t.id=json_extract(o.payload_json,'$.taskId')
      WHERE t.kind='backfill' AND json_extract(t.payload_json,'$.page')=1001`).first()).n,0);
    assert.equal((await control(mf,'scrapes',{})).calls.filter(url=>url===hardPageUrl).length,1);
  }finally{await mf.dispose();}
});

test('terminal history failures remain visible and manual recovery continues the same saved page',async t=>{
  for(const message of ['Provider parser unavailable','Firecrawl HTTP 429: rate limit exceeded','Firecrawl HTTP 402: insufficient credits'])await t.test(message,async()=>{
    const {mf}=await fixture({versioned:true,env:{backfillBudget:20,maxAttempts:2}});
    try{
      const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'失败恢复',origin:'https://a.test'}});
      const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
      await control(mf,'list-options',{error:message});
      await control(mf,'fail-list',{listUrl:'https://a.test/list-2.htm'});
      await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'terminal-recover-run'}});
      let failedTask;
      await waitFor(async()=>{
        const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks;
        failedTask=tasks.find(task=>task.kind==='backfill'&&['failed','blocked','deferred'].includes(task.state));
        assert.ok(failedTask,JSON.stringify(tasks));
      });
      if(message.includes('429')){
        assert.equal(failedTask.state,'deferred');
        await control(mf,'recover',{});
      }
      await waitFor(async()=>{
        const source=(await request(mf,`/internal/sources/${sourceId}`)).data.source;
        assert.equal(source.backfill.state,'failed',JSON.stringify(source.backfill));
        assert.match(source.backfill.lastError,new RegExp(message.includes('429')?'429':message.includes('402')?'402':'parser'));
        assert.equal(source.backfill.seenPages,1);
      });
      const before=(await control(mf,'scrapes',{})).calls.length;
      await control(mf,'recover',{});
      await control(mf,'dispatch',{});
      assert.equal((await control(mf,'scrapes',{})).calls.length,before);
      await control(mf,'fail-list',{listUrl:''});
      const resumed=await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST'});
      assert.equal(resumed.status,202,JSON.stringify(resumed));
      await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'completed'));
      const task=(await request(mf,`/internal/capture-tasks/${failedTask.id}`)).data.task;
      assert.equal(task.state,'succeeded');
      assert.equal(task.attemptNo,message.includes('429')?3:2);
      const calls=(await control(mf,'scrapes',{})).calls;
      assert.equal(calls.filter(url=>url==='https://a.test/list.htm').length,2,'verification and initial history page only');
    }finally{await mf.dispose();}
  });
});

test('current source and site controls fence history before fetching and during publication',async t=>{
  for(const target of ['source','site'])for(const phase of ['before-fetch','before-commit'])await t.test(target+' '+phase,async()=>{
    const {mf,gate}=await fixture({versioned:true});
    try{
      const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'控制围栏',origin:'https://a.test'}});
      const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
      const submitted=await control(mf,'submit-backfill',{sourceId,requestId:'control-fence-run'});
      gate.url=phase==='before-fetch'?'workflow-'+submitted.task.id:'https://a.test/list.htm';
      await control(mf,'dispatch',{});
      await waitFor(async()=>assert.equal(gate.held,true));
      const path=target==='source'?`/internal/sources/${sourceId}`:`/internal/sites/${site.data.site.id}`;
      assert.equal((await request(mf,path,{method:'PATCH',body:{enabled:false}})).status,200);
      const before=(await control(mf,'scrapes',{})).calls.length;
      gate.release();
      await waitFor(async()=>{
        const task=(await request(mf,`/internal/capture-tasks/${submitted.task.id}`)).data.task;
        assert.equal(task.state,'deferred',JSON.stringify(task));
      });
      assert.equal((await control(mf,'scrapes',{})).calls.length,before);
      assert.equal((await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries.length,0);
      assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.seenPages,0);
      await request(mf,path,{method:'PATCH',body:{enabled:true}});
      await request(mf,`/internal/sources/${sourceId}/backfill/pause`,{method:'POST'});
      await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST'});
      await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'completed'));
      assert.equal((await control(mf,'scrapes',{})).calls.filter(url=>url==='https://a.test/list.htm').length,2,'saved page reused after control change');
    }finally{gate.release?.();await mf.dispose();}
  });
});

test('disabling a site during backfill start atomically leaves the source idle without work',async()=>{
  const {mf,commitGate}=await fixture();
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'启动围栏',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    commitGate('start',{arm:true});
    const pending=request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'start-disabled-race'}});
    await waitFor(async()=>assert.equal(commitGate('start').held,true));
    await request(mf,`/internal/sites/${site.data.site.id}`,{method:'PATCH',body:{enabled:false}});
    commitGate('start',{release:true});
    assert.equal((await pending).status,409);
    assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'idle');
    assert.equal((await request(mf,'/internal/capture-tasks')).data.tasks.filter(task=>task.kind==='backfill').length,0);
  }finally{commitGate('start',{release:true});await mf.dispose();}
});

test('semantic source changes cancel old history work and allow a new verified run without deleting history',async()=>{
  const {mf,gate}=await fixture({versioned:true});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'重新配置',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    gate.url='https://a.test/list-2.htm';
    const first=await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'reconfigured-run'}});
    await waitFor(async()=>assert.equal(gate.held,true));
    await waitFor(async()=>assert.ok((await request(mf,'/internal/capture-tasks')).data.tasks.some(task=>task.kind==='capture'&&task.state==='succeeded')));
    const discoveries=(await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries;
    await request(mf,`/internal/sources/${sourceId}`,{method:'PATCH',body:{enabled:false}});
    const edited=await request(mf,`/internal/sources/${sourceId}`,{method:'PATCH',body:{listUrl:'https://a.test/list-b.htm'}});
    assert.equal(edited.status,200,JSON.stringify(edited));
    assert.equal(edited.data.source.backfill.state,'idle');
    assert.equal(edited.data.source.backfill.runId,null);
    assert.equal(edited.data.source.backfillCursor,null);
    gate.release();
    await waitFor(async()=>{
      const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks.filter(task=>task.kind==='backfill');
      assert.equal(tasks.filter(task=>task.state==='cancelled').length,1);
    });
    await verify(mf,sourceId,'verify-new-configuration');
    await request(mf,`/internal/sources/${sourceId}`,{method:'PATCH',body:{enabled:true}});
    const next=await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'reconfigured-run'}});
    assert.equal(next.status,202,JSON.stringify(next));
    assert.notEqual(next.data.source.backfill.runId,first.data.source.backfill.runId);
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'completed'));
    const after=(await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries;
    assert.equal(after.length,discoveries.length);
    assert.equal(after[0].firstSeenAt,discoveries[0].firstSeenAt);
    assert.equal((await request(mf,'/internal/capture-tasks')).data.tasks.filter(task=>task.kind==='capture').length,1);
  }finally{gate.release?.();await mf.dispose();}
});

test('history windows use source-local calendar days across DST and reject future local dates',async t=>{
  for(const scenario of [
    {timezone:'America/New_York',now:'2026-04-01T04:30:00Z',days:90,start:'2026-01-01',before:'2025-12-31',today:'2026-04-01',future:'2026-04-02'},
    {timezone:'Asia/Shanghai',now:'2026-10-12T00:30:00Z',days:365,start:'2025-10-12',before:'2025-10-11',today:'2026-10-12',future:'2026-10-13'},
  ])await t.test(scenario.timezone,async()=>{
    const {mf}=await fixture({versioned:true,env:{backfillWindowDays:scenario.days}});
    try{
      const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'来源时区',origin:'https://a.test'}});
      const saved=await request(mf,'/internal/sources',{method:'POST',body:{...sourceCommand(site.data.site.id,'https://a.test/list.htm'),timezone:scenario.timezone}});
      const sourceId=saved.data.source.id;
      await verify(mf,sourceId,'verify-timezone-sample');
      await request(mf,`/internal/sources/${sourceId}`,{method:'PATCH',body:{enabled:true}});
      await (await mf.getD1Database('DB')).prepare('UPDATE sources SET next_discovery_at=? WHERE id=?').bind(Date.parse(scenario.now)+86400000,sourceId).run();
      await control(mf,'clock',{now:Date.parse(scenario.now)});
      await control(mf,'list-options',{articles:[scenario.before,scenario.start,scenario.today,scenario.future,null].map((date,i)=>({url:'https://a.test/info/2026/'+(10+i)+'.htm',title:'日期边界',publishedAt:date}))});
      const started=await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'source-calendar-window'}});
      assert.equal(started.data.source.backfill.windowDays,scenario.days);
      assert.equal(started.data.source.backfill.windowStart,scenario.start);
      await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill.state,'completed'));
      const discoveries=(await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries;
      assert.deepEqual(discoveries.map(row=>row.publishedDay).sort(),[scenario.start,scenario.today,null].sort());
    }finally{await mf.dispose();}
  });
});

test('history backfill uses a durable one-year cursor without creating mail candidates',async()=>{
  const {mf,db,read,provider}=await fixture({versioned:true,notifications:true});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'历史补抓站点',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    const cookie=await login(mf,provider);
    const subscription=await userRequest(mf,cookie,'/api/subscriptions',{
      method:'POST',
      body:{requestId:'history-backfill-subscription',name:'历史栏目',sourceIds:[sourceId],emailMode:'immediate'},
    });
    assert.equal(subscription.status,201,JSON.stringify(subscription));
    await mf.dispatchFetch('https://feed.test/fixture/backfill-dates');
    await control(mf,'clock',{now:Date.parse('2026-10-12T04:00:00Z')});

    const started=await request(mf,`/internal/sources/${sourceId}/backfill`,{
      method:'POST',body:{requestId:'history-backfill-start'},
    });
    await control(mf,'clock',{now:null});
    assert.equal(started.status,202,JSON.stringify(started));
    assert.equal(started.data.source.backfill.state,'running');
    assert.equal(started.data.source.backfill.windowDays,365);
    assert.equal(started.data.source.backfill.windowStart,'2025-10-12');

    await waitFor(async()=>{
      const tasks=(await request(mf,'/internal/capture-tasks')).data.tasks;
      assert.equal(tasks.filter(task=>task.kind==='backfill').length,2,JSON.stringify(tasks));
      assert.equal(tasks.filter(task=>task.kind==='capture').length,2,JSON.stringify(tasks));
      assert.ok(tasks.filter(task=>['backfill','capture'].includes(task.kind)).every(task=>task.state==='succeeded'),JSON.stringify(tasks));
    });
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries.length,2));

    const discoveries=(await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries;
    assert.ok(discoveries.every(row=>row.discoveryClass==='backfill'));
    assert.deepEqual(discoveries.map(row=>row.datePrecision).sort(),['day','unknown']);
    const firstSeen=new Map(discoveries.map(row=>[row.articleId,row.firstSeenAt]));
    const progress=(await request(mf,`/internal/sources/${sourceId}`)).data.source.backfill;
    assert.equal(progress.state,'completed');
    assert.equal(progress.processedArticles,2);
    assert.equal(progress.seenPages,2);
    assert.equal(progress.remainingUrls,0);

    const reading=await(await read(`/api/articles?source=${sourceId}`)).json();
    assert.equal(reading.total,2);
    const events=(await request(mf,'/internal/notification-events')).data.events;
    assert.equal(events.length,2);
    assert.ok(events.every(event=>event.historyOnly===true));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').first()).n,0);

    let unknownEventId=null;
    for(const event of events){
      const detail=(await request(mf,`/internal/notification-events/${event.id}`)).data;
      if(detail.sources.some(source=>source.datePrecision==='unknown'))unknownEventId=event.id;
    }
    assert.ok(unknownEventId);
    const verified=await request(mf,`/internal/notification-events/${unknownEventId}/date-verification`,{
      method:'POST',
      body:{requestId:'history-backfill-date',sourceId,verifiedBy:'feed-admin',
        datePrecision:'day',publishedDay:'2026-03-01',evidence:{method:'source-page'}},
    });
    assert.equal(verified.status,202,JSON.stringify(verified));
    await mf.dispatchFetch('https://feed.test/fixture/drain-matches');
    const corrected=(await request(mf,`/internal/notification-events/${unknownEventId}`)).data;
    assert.equal(corrected.sources.find(source=>source.sourceId===sourceId).datePrecision,'day');
    assert.equal(corrected.matches.filter(match=>match.subscriptionId===subscription.data.subscription.id).length,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM user_deliveries').first()).n,0);
    assert.ok(corrected.matches.some(match=>match.reason==='历史导入或迁移基线不补发邮件'));

    const replay=await request(mf,`/internal/sources/${sourceId}/backfill`,{
      method:'POST',body:{requestId:'history-backfill-start'},
    });
    assert.equal(replay.status,202,JSON.stringify(replay));
    assert.equal(replay.data.source.backfill.state,'completed');
    const replayDiscoveries=(await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries;
    assert.deepEqual(replayDiscoveries.map(row=>[row.articleId,row.firstSeenAt]).sort(),
      [...firstSeen].map(([articleId,seen])=>[articleId,seen]).sort());
  }finally{await mf.dispose();}
});

test('pausing a persisted backfill prevents paid work and resumes the same task',async()=>{
  const {mf,db}=await fixture({versioned:true});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'暂停恢复站点',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list.htm');
    const submitted=await(await mf.dispatchFetch('https://feed.test/fixture/submit-backfill',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sourceId,requestId:'pause-before-dispatch'}),
    })).json();
    assert.equal(submitted.task.state,'queued');
    await db.prepare('UPDATE sources SET next_discovery_at=? WHERE id=?')
      .bind(Date.now()+3_600_000,sourceId).run();
    const before=(await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls.length;

    const paused=await request(mf,`/internal/sources/${sourceId}/backfill/pause`,{method:'POST'});
    assert.equal(paused.status,200,JSON.stringify(paused));
    await request(mf,'/internal/sources/schedule',{method:'POST'});
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${submitted.task.id}`)).data.task;
      assert.equal(task.state,'queued',JSON.stringify(task));
    });
    assert.equal((await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls.length,before);

    const resumed=await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST'});
    assert.equal(resumed.status,202,JSON.stringify(resumed));
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${submitted.task.id}`)).data.task;
      assert.equal(task.state,'succeeded',JSON.stringify(task));
      assert.equal(task.attemptNo,1);
    });
    await waitFor(async()=>{
      const source=(await request(mf,`/internal/sources/${sourceId}`)).data.source;
      assert.equal(source.backfill.state,'completed',JSON.stringify(source));
    });
    assert.equal((await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries.length,1);
    const source=(await request(mf,`/internal/sources/${sourceId}`)).data.source;
    assert.equal(source.backfill.state,'completed');
    assert.equal(source.backfill.processedArticles,1);
  }finally{await mf.dispose();}
});

test('pausing an in-flight history page retains its checkpoint and resumes without another scrape',async()=>{
  const {mf,gate}=await fixture({versioned:true,discoveryPages:1});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'运行中暂停站点',origin:'https://a.test'}});
    const sourceId=await createHistorySource(mf,site.data.site.id,'https://a.test/list-a.htm');
    gate.url='https://a.test/list-a.htm';
    const started=await request(mf,`/internal/sources/${sourceId}/backfill`,{method:'POST',body:{requestId:'pause-inflight-page'}});
    await waitFor(async()=>assert.equal(gate.held,true));
    await request(mf,`/internal/sources/${sourceId}/backfill/pause`,{method:'POST'});
    gate.release();
    await waitFor(async()=>{
      const task=(await request(mf,`/internal/capture-tasks/${started.data.task.id}`)).data.task;
      assert.equal(task.state,'deferred',JSON.stringify(task));
    });
    assert.equal((await request(mf,`/internal/sources/${sourceId}/discoveries`)).data.discoveries.length,0);
    const callsBefore=(await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls;
    const firstPages=callsBefore.filter(call=>call==='https://a.test/list-a.htm').length;
    await request(mf,`/internal/sources/${sourceId}/backfill/resume`,{method:'POST'});
    await waitFor(async()=>{
      const source=(await request(mf,`/internal/sources/${sourceId}`)).data.source;
      assert.equal(source.backfill.state,'completed',JSON.stringify(source));
      assert.equal(source.backfill.seenPages,2);
      assert.equal(source.backfill.processedArticles,1);
    });
    const callsAfter=(await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json()).calls;
    assert.equal(callsAfter.filter(call=>call==='https://a.test/list-a.htm').length,firstPages);
  }finally{gate.release?.();await mf.dispose();}
});

test('live tasks dispatch first while admin starts and continuation pages share durable admission limits',async()=>{
  const {mf,db}=await fixture({versioned:true,discoveryPages:1,env:{liveBudget:1,backfillBudget:1}});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'调度预算站点',origin:'https://a.test'}});
    const live=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
    const history=await createHistorySource(mf,site.data.site.id,'https://a.test/list-b.htm');
    await control(mf,'clock',{now:Date.parse('2026-10-12T04:00:00Z')});
    await db.prepare('UPDATE sources SET next_discovery_at=? WHERE id=?').bind(Date.parse('2026-10-13T00:00:00Z'),history).run();
    await control(mf,'submit-backfill',{sourceId:history,requestId:'budget-history-30',windowDays:30});
    const before=(await control(mf,'sent',{})).length;
    await Promise.all([control(mf,'dispatch',{}),control(mf,'dispatch',{})]);
    await waitFor(async()=>{
      const source=(await request(mf,`/internal/sources/${history}`)).data.source;
      assert.equal(source.backfill.seenPages,1);
    });
    await control(mf,'dispatch',{});
    const sent=(await control(mf,'sent',{})).slice(before).filter(message=>['discover','backfill'].includes(message.kind));
    assert.equal(sent[0].kind,'discover');
    assert.equal(sent[0].sourceId,live);
    assert.equal(new Set(sent.filter(message=>message.kind==='backfill').map(message=>message.taskId)).size,1);
    const waiting=(await request(mf,`/internal/sources/${history}`)).data.source.backfill;
    assert.equal(waiting.state,'running');
    assert.equal(waiting.remainingUrls,1);
    await control(mf,'clock',{now:Date.parse('2026-10-12T04:01:00Z')});
    await control(mf,'dispatch',{});
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${history}`)).data.source.backfill.state,'completed'));
    const pages=(await control(mf,'scrapes',{})).calls.filter(url=>url.startsWith('https://a.test/list-b'));
    assert.equal(pages.length,4,'two verification pages and exactly two admitted history pages');
  }finally{await mf.dispose();}
});

test('exhausted live admission does not starve history with its own available budget',async()=>{
  const {mf}=await fixture({versioned:true,env:{liveBudget:0,backfillBudget:1}});
  try{
    const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'独立调度预算',origin:'https://a.test'}});
    await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
    const history=await createHistorySource(mf,site.data.site.id,'https://a.test/list-b.htm');
    await control(mf,'schedule-only',{});
    await control(mf,'submit-backfill',{sourceId:history,requestId:'independent-budget'});
    const before=(await control(mf,'sent',{})).length;
    await control(mf,'dispatch',{limit:1});
    const sent=(await control(mf,'sent',{})).slice(before);
    assert.ok(sent.some(message=>message.kind==='backfill'&&message.sourceId===history),JSON.stringify(sent));
    assert.equal(sent.filter(message=>message.kind==='discover').length,0);
    await waitFor(async()=>assert.equal((await request(mf,`/internal/sources/${history}`)).data.source.backfill.seenPages,1));
  }finally{await mf.dispose();}
});

test('discovery admission retention removes only old terminal or superseded permits in bounded batches',async()=>{
  const {mf,db}=await fixture({versioned:true,env:{admissionRetentionMs:60*60*1000}});
  try{
    const now=Date.now(),old=now-2*60*60*1000,recent=now+30*60*1000;
    const cases=[
      {id:'a0000000000000000000001',state:'succeeded',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:false},
      {id:'a0000000000000000000002',state:'cancelled',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:false},
      {id:'a0000000000000000000003',state:'queued',taskAttempt:2,permitAttempt:1,admittedAt:old,retained:false},
      {id:'a0000000000000000000004',state:'queued',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:true},
      {id:'a0000000000000000000005',state:'failed',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:true},
      {id:'a0000000000000000000006',state:'blocked',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:true},
      {id:'a0000000000000000000007',state:'deferred',taskAttempt:1,permitAttempt:1,admittedAt:old,retained:true},
      {id:'a0000000000000000000008',state:'succeeded',taskAttempt:1,permitAttempt:1,admittedAt:recent,retained:true},
    ];
    for(const permit of cases)await seedDiscoveryPermit(db,permit);
    await db.batch([
      db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<101)
        INSERT INTO tasks(id,kind,business_key,payload_json,state,due_at,attempt_no,created_at,updated_at)
        SELECT 'b'||printf('%023d',n),'discover','bulk-admission-'||n,'{}','succeeded',?,1,?,? FROM seq`).bind(old,old,old),
      db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<101)
        INSERT INTO discovery_admissions(task_id,attempt_no,lane,slot,admitted_at)
        SELECT 'b'||printf('%023d',n),1,'discover',0,? FROM seq`).bind(old),
    ]);

    await control(mf,'recover',{});
    const afterFirst=await db.prepare(`SELECT a.task_id AS taskId FROM discovery_admissions a
      WHERE a.task_id LIKE 'a%' ORDER BY a.task_id`).all();
    assert.deepEqual(afterFirst.results.map(row=>row.taskId),cases.filter(case_=>case_.retained).map(case_=>case_.id));
    const eligibleRemaining=await db.prepare(`SELECT a.task_id AS taskId FROM discovery_admissions a JOIN tasks t ON t.id=a.task_id
      WHERE a.admitted_at<=? AND (t.state IN ('succeeded','cancelled') OR t.attempt_no>a.attempt_no) ORDER BY a.task_id`).bind(now).all();
    assert.deepEqual(eligibleRemaining.results.map(row=>row.taskId),[
      'b00000000000000000000098','b00000000000000000000099','b00000000000000000000100','b00000000000000000000101',
    ],'retention cleanup must be bounded to 100 permits per recovery invocation');

    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM discovery_admissions`).first()).n,9);
  }finally{await mf.dispose();}
});

test('a later column association fans out an already ready shared event',async()=>{
  const {mf,provider,commitGate}=await fixture({versioned:true,notifications:true});
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
    commitGate('match',{arm:true});
    const dispatched=await control(mf,'dispatch',{});
    assert.ok(dispatched.length>0);
    await waitFor(async()=>assert.equal(commitGate('match').held,true));

    const inFlight=await userRequest(mf,cookie,`/api/subscriptions/${created.data.subscription.id}`);
    assert.equal(inFlight.status,200,JSON.stringify(inFlight));
    commitGate('match',{release:true});
    let detail;
    await waitFor(async()=>{
      detail=await userRequest(mf,cookie,`/api/subscriptions/${created.data.subscription.id}`);
      assert.equal(detail.status,200,JSON.stringify(detail));
      assert.deepEqual(detail.data.subscription.notificationMatches.map(match=>[match.eventId,match.status]),
        [[eventId,'pending_immediate']]);
    });
    const after=(await request(mf,`/internal/notification-events/${eventId}`)).data;
    assert.equal(after.sources.find(source=>source.sourceId===second).datePrecision,'minute');
    assert.equal(after.delivery.kind,'immediate');
  }finally{
    commitGate('match',{release:true});
    await mf.dispose();
  }
});

test('concurrent readiness and discovery retain the new column in either commit order',async()=>{
  for(const firstCommit of ['ready','association']){
    const {mf,provider,commitGate:gate}=await fixture({versioned:true,notifications:true,discoveryPages:1});
    try{
      const site=await request(mf,'/internal/sites',{method:'POST',body:{name:'并发关联',origin:'https://a.test'}});
      const first=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-a.htm');
      await gate('ready',{arm:true});
      await request(mf,'/internal/sources/schedule',{method:'POST'});
      await waitFor(async()=>assert.equal((await gate('ready')).held,true));
      const second=await createVerifiedSource(mf,site.data.site.id,'https://a.test/list-b.htm');
      const cookie=await login(mf,provider);
      const subscription=await userRequest(mf,cookie,'/api/subscriptions',{
        method:'POST',body:{requestId:'racing-column-subscription',name:'并发栏目',sourceIds:[second],emailMode:'off'},
      });
      assert.equal(subscription.status,201,JSON.stringify(subscription));
      await gate('association',{arm:true,sourceId:second});
      await request(mf,'/internal/sources/schedule',{method:'POST'});
      await waitFor(async()=>assert.equal((await gate('association')).held,true));
      await gate(firstCommit,{release:true});
      if(firstCommit==='ready')await waitFor(async()=>assert.equal((await request(mf,'/internal/notification-events')).data.events.length,1));
      else await waitFor(async()=>{
        assert.equal((await request(mf,`/internal/sources/${second}/discoveries`)).data.discoveries.length,1);
        const receipts=await(await mf.dispatchFetch('https://feed.test/fixture/replay-associations',{
          method:'POST',body:JSON.stringify({sourceId:second}),
        })).json();
        assert.ok(receipts.length>0&&receipts.every(receipt=>receipt.acked),'source handoff must finish before ready commits');
      });
      await gate(firstCommit==='ready'?'association':'ready',{release:true});
      await waitFor(async()=>{
        // Run the same persisted handoff/recovery entry point a scheduled worker uses.
        await mf.dispatchFetch('https://feed.test/fixture/recover');
        const events=(await request(mf,'/internal/notification-events')).data.events;
        assert.equal(events.length,1);
        const details=(await request(mf,`/internal/notification-events/${events[0].id}`)).data;
        assert.deepEqual(details.sources.map(source=>source.sourceId).sort(),[first,second].sort(),firstCommit);
        assert.equal(details.matches.filter(match=>match.subscriptionId===subscription.data.subscription.id).length,1,firstCommit);
      });
    }finally{
      await gate('ready',{release:true});await gate('association',{release:true});await mf.dispose();
    }
  }
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
    const task=(await request(mf,`/internal/capture-tasks/${submitted.data.task.id}`)).data.task;
    assert.equal(source.validationState,'verified',JSON.stringify({source,task}));
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

async function control(mf,path,body){
  return (await mf.dispatchFetch('https://feed.test/fixture/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
}

async function seedDiscoveryPermit(db,{id,state,taskAttempt,permitAttempt,admittedAt}){
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,kind,business_key,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'discover',?,?,?,?,?,?,?)`)
      .bind(id,`admission-${id}`,'{}',state,admittedAt+26*60*60*1000,taskAttempt,admittedAt,admittedAt),
    db.prepare(`INSERT INTO discovery_admissions(task_id,attempt_no,lane,slot,admitted_at)
      VALUES (?,?,'discover',0,?)`).bind(id,permitAttempt,admittedAt),
  ]);
}

async function createHistorySource(mf,siteId,listUrl){
  const id=await createVerifiedSource(mf,siteId,listUrl);
  // History scenarios keep live refresh in a later slot; the admission test
  // separately includes a source with due live work.
  await (await mf.getD1Database('DB')).prepare('UPDATE sources SET next_discovery_at=? WHERE id=?').bind(Date.now()+86400000,id).run();
  return id;
}
