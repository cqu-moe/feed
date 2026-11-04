import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {login,loginAdmin,oauthProvider} from './helpers/oauth-provider.mjs';

const articleId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';

const workersPlugin={
  name:'task-runtime-workers-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'task-runtime-workers-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'task-runtime-workers-stub'},()=>({
      loader:'js',
      contents:'export class DurableObject{}; export class WorkerEntrypoint{}; export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

const browserPlugin={
  name:'task-runtime-browser-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/\.\/browser-scrape\.mjs$/},()=>({path:'browser-scrape',namespace:'task-runtime-browser-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'task-runtime-browser-stub'},()=>({
      loader:'js',
      contents:`
        const calls=[];
        globalThis.TASK_RUNTIME_SCRAPES=calls;
        globalThis.TASK_RUNTIME_SCRAPE_MODE='success';
        const success=()=>{
          const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value)));
          const snapshot='<html><body><main><h1>队列采集通知</h1><p>中文正文</p></main></body></html>';
          const pdf='%PDF-1.7\\\\n中文附件';
          return {
            markdown:'中文正文',
            rawHtml:snapshot,
            metadata:{statusCode:200,provider:'browser-container'},
            screenshot:{contentType:'image/png',base64:'iVBORw0KGgo='},
            actions:{javascriptReturns:[{value:JSON.stringify({
              bodyRecognized:true,
              page:{url:${JSON.stringify(articleUrl)}},
              bodyText:'中文正文',
              errors:[],
              artifacts:[
                {name:'attachment-1.pdf',base64:base64(pdf),contentType:'application/pdf'},
                {name:'snapshot.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
                {name:'offline.html',base64:base64(snapshot),contentType:'text/html; charset=utf-8'},
              ],
              attachmentCandidates:[],
              downloads:[],
            })}]},
          };
        };
        export async function scrape(_env,url){
          calls.push(url);
          const mode=globalThis.TASK_RUNTIME_SCRAPE_MODE;
          if(mode==='rate-limit')throw new Error('Browser HTTP 429: rate limit exceeded');
          if(mode==='long-rate-limit'){
            const error=new Error('Browser HTTP 429: rate limit exceeded');
            error.retryAfterMs=12*60*60*1000;
            throw error;
          }
          if(mode==='quota')throw new Error('Archive upload quota exhausted');
          if(mode==='network')throw Object.assign(new Error('Browser connection closed'),{code:'browser_transient',retryable:true});
          if(mode==='capacity')throw Object.assign(new Error('Browser HTTP 503: There is no Container instance available'),{code:'container_capacity',retryable:true});
          if(mode==='hang'){
            while(globalThis.TASK_RUNTIME_SCRAPE_MODE==='hang')await new Promise(resolve=>setTimeout(resolve,10));
            return success();
          }
          return success();
        }
      `,
    }));
  },
};

async function fixture({
  articleStatus='pending',
  articleAttempts=0,
  leaseUntil=0,
  runtimeEnabled=true,
  crawlEnabled=true,
  recheckRuntime=false,
  queueConsumer=true,
}={}){
  const provider=oauthProvider();
  const bundle=await build({
    stdin:{
      contents:`
        import worker from './worker/index.mjs';
        import {apiRoute} from './worker/api.mjs';
        import {createTaskRuntime,handleFeedJobs} from './worker/task-runtime.mjs';
        import {CaptureWorkflow} from './worker/capture-workflow.mjs';
        import {workflowStep as step} from './tests/helpers/workflow-step.mjs';
        globalThis.TASK_RUNTIME_WORKFLOW_SLEEPS=step.sleeps;
        step.sleep=async(name,duration)=>{
          step.sleeps.push({name,duration});
          while(globalThis.TASK_RUNTIME_SCRAPE_MODE==='capacity')await new Promise(resolve=>setTimeout(resolve,10));
        };

        globalThis.TASK_RUNTIME_QUEUE_BODIES=[];
        globalThis.TASK_RUNTIME_QUEUE_ACKED=[];
        globalThis.TASK_RUNTIME_WORKFLOW_CALLS=[];
        globalThis.TASK_RUNTIME_QUEUE_SENDS=[];
        globalThis.TASK_RUNTIME_QUEUE_SEND_OPTIONS=[];
        globalThis.TASK_RUNTIME_QUEUE_RETRY_OPTIONS=[];
        globalThis.TASK_RUNTIME_QUEUE_MODE='real';
        globalThis.TASK_RUNTIME_DB_FAULTS={sqlIncludes:'',times:0,error:'Injected D1 failure'};
        globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING=0;
        globalThis.TASK_RUNTIME_PLATFORM_STATUS='business';
        globalThis.TASK_RUNTIME_WORKFLOW_MODE='run';
        globalThis.TASK_RUNTIME_ACTIVE_WORKFLOWS=[];
        globalThis.TASK_RUNTIME_EXECUTION_MODE='queue';
        const instances=new Map();
        const instance=id=>{
          if(!instances.has(id))throw new Error('Workflow instance not found');
          return {id,status:async()=>({status:instances.get(id).status,error:instances.get(id).error})};
        };
        const workflow={
          async create({id,params}){
            globalThis.TASK_RUNTIME_WORKFLOW_CALLS.push({op:'create',id});
            if(globalThis.TASK_RUNTIME_WORKFLOW_MODE==='unavailable')throw new Error('Workflow binding unavailable');
            if(instances.has(id))throw new Error('Workflow instance already exists');
            if(globalThis.TASK_RUNTIME_WORKFLOW_MODE==='platform'){
              instances.set(id,{status:'running',error:null});
              if(globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING>0){
                globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING--;
                throw new Error('Workflow create result unknown after instance was accepted');
              }
              return instance(id);
            }
            let error=null;
            try{
              const execution=new CaptureWorkflow(globalThis.TASK_RUNTIME_ENV).run({instanceId:id,payload:params},step);
              instances.set(id,{status:'running',error:null,execution});
              globalThis.TASK_RUNTIME_ACTIVE_WORKFLOWS.push(execution);
              execution.then(()=>{
                instances.get(id).status='complete';
              }).catch(runError=>{
                const record=instances.get(id);
                record.status=globalThis.TASK_RUNTIME_PLATFORM_STATUS==='complete'?'complete':'errored';
                record.error=runError;
              });
              return instance(id);
            }catch(runError){
              error=runError;
              instances.set(id,{
                status:globalThis.TASK_RUNTIME_PLATFORM_STATUS==='complete'?'complete':'errored',
                error,
              });
            }
            return instance(id);
          },
          async get(id){
            globalThis.TASK_RUNTIME_WORKFLOW_CALLS.push({op:'get',id});
            return instance(id);
          },
        };
        function instrumentDb(db){
          return new Proxy(db,{
            get(target,property){
              if(property==='prepare')return sql=>{
                const statement=target.prepare(sql);
                const faults=globalThis.TASK_RUNTIME_DB_FAULTS;
                if(faults.sqlIncludes&&sql.includes(faults.sqlIncludes)&&faults.times>0){
                  const throwFault=()=>{
                    faults.times--;
                    throw new Error(faults.error);
                  };
                  const faultingStatement=target=>new Proxy(target,{
                    get(target,property){
                      if(property==='bind')return (...args)=>faultingStatement(target.bind(...args));
                      if(['first','all','run','raw'].includes(property))return async()=>throwFault();
                      const value=target[property];
                      return typeof value==='function'?value.bind(target):value;
                    },
                  });
                  return faultingStatement(statement);
                }
                return statement;
              };
              const value=target[property];
              return typeof value==='function'?value.bind(target):value;
            },
          });
        }
        function prepareEnv(rawEnv){
          const actualQueue=rawEnv.FEED_JOBS;
          const env={...rawEnv,DB:instrumentDb(rawEnv.DB),CAPTURE:workflow,
            COLLECTION_EXECUTOR:globalThis.TASK_RUNTIME_EXECUTION_MODE==='workflow'?'workflow':'queue',FEED_JOBS:{
            async send(body,options){
              if(globalThis.TASK_RUNTIME_QUEUE_MODE==='fail')throw new Error('Injected queue send failure');
              if(globalThis.TASK_RUNTIME_EXECUTION_MODE==='legacy'){
                await rawEnv.DB.prepare(\`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
                  VALUES (?,?,?,'starting',?) ON CONFLICT DO NOTHING\`)
                  .bind(body.taskId,body.attempt,'task-'+body.taskId+'-a'+body.attempt,Date.now()).run();
              }
              globalThis.TASK_RUNTIME_QUEUE_SENDS.push(body);
              globalThis.TASK_RUNTIME_QUEUE_SEND_OPTIONS.push(options);
              if(globalThis.TASK_RUNTIME_QUEUE_MODE==='hold')return;
              return await actualQueue.send(body,options);
            },
          }};
          globalThis.TASK_RUNTIME_ENV=env;
          return env;
        }
        async function fixtureControl(request,env){
          const url=new URL(request.url);
          if(url.pathname==='/fixture/queue'){
            if(request.method==='POST'){
              const body=await request.json();
              globalThis.TASK_RUNTIME_QUEUE_MODE=body.mode;
            }
            return Response.json({
              mode:globalThis.TASK_RUNTIME_QUEUE_MODE,
              messages:globalThis.TASK_RUNTIME_QUEUE_BODIES,
              acked:globalThis.TASK_RUNTIME_QUEUE_ACKED,
              sends:globalThis.TASK_RUNTIME_QUEUE_SENDS,
              sendOptions:globalThis.TASK_RUNTIME_QUEUE_SEND_OPTIONS,
              retryOptions:globalThis.TASK_RUNTIME_QUEUE_RETRY_OPTIONS,
            });
          }
          if(url.pathname==='/fixture/scrape-mode'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_SCRAPE_MODE=body.mode;
            return Response.json({mode:globalThis.TASK_RUNTIME_SCRAPE_MODE});
          }
          if(url.pathname==='/fixture/platform-status'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_PLATFORM_STATUS=body.status;
            return Response.json({status:globalThis.TASK_RUNTIME_PLATFORM_STATUS});
          }
          if(url.pathname==='/fixture/workflow-mode'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_WORKFLOW_MODE=body.mode;
            return Response.json({mode:globalThis.TASK_RUNTIME_WORKFLOW_MODE});
          }
          if(url.pathname==='/fixture/execution-mode'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_EXECUTION_MODE=body.mode;
            return Response.json({mode:globalThis.TASK_RUNTIME_EXECUTION_MODE});
          }
          if(url.pathname==='/fixture/create-failures'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING=body.times;
            return Response.json({remaining:globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING});
          }
          if(url.pathname==='/fixture/db-faults'){
            const body=await request.json();
            globalThis.TASK_RUNTIME_DB_FAULTS=body.reset
              ?{sqlIncludes:'',times:0,error:'Injected D1 failure'}
              :{sqlIncludes:body.sqlIncludes??'',times:body.times??1,error:body.error??'Injected D1 failure'};
            return Response.json(globalThis.TASK_RUNTIME_DB_FAULTS);
          }
          if(url.pathname==='/fixture/recover')return Response.json(await createTaskRuntime(env,{workflow}).recover());
          if(url.pathname==='/fixture/replay'){
            const body=await request.json();
            let acked=false,retried=false;
            const message={body,attempt:1,ack(){acked=true;},retry(options){
              retried=true;
              globalThis.TASK_RUNTIME_QUEUE_RETRY_OPTIONS.push(options);
            }};
            await handleFeedJobs({messages:[message]},env,{workflow});
            await Promise.all(globalThis.TASK_RUNTIME_ACTIVE_WORKFLOWS.splice(0));
            return Response.json({acked,retried});
          }
          return null;
        }

        export default {
          async fetch(request,rawEnv){
            const env=prepareEnv(rawEnv);
            const url=new URL(request.url);
            const control=await fixtureControl(request,env);
            if(control)return control;
            if(url.pathname==='/fixture/scrapes')return Response.json({calls:globalThis.TASK_RUNTIME_SCRAPES});
            if(url.pathname==='/fixture/workflows')return Response.json({
              calls:globalThis.TASK_RUNTIME_WORKFLOW_CALLS,
              instances:[...instances.entries()].map(([id,value])=>({id,status:value.status})),
            sleeps:globalThis.TASK_RUNTIME_WORKFLOW_SLEEPS,
            });
            if(url.pathname.startsWith('/api/'))return apiRoute(request,env);
            return worker.fetch(request,env);
          },
          async queue(batch,rawEnv){
            const env=prepareEnv(rawEnv);
            for(const message of batch.messages)globalThis.TASK_RUNTIME_QUEUE_BODIES.push(message.body);
            const observed={...batch,messages:batch.messages.map(message=>({body:message.body,attempts:message.attempts,
              ack(){globalThis.TASK_RUNTIME_QUEUE_ACKED.push(message.body.taskId);message.ack();},
              retry(options){message.retry(options);},
            }))};
            await handleFeedJobs(observed,env,{workflow});
            await Promise.all(globalThis.TASK_RUNTIME_ACTIVE_WORKFLOWS.splice(0));
          },
        };
      `,
      resolveDir:process.cwd(),
      sourcefile:'task-runtime-fixture.mjs',
    },
    bundle:true,
    write:false,
    format:'esm',
    platform:'browser',
    external:['node:buffer','node:*'],
    plugins:[workersPlugin,browserPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,
    script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
    bindings:{
      ...provider.bindings,
      BASE_URL:'https://feed.test',
      BRIDGE_SECRET:'test-bridge-secret',
      CRAWL_ENABLED:String(crawlEnabled),
      PDF_OCR_ENABLED:'false',
      TASK_RUNTIME_ENABLED:String(runtimeEnabled),
      ...(recheckRuntime?{ARCHIVE_VERSIONS_ENABLED:'true'}:{}),
    },
    d1Databases:['DB'],serviceBindings:{AUTH:request=>provider.fetch(request)},
    r2Buckets:['ARCHIVE'],
    queueProducers:queueConsumer?{FEED_JOBS:{queueName:'feed-jobs'}}:{},
    ...(queueConsumer?{queueConsumers:{'feed-jobs':{maxBatchSize:1,maxRetries:3,deadLetterQueue:'feed-jobs-dlq'}}}:{}),
  }));
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  for(const name of ['0001_feed.sql','0002_auth.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql','0006_sources.sql',
    ...(recheckRuntime?['0007_archive_versions.sql','0008_content_events.sql','0017_archive_recheck.sql']:[]),
    '0018_outbox_receipts.sql','0019_site_execution_leases.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await db.prepare("UPDATE sources SET site_id='7fd03676e5751e9b6dd95ecb',list_url='https://jwc.cqu.edu.cn/index/tzgg.htm' WHERE id='jwc'").run();
  await db.prepare("INSERT INTO sources(id,site_id,name,url,list_url) VALUES ('jwc','7fd03676e5751e9b6dd95ecb','教务处','https://jwc.cqu.edu.cn/','https://jwc.cqu.edu.cn/index/tzgg.htm')").run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until) VALUES (?,'jwc',?,'队列采集通知','2026-10-10','2026-10-11',?,?,?)")
    .bind(articleId,articleUrl,articleStatus,articleAttempts,leaseUntil).run();
  return {mf,db,bucket,provider,admin:await loginAdmin(mf,provider)};
}

test('admin capture task survives queue handoff and archives one article for reading',async()=>{
  const {mf,db,bucket,admin}=await fixture();
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'manual-20261012-1'}),
    });
    if(create.status!==202)assert.fail(await create.text());
    const created=await create.json();
    assert.equal(created.task.state,'queued');
    assert.equal(created.task.articleId,articleId);
    assert.equal(created.duplicate,false);

    const duplicate=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'manual-20261012-1'}),
    });
    assert.equal(duplicate.status,202);
    const replay=await duplicate.json();
    assert.equal(replay.task.id,created.task.id);
    assert.ok(replay.duplicate,JSON.stringify(replay));

    const outbox=await db.prepare('SELECT topic,dedupe_key,payload_json,state FROM outbox').all();
    assert.equal(outbox.results.length,1);
    const payload=JSON.parse(outbox.results[0].payload_json);
    assert.deepEqual(Object.keys(payload).sort(),['attempt','outboxId','taskId','type','v']);
    assert.equal(payload.attempt,1);
    assert.equal(payload.type,'start-job');
    assert.equal(payload.taskId,created.task.id);
    assert.equal(JSON.stringify(payload).includes(articleUrl),false);

    await waitFor(async()=>{
      const current=await task(db,created.task.id);
      assert.equal(current.state,'succeeded',JSON.stringify(current));
    });
    const status=await(await mf.dispatchFetch(`https://feed.test/internal/capture-tasks/${created.task.id}`,{
      headers:admin.headers,
    })).json();
    assert.equal(status.task.state,'succeeded');
    assert.equal(status.attempt.workflowInstanceId,`queue-${created.task.id}-a1`);
    assert.equal(status.attempt.state,'succeeded');
    assert.equal(status.article.status,'complete');

    const queue=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.deepEqual(queue.messages,[payload]);
    const scrapes=await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json();
    assert.deepEqual(scrapes.calls,[articleUrl]);
    const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
    assert.deepEqual(workflows.calls,[]);

    const reading=await(await mf.dispatchFetch('https://feed.test/api/articles?q='+encodeURIComponent('中文正文'))).json();
    assert.deepEqual(reading.articles.map(row=>row.id),[articleId]);
    const article=await db.prepare('SELECT prefix,snapshot_key FROM articles WHERE id=?').bind(articleId).first();
    const snapshot=await bucket.get(article.snapshot_key);
    assert.match(await snapshot.text(),/队列采集通知/);
    const screenshot=await(await mf.dispatchFetch('https://feed.test/api/screenshots/'+articleId)).arrayBuffer();
    assert.deepEqual([...new Uint8Array(screenshot).subarray(0,4)],[0x89,0x50,0x4e,0x47]);
    const manifest=await(await bucket.get(`${article.prefix}/manifest.json`)).json();
    assert.equal(manifest.status,'complete');
  }finally{
    await mf.dispose();
  }
});

test('admin capture task entrance rejects anonymous, ordinary-session, and legacy bearer credentials',async()=>{
  const {mf,provider}=await fixture();
  try{
    const ordinaryCookie=await login(mf,provider,'ordinary-user');
    for(const [headers,status] of [
      [{'Content-Type':'application/json'},401],
      [{Authorization:'Bearer wrong-admin-token','Content-Type':'application/json'},401],
      [{Cookie:ordinaryCookie,Origin:'https://feed.test','Content-Type':'application/json'},403],
    ]){
      const response=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
        method:'POST',
        headers,
        body:JSON.stringify({articleId,requestId:'auth-check-1'}),
      });
      assert.equal(response.status,status);
      assert.equal((await response.json()).error,status===401?'请先登录':'需要 feed.admin 管理权限');
    }
  }finally{
    await mf.dispose();
  }
});

test('capture task creation stays disabled by default while authenticated status reads remain available',async()=>{
  const {mf,db,admin}=await fixture({runtimeEnabled:false,crawlEnabled:false});
  try{
    const disabled=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'disabled-1'}),
    });
    assert.equal(disabled.status,503);
    assert.equal((await disabled.json()).error,'Capture task runtime is disabled');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tasks').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first()).n,0);

    const list=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      headers:admin.headers,
    });
    assert.equal(list.status,200);
    assert.deepEqual(await list.json(),{tasks:[]});
  }finally{
    await mf.dispose();
  }
});

test('capture task committed before queue enrollment is recovered by dispatching the same outbox',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    const mode=await(await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'fail'}),
    })).json();
    assert.equal(mode.mode,'fail');
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'outbox-commit-1'}),
    });
    assert.equal(create.status,202);
    const created=await create.json();
    assert.equal(created.task.state,'queued');
    const outbox=await db.prepare('SELECT id,attempts FROM outbox WHERE state=?').bind('queued').first();
    assert.ok(outbox);
    assert.equal(outbox.attempts,1);
    assert.equal((await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends.length,0);
    const due=Date.now()-60_000;
    await db.prepare('UPDATE outbox SET available_at=?,updated_at=? WHERE id=?').bind(due,due,outbox.id).run();

    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'real'}),
    });
    const recovered=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
      method:'POST',
      headers:admin.headers,
    })).json();
    assert.deepEqual(recovered.dispatched,[outbox.id]);
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'succeeded');
    });
    const queue=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.equal(queue.sends.length,1);
    assert.equal(queue.messages.length,1);
    assert.equal(queue.messages[0].taskId,created.task.id);
    assert.equal(queue.messages[0].attempt,1);
  }finally{
    await mf.dispose();
  }
});

test('outbox remains replayable when Queue accepts a message before its sent receipt is committed',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'hold'}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/db-faults',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sqlIncludes:"UPDATE outbox SET state='sent'",times:1}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'outbox-receipt-1'}),
    });
    assert.equal(create.status,202);
    const created=await create.json();
    const held=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.equal(held.sends.length,1);
    assert.equal(held.messages.length,0);
    const outbox=await db.prepare('SELECT id,payload_json,state,attempts FROM outbox').first();
    assert.equal(outbox.state,'queued');
    assert.equal(outbox.attempts,1);
    const payload=JSON.parse(outbox.payload_json);

    await mf.dispatchFetch('https://feed.test/fixture/db-faults',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reset:true}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'real'}),
    });
    const due=Date.now()-60_000;
    await db.prepare('UPDATE outbox SET available_at=?,updated_at=? WHERE id=?').bind(due,due,outbox.id).run();
    const recovered=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
      method:'POST',
      headers:admin.headers,
    })).json();
    assert.deepEqual(recovered.dispatched,[outbox.id]);
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'succeeded');
    });
    const queue=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.equal(queue.sends.length,2);
    assert.deepEqual(queue.sends[0],queue.sends[1]);
    assert.deepEqual(queue.messages,[payload]);
    assert.equal((await scrapes(mf)).calls.length,1);
  }finally{
    await mf.dispose();
  }
});

test('a scheduled launch waits in Queue and an early delivery returns to Queue without handoff',async()=>{
  const {mf,db,admin}=await fixture({queueConsumer:false});
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'scheduled-launch-1'}),
    });
    assert.equal(create.status,202);
    const created=await create.json();
    const outbox=await db.prepare('SELECT id FROM outbox').first();
    const sentAt=Date.now();
    await db.batch([
      db.prepare('UPDATE tasks SET due_at=? WHERE id=?')
        .bind(sentAt+48*60*1000,created.task.id),
      db.prepare("UPDATE outbox SET state='queued',available_at=?,updated_at=? WHERE id=? AND attempts=1")
        .bind(sentAt,sentAt,outbox.id),
    ]);

    const recovered=await(await mf.dispatchFetch('https://feed.test/fixture/recover')).json();
    assert.deepEqual(recovered.dispatched,[outbox.id]);
    const queue=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.ok(Math.abs(queue.sendOptions.at(-1).delaySeconds-2880)<=1);
    assert.deepEqual(queue.retryOptions,[]);

    const payload=queue.sends.at(-1);
    const early=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    })).json();
    assert.deepEqual(early,{acked:false,retried:true});
    const retried=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.ok(Math.abs(retried.retryOptions[0].delaySeconds-2880)<=1);
    const current=await db.prepare(`SELECT state,attempt_no AS attemptNo FROM tasks WHERE id=?`)
      .bind(created.task.id).first();
    assert.deepEqual(current,{state:'queued',attemptNo:1});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?')
      .bind(created.task.id).first()).n,0);
    assert.equal((await scrapes(mf)).calls.length,0);
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json()).calls,[]);
  }finally{
    await mf.dispose();
  }
});

test('Workflow create receipt failure replays with the same instance instead of creating a random one',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/execution-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'legacy'}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/workflow-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'platform'}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'hold'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'workflow-receipt-1'}),
    });
    const created=await create.json();
    assert.ok(created.task?.id,JSON.stringify(created));
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    await mf.dispatchFetch('https://feed.test/fixture/db-faults',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sqlIncludes:'UPDATE task_attempts SET handed_off_at',times:1}),
    });
    const failed=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    })).json();
    assert.equal(failed.acked,false);
    assert.equal(failed.retried,true);
    let attempt=await db.prepare('SELECT workflow_instance_id AS workflowInstanceId,state,handed_off_at AS handedOffAt FROM task_attempts WHERE task_id=?')
      .bind(created.task.id).first();
    assert.ok(attempt,`missing attempt for ${created.task.id}`);
    assert.equal(attempt.workflowInstanceId,`task-${created.task.id}-a1`);
    assert.equal(attempt.state,'starting');
    assert.equal(attempt.handedOffAt,null);

    await mf.dispatchFetch('https://feed.test/fixture/db-faults',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({reset:true}),
    });
    const replay=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    })).json();
    assert.equal(replay.acked,true);
    attempt=await db.prepare('SELECT workflow_instance_id AS workflowInstanceId,state,handed_off_at AS handedOffAt FROM task_attempts WHERE task_id=?')
      .bind(created.task.id).first();
    assert.equal(attempt.workflowInstanceId,`task-${created.task.id}-a1`);
    assert.equal(attempt.state,'running');
    assert.ok(attempt.handedOffAt);
    const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
    const id=`task-${created.task.id}-a1`;
    assert.deepEqual(workflows.calls,[
      {op:'create',id},
      {op:'create',id},
      {op:'get',id},
    ]);
  }finally{
    await mf.dispose();
  }
});

test('unknown Workflow create outcome is resolved by getting the same instance id',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/execution-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'legacy'}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/workflow-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'platform'}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/create-failures',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({times:1}),
    });
    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'hold'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'workflow-unknown-1'}),
    });
    const created=await create.json();
    assert.ok(created.task?.id,JSON.stringify(created));
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const replay=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    })).json();
    assert.equal(replay.acked,true);
    const attempt=await db.prepare('SELECT workflow_instance_id AS workflowInstanceId,state,handed_off_at AS handedOffAt FROM task_attempts WHERE task_id=?')
      .bind(created.task.id).first();
    const id=`task-${created.task.id}-a1`;
    assert.equal(attempt.workflowInstanceId,id);
    assert.equal(attempt.state,'running');
    assert.ok(attempt.handedOffAt);
    const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
    assert.deepEqual(workflows.calls,[{op:'create',id},{op:'get',id}]);
  }finally{
    await mf.dispose();
  }
});

for(const [mode,errorCode] of [['rate-limit','rate_limited'],['network','browser_transient']])test(`${mode} captures a bounded deferred retry sequence and stops after three attempts`,async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'rate-limit-1'}),
    });
    const created=await create.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'deferred');
    });
    let current=await task(db,created.task.id);
    assert.equal(current.attemptNo,1);
    assert.ok(current.dueAt>Date.now()+14*60*1000,current.dueAt);
    assert.match(current.lastError,/429|rate limit|connection closed/i);
    assert.equal(await attemptCode(db,created.task.id,1),errorCode);
    assert.equal((await scrapes(mf)).calls.length,1);

    for(let expectedAttempts of [2,3]){
      await db.prepare('UPDATE tasks SET due_at=? WHERE id=? AND attempt_no=?')
        .bind(Date.now()-1000,created.task.id,expectedAttempts-1).run();
      const recovery=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
        method:'POST',
        headers:admin.headers,
      })).json();
      assert.equal(recovery.recovered,1,JSON.stringify({
        recovery,
        task:await task(db,created.task.id),
      }));
      await waitFor(async()=>{
        const row=await task(db,created.task.id);
        assert.equal(row.attemptNo,expectedAttempts);
        assert.equal(row.state,expectedAttempts===3?'blocked':'deferred');
      });
      assert.equal((await scrapes(mf)).calls.length,expectedAttempts);
      if(expectedAttempts===2){
        const firstPayload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
        const stale=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(firstPayload),
        })).json();
        assert.equal(stale.acked,true);
        assert.equal((await scrapes(mf)).calls.length,2);
      }
    }

    current=await task(db,created.task.id);
    assert.equal(current.state,'blocked');
    assert.equal(current.attemptNo,3);
    await db.prepare('UPDATE tasks SET due_at=? WHERE id=?').bind(Date.now()-1000,created.task.id).run();
    await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
      method:'POST',
      headers:admin.headers,
    });
    await waitFor(async()=>{
      assert.equal((await scrapes(mf)).calls.length,3);
    });
  }finally{
    await mf.dispose();
  }
});

test('a skipped Archive claim defers the task instead of reporting capture success',async()=>{
  const {mf,db,admin}=await fixture({articleStatus:'collecting',leaseUntil:Date.now()+10*60*1000});
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'archive-skip-1'}),
    });
    const created=await create.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'deferred');
    });
    const current=await task(db,created.task.id);
    assert.equal(current.attemptNo,1);
    assert.ok(current.dueAt>Date.now()+30*1000);
    assert.equal(current.lastError,'Capture is busy');
    assert.equal(await attemptCode(db,created.task.id,1),'capture_busy');
    assert.equal((await scrapes(mf)).calls.length,0);
    const status=await(await mf.dispatchFetch(`https://feed.test/internal/capture-tasks/${created.task.id}`,{
      headers:admin.headers,
    })).json();
    assert.equal(status.task.state,'deferred');
    assert.equal(status.attempt.state,'deferred');
    assert.equal(status.article.status,'collecting');
  }finally{
    await mf.dispose();
  }
});

test('quota exhaustion becomes blocked instead of entering a paid retry loop',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'quota'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'quota-exhaustion-1'}),
    });
    if(create.status!==202)assert.fail(await create.text());
    const created=await create.json();
    assert.ok(created.task?.id,JSON.stringify(created));
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'blocked');
    });
    const current=await task(db,created.task.id);
    assert.equal(current.attemptNo,1);
    assert.match(current.lastError,/402|quota/i);
    assert.equal(await attemptCode(db,created.task.id,1),'quota_exhausted');
    assert.equal((await scrapes(mf)).calls.length,1);

    await db.prepare('UPDATE tasks SET due_at=? WHERE id=?').bind(Date.now()-1000,created.task.id).run();
    await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
      method:'POST',
      headers:admin.headers,
    });
    await waitFor(async()=>{
      assert.equal((await scrapes(mf)).calls.length,1);
    });
  }finally{
    await mf.dispose();
  }
});

test('start-job redelivery while running keeps the task running and the same capture in flight',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'hang'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'running-replay-1'}),
    });
    const created=await create.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'running');
    });
    assert.equal((await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).acked.includes(created.task.id),false);
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const replay=await(await mf.dispatchFetch('https://feed.test/fixture/replay',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    })).json();
    assert.equal(replay.acked,true);
    assert.equal((await task(db,created.task.id)).state,'running');
    assert.equal((await scrapes(mf)).calls.length,1);

    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'success',release:true}),
    });
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'succeeded');
    });
    assert.equal((await scrapes(mf)).calls.length,1);
    const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
    assert.equal(workflows.calls.length,0);
    await waitFor(async()=>assert.ok((await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).acked.includes(created.task.id)));
  }finally{
    await mf.dispose();
  }
});

test('provider Retry-After beyond the local backoff cap remains the earliest retry time',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'long-rate-limit'})});
    const before=Date.now();
    const response=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'provider-minimum-delay'}),
    });
    assert.equal(response.status,202);
    const created=await response.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'deferred');
    });
    assert.ok((await task(db,created.task.id)).dueAt>=before+12*60*60*1000);
    const recovery=await mf.dispatchFetch(`https://feed.test/internal/operations/tasks/${created.task.id}/recover`,{
      method:'POST',headers:admin.headers,
    });
    assert.equal(recovery.status,202);
    assert.equal((await recovery.json()).recovered,0);
    assert.equal((await task(db,created.task.id)).attemptNo,1);
    assert.equal((await scrapes(mf)).calls.length,1);
  }finally{await mf.dispose();}
});

test('a scheduled recheck executes in Queue and records an immutable replay',async()=>{
  const {mf,db,admin}=await fixture({recheckRuntime:true});
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'initial-before-recheck'}),
    });
    if(create.status!==202)assert.fail(await create.text());
    const created=await create.json();
    await waitFor(async()=>assert.equal((await task(db,created.task.id)).state,'succeeded'));
    const revision=await db.prepare('SELECT id,raw_fingerprint FROM article_revisions WHERE capture_task_id=?')
      .bind(created.task.id).first();
    assert.ok(revision);
    await db.batch([
      db.prepare(`UPDATE article_revisions SET state='ready',ready_at=? WHERE id=? AND state='assembling'`)
        .bind(Date.now(),revision.id),
      db.prepare(`UPDATE articles SET latest_ready_revision_id=?,latest_observed_revision_id=?,next_recheck_at=0 WHERE id=?`)
        .bind(revision.id,revision.id,articleId),
    ]);

    const scheduled=await mf.dispatchFetch('https://feed.test/internal/rechecks',{
      method:'POST',
      headers:{...admin.headers,'Content-Type':'application/json'},
      body:JSON.stringify({limit:1}),
    });
    if(scheduled.status!==202)assert.fail(await scheduled.text());
    const recheck=await scheduled.json();
    assert.equal(recheck.scheduled.length,1);
    await waitFor(async()=>assert.equal((await task(db,recheck.scheduled[0])).state,'succeeded'));
    const runtimeTask=await db.prepare(`SELECT kind,business_key FROM tasks WHERE id=?`).bind(recheck.scheduled[0]).first();
    assert.equal(runtimeTask.kind,'recheck');
    assert.match(runtimeTask.business_key,new RegExp(`recheck:${articleId}:0$`));
    const attempt=await db.prepare(`SELECT workflow_instance_id,state,result_json FROM task_attempts WHERE task_id=?`)
      .bind(recheck.scheduled[0]).first();
    assert.equal(attempt.workflow_instance_id,`queue-${recheck.scheduled[0]}-a1`);
    assert.equal(attempt.state,'succeeded');
    assert.equal(JSON.parse(attempt.result_json).outcome,'unchanged');
    assert.equal((await scrapes(mf)).calls.length,2);
  }finally{
    await mf.dispose();
  }
});

async function task(db,id){
  return db.prepare(`SELECT state,last_error AS lastError,checkpoint_json AS checkpoint,
    due_at AS dueAt,attempt_no AS attemptNo FROM tasks WHERE id=?`).bind(id).first();
}

async function attemptCode(db,taskId,attemptNo){
  const row=await db.prepare('SELECT error_code AS errorCode FROM task_attempts WHERE task_id=? AND attempt_no=?')
    .bind(taskId,attemptNo).first();
  return row?.errorCode??null;
}

async function scrapes(mf){
  return await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json();
}

async function workflowStatus(mf,id){
  const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
  return workflows.instances.find(instance=>instance.id===id)?.status??null;
}

test('same-site launch admission preserves task identity and attempts without a container call',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'hang'}),
    });
    const first=await createCaptureTask(mf,admin,'same-site-busy-first');
    await waitFor(async()=>assert.equal((await task(db,first)).state,'running'));
    const second=await createCaptureTask(mf,admin,'same-site-busy-second');
    const rows=await db.prepare('SELECT id,state,attempt_no AS attemptNo FROM tasks ORDER BY created_at').all();
    assert.deepEqual(rows.results.map(row=>[row.id,row.state,row.attemptNo]).at(-1),[second,'queued',1]);
    const lease=await db.prepare('SELECT owner_task_id FROM site_execution_leases').first();
    assert.equal(lease.owner_task_id,first);
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'success',release:true}),
    });
    await waitFor(async()=>assert.equal((await task(db,first)).state,'succeeded'));
    await waitFor(async()=>assert.equal((await task(db,second)).state,'succeeded'));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').bind(second).first()).n,1);
    assert.equal((await db.prepare('SELECT attempts FROM articles WHERE id=?').bind(articleId).first()).attempts,2);
  }finally{await mf.dispose();}
});

test('Queue capacity defers the exact attempt without charging a source retry',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'capacity'}),
    });
    const created=await createCaptureTask(mf,admin,'platform-capacity-wait');
    await waitFor(async()=>{
      const lease=await db.prepare('SELECT owner_task_id,lease_until FROM site_execution_leases').first();
      assert.ok(lease);assert.equal(lease.owner_task_id,null);assert.equal(lease.lease_until,0);
    });
    assert.equal((await task(db,created)).attemptNo,1);
    const attempt=await db.prepare(`SELECT workflow_instance_id AS id,state FROM task_attempts WHERE task_id=?`).bind(created).first();
    assert.equal(attempt.id,`queue-${created}-a1`);
    assert.equal(attempt.state,'deferred');
    assert.equal((await db.prepare('SELECT attempts FROM articles WHERE id=?').bind(articleId).first()).attempts,0);
    const scrapes=await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json();
    assert.equal(scrapes.calls.length,1);
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'success'}),
    });
    await db.prepare('UPDATE tasks SET due_at=0 WHERE id=?').bind(created).run();
    await db.prepare("UPDATE outbox SET available_at=0 WHERE dedupe_key=?").bind(`start:${created}:a1`).run();
    await mf.dispatchFetch('https://feed.test/fixture/recover');
    await waitFor(async()=>assert.equal((await task(db,created)).state,'succeeded'));
    assert.equal((await task(db,created)).attemptNo,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').bind(created).first()).n,1);
    assert.equal((await db.prepare('SELECT attempts FROM articles WHERE id=?').bind(articleId).first()).attempts,1);
  }finally{await mf.dispose();}
});

test('cutover resumes a capacity-queued Queue attempt in Workflow without a new business attempt',async()=>{
  const {mf,db,admin}=await fixture({queueConsumer:false});
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'capacity'})});
    const id=await createCaptureTask(mf,admin,'cutover-capacity');
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const deliver=()=>mf.dispatchFetch('https://feed.test/fixture/replay',{method:'POST',body:JSON.stringify(payload)}).then(r=>r.json());
    assert.deepEqual(await deliver(),{acked:true,retried:false});
    let current=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/'+id,{headers:admin.headers})).json();
    assert.equal(current.task.state,'queued');
    assert.equal(current.attempt.state,'deferred');
    assert.equal(current.attempt.workflowInstanceId,`queue-${id}-a1`);
    await mf.dispatchFetch('https://feed.test/fixture/execution-mode',{method:'POST',body:JSON.stringify({mode:'workflow'})});
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'success'})});
    await db.prepare('UPDATE tasks SET due_at=0 WHERE id=?').bind(id).run();
    // Capacity has been recorded, but the old invocation has not finished releasing its site.
    await db.prepare('UPDATE site_execution_leases SET owner_task_id=?,owner_attempt_no=1,acquired_at=1,lease_until=?').bind(id,Date.now()+60_000).run();
    assert.deepEqual(await deliver(),{acked:false,retried:true});
    assert.equal((await task(db,id)).state,'queued');
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json()).instances,[]);
    await db.prepare('UPDATE site_execution_leases SET owner_task_id=NULL,owner_attempt_no=NULL,acquired_at=NULL,lease_until=0,generation=generation+1').run();
    await Promise.all([deliver(),deliver()]);
    await waitFor(async()=>{
      current=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/'+id,{headers:admin.headers})).json();
      assert.equal(current.task.state,'succeeded');
    });
    assert.equal(current.task.attemptNo,1);
    assert.equal(current.attempt.workflowInstanceId,`task-${id}-a1`);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').bind(id).first()).n,1);
    assert.equal((await scrapes(mf)).calls.length,2,'one capacity refusal and one successful capture');
    assert.equal((await db.prepare('SELECT attempts FROM articles WHERE id=?').bind(articleId).first()).attempts,1);
    assert.deepEqual(await deliver(),{acked:true,retried:false});
    assert.equal((await scrapes(mf)).calls.length,2,'completed work is not captured again');
  }finally{await mf.dispose();}
});

test('cutover can redeliver a failed Workflow launch after a processed Queue capacity receipt',async()=>{
  const {mf,db,admin}=await fixture({queueConsumer:false});
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'capacity'})});
    const id=await createCaptureTask(mf,admin,'cutover-launch-outage');
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const deliver=()=>mf.dispatchFetch('https://feed.test/fixture/replay',{method:'POST',body:JSON.stringify(payload)}).then(r=>r.json());
    assert.deepEqual(await deliver(),{acked:true,retried:false});
    await mf.dispatchFetch('https://feed.test/fixture/execution-mode',{method:'POST',body:JSON.stringify({mode:'workflow'})});
    await mf.dispatchFetch('https://feed.test/fixture/workflow-mode',{method:'POST',body:JSON.stringify({mode:'unavailable'})});
    await db.prepare('UPDATE tasks SET due_at=0 WHERE id=?').bind(id).run();
    await db.prepare("UPDATE outbox SET available_at=0 WHERE topic='feed-jobs'").run();
    await mf.dispatchFetch('https://feed.test/fixture/recover');
    assert.deepEqual(await deliver(),{acked:false,retried:true});
    assert.equal((await db.prepare('SELECT state FROM outbox_receipts WHERE outbox_id=?').bind(payload.outboxId).first()).state,'failed');
    await db.prepare('UPDATE outbox SET updated_at=? WHERE id=?').bind(Date.now()-16*60_000,payload.outboxId).run();
    const recovery=await(await mf.dispatchFetch('https://feed.test/fixture/recover')).json();
    assert.deepEqual(recovery.dispatched,[payload.outboxId],'a lost launch still has a recoverable handoff');
    await mf.dispatchFetch('https://feed.test/fixture/workflow-mode',{method:'POST',body:JSON.stringify({mode:'run'})});
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'success'})});
    assert.deepEqual(await deliver(),{acked:true,retried:false});
    assert.equal((await task(db,id)).state,'succeeded');
    assert.equal((await task(db,id)).attemptNo,1);
  }finally{await mf.dispose();}
});

test('cutover leaves an in-flight Queue owner alone until its saved result is complete',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'hang'})});
    const id=await createCaptureTask(mf,admin,'cutover-live-owner');
    await waitFor(async()=>assert.equal((await scrapes(mf)).calls.length,1));
    await mf.dispatchFetch('https://feed.test/fixture/execution-mode',{method:'POST',body:JSON.stringify({mode:'workflow'})});
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const replay=await mf.dispatchFetch('https://feed.test/fixture/replay',{method:'POST',body:JSON.stringify(payload)});
    assert.deepEqual(await replay.json(),{acked:true,retried:false});
    const recovery=await mf.dispatchFetch('https://feed.test/internal/operations/tasks/'+id+'/recover',{method:'POST',headers:admin.headers});
    assert.equal((await recovery.json()).recovered,0);
    assert.equal((await task(db,id)).state,'running');
    assert.deepEqual((await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json()).instances,[]);
    assert.equal((await scrapes(mf)).calls.length,1);
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'success'})});
    await waitFor(async()=>assert.equal((await task(db,id)).state,'succeeded'));
    const status=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/'+id,{headers:admin.headers})).json();
    assert.equal(status.attempt.workflowInstanceId,`queue-${id}-a1`);
    assert.equal(status.task.attemptNo,1);
  }finally{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'success'})});
    await mf.dispose();
  }
});

test('cutover returns a launch to Queue when its old owner defers after the task was read',async()=>{
  const {mf,db,admin}=await fixture({queueConsumer:false});
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
    const id=await createCaptureTask(mf,admin,'cutover-concurrent-capacity');
    const payload=(await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json()).sends[0];
    const at=Date.now();
    await db.prepare("UPDATE tasks SET state='running' WHERE id=?").bind(id).run();
    await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,handed_off_at)
      VALUES (?,1,?,'running',?,?)`).bind(id,`queue-${id}-a1`,at,at).run();
    let deferred=false;
    const raceDb={prepare(sql){
      const wrap=statement=>new Proxy(statement,{get(target,key){
        if(key==='bind')return (...args)=>wrap(target.bind(...args));
        if(key==='first')return async(...args)=>{
          const row=await target.first(...args);
          if(!deferred&&row?.id===id&&row.kind==='capture'&&row.state==='running'){
            deferred=true;
            await db.batch([
              db.prepare("UPDATE tasks SET state='queued',due_at=? WHERE id=?").bind(at+120_000,id),
              db.prepare("UPDATE task_attempts SET state='deferred' WHERE task_id=?").bind(id),
            ]);
          }
          return row;
        };
        const value=Reflect.get(target,key);
        return typeof value==='function'?value.bind(target):value;
      }});
      return wrap(db.prepare(sql));
    },batch:statements=>db.batch(statements)};
    const {handleFeedJobs}=await taskRuntimeModule();
    let acked=false;
    const retries=[],workflows=[];
    await handleFeedJobs({messages:[{body:payload,attempts:1,ack(){acked=true;},retry(options){retries.push(options);}}]},
      {DB:raceDb,COLLECTION_EXECUTOR:'workflow'},{now:()=>at,workflow:{async create(input){workflows.push(input);throw new Error('Unexpected Workflow');}}});
    assert.equal(deferred,true);
    assert.equal(acked,false);
    assert.deepEqual(retries,[{delaySeconds:120}]);
    assert.deepEqual(workflows,[]);
    assert.equal((await task(db,id)).state,'queued');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM outbox_receipts').first()).n,0);
  }finally{await mf.dispose();}
});

test('launch recovery rechecks current task and delivery facts at its atomic write',async t=>{
  const {createTaskRuntime}=await taskRuntimeModule();
  const changes={
    'new planned start':(db,id,at)=>db.prepare('UPDATE tasks SET due_at=? WHERE id=?').bind(at+48*60_000,id).run(),
    'confirmed handoff':async(db,id,at)=>{
      const launch=await db.prepare("SELECT payload_json FROM outbox WHERE topic='feed-jobs'").first();
      await createTaskRuntime({DB:db,COLLECTION_EXECUTOR:'workflow',CAPTURE:{async create(){return {async status(){return {status:'queued'};}};}}},{now:()=>at})
        .startJob(JSON.parse(launch.payload_json));
    },
    'processed receipt':(db,id,at)=>db.prepare(`INSERT INTO outbox_receipts(outbox_id,topic,state,created_at,updated_at)
      SELECT id,topic,'processed',?,? FROM outbox WHERE topic='feed-jobs'`).bind(at,at).run(),
    'recent send':(db,id,at)=>db.prepare("UPDATE outbox SET updated_at=? WHERE topic='feed-jobs'").bind(at).run(),
    'recent replay':(db,id,at)=>db.prepare(`INSERT INTO outbox_receipts(outbox_id,topic,state,last_replayed_at,created_at,updated_at)
      SELECT id,topic,'queued',?,?,? FROM outbox WHERE topic='feed-jobs'`).bind(at,at,at).run(),
    'superseded attempt':(db,id)=>db.prepare('UPDATE tasks SET attempt_no=2 WHERE id=?').bind(id).run(),
    'completed task':(db,id)=>db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").bind(id).run(),
  };
  for(const mode of ['manual','automatic requeue','automatic exhausted'])for(const [name,change] of Object.entries(changes))await t.test(mode+': '+name,async()=>{
    const {mf,db,admin}=await fixture({queueConsumer:false});
    try{
      await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
      const id=await createCaptureTask(mf,admin,'manual-recovery-race');
      const at=Date.now();
      await db.prepare("UPDATE outbox SET updated_at=? WHERE topic='feed-jobs'").bind(at-16*60_000).run();
      await db.prepare('UPDATE tasks SET due_at=? WHERE id=?').bind(at-16*60_000,id).run();
      const attempts=mode==='automatic exhausted'?5:1;
      await db.prepare("UPDATE outbox SET attempts=? WHERE topic='feed-jobs'").bind(attempts).run();
      let raced=false;
      const beforeWrite=async()=>{
        if(raced)return;
        raced=true;
        await change(db,id,at);
      };
      const raceDb={
        prepare(sql){
          const wrap=statement=>new Proxy(statement,{get(target,key){
            if(key==='bind')return (...args)=>wrap(target.bind(...args));
            if(['run','all','first','raw'].includes(key))return async(...args)=>{
              if(/^\s*(?:UPDATE|INSERT|DELETE)/i.test(sql))await beforeWrite();
              return target[key](...args);
            };
            return Reflect.get(target,key);
          }});
          return wrap(db.prepare(sql));
        },
        async batch(statements){await beforeWrite();return db.batch(statements);},
      };
      const sends=[];
      const runtime=createTaskRuntime({DB:raceDb,CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true',CAPTURE:{async get(){return {async status(){return {status:'queued'};}};}}},{now:()=>at,queue:{async send(...args){sends.push(args);}}});
      const result=await (mode==='manual'?runtime.recoverTask(id):runtime.recover());
      assert.equal(raced,true,'delivery facts change after the initial read and before its first write');
      assert.equal(result.recovered,0);
      assert.deepEqual(sends,[]);
      const outbox=await db.prepare("SELECT state,attempts FROM outbox WHERE topic='feed-jobs'").first();
      assert.deepEqual(outbox,{state:'sent',attempts});
      assert.notEqual((await task(db,id)).state,'blocked');
      if(name==='confirmed handoff')assert.equal((await task(db,id)).state,'starting');
    }finally{await mf.dispose();}
  });
});

test('automatic and manual launch recovery share one send reservation while Queue acknowledgement is pending',async t=>{
  for(const automatic of [false,true])await t.test(automatic?'automatic first':'manual first',async()=>{
  const {mf,db,admin}=await fixture({queueConsumer:false});
  let release,first;
  const pending=new Promise(resolve=>{release=resolve;});
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{method:'POST',body:JSON.stringify({mode:'hold'})});
    const id=await createCaptureTask(mf,admin,'manual-recovery-reservation');
    const at=Date.now(),old=at-16*60_000;
    await db.batch([
      db.prepare("UPDATE outbox SET updated_at=? WHERE topic='feed-jobs'").bind(old),
      db.prepare('UPDATE tasks SET due_at=? WHERE id=?').bind(old,id),
    ]);
    const {createTaskRuntime}=await taskRuntimeModule();
    const sends=[];
    const runtime=createTaskRuntime({DB:db,CRAWL_ENABLED:'true',TASK_RUNTIME_ENABLED:'true'},{now:()=>at,queue:{
      async send(body){sends.push(body);if(sends.length===1)await pending;},
    }});
    first=automatic?runtime.recover():runtime.recoverTask(id);
    await waitFor(async()=>assert.equal(sends.length,1));
    const second=await runtime.recoverTask(id);
    assert.deepEqual((await runtime.recover()).dispatched,[]);
    const replay=await mf.dispatchFetch('https://feed.test/internal/operations/replay',{method:'POST',headers:{...admin.headers,'Content-Type':'application/json'},body:JSON.stringify({outboxId:sends[0].outboxId,topic:'feed-jobs'})});
    assert.equal(replay.status,409,'manual replay shares the current delivery grace window');
    release();
    const completed=await first;
    assert.equal(automatic?completed.dispatched.length:completed.recovered,1);
    assert.equal(second.recovered,0);
    assert.equal(sends.length,1);
    assert.equal((await runtime.recoverTask(id)).recovered,0,'the acknowledgement starts another delivery grace window');
  }finally{release();await first;await mf.dispose();}
  });
});

test('Queue crash recovery waits for expiry, preserves backoff and stops after three attempts',async()=>{
  const {mf,db,admin}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'hold'}),
    });
    const taskId=await createCaptureTask(mf,admin,'queue-crash-recovery');
    for(const attempt of [1,2,3]){
      const started=Date.now()-14*60*1000;
      await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,handed_off_at)
        VALUES (?,?,?,'running',?,?)`).bind(taskId,attempt,`queue-${taskId}-a${attempt}`,started,started).run();
      await db.prepare("UPDATE tasks SET state='running' WHERE id=?").bind(taskId).run();
      await mf.dispatchFetch('https://feed.test/fixture/recover');
      assert.equal((await task(db,taskId)).state,'running','a live Queue invocation keeps its attempt');
      await db.prepare('UPDATE task_attempts SET started_at=? WHERE task_id=? AND attempt_no=?')
        .bind(Date.now()-16*60*1000,taskId,attempt).run();
      await mf.dispatchFetch('https://feed.test/fixture/recover');
      const expired=await task(db,taskId);
      assert.equal(expired.state,attempt===3?'blocked':'deferred');
      assert.equal(expired.attemptNo,attempt);
      assert.equal(await attemptCode(db,taskId,attempt),'queue_execution_timeout');
      if(attempt<3){
        assert.ok(expired.dueAt>Date.now());
        await mf.dispatchFetch('https://feed.test/fixture/recover');
        assert.equal((await task(db,taskId)).attemptNo,attempt,'timeout recovery honors backoff');
        await db.prepare('UPDATE tasks SET due_at=0 WHERE id=?').bind(taskId).run();
        await mf.dispatchFetch('https://feed.test/fixture/recover');
        assert.equal((await task(db,taskId)).state,'queued');
        assert.equal((await task(db,taskId)).attemptNo,attempt+1);
      }
    }
    await mf.dispatchFetch('https://feed.test/fixture/recover');
    assert.equal((await task(db,taskId)).attemptNo,3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').bind(taskId).first()).n,3);
  }finally{await mf.dispose();}
});

async function createCaptureTask(mf,admin,requestId){
  const response=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
    method:'POST',headers:{...admin.headers,'Content-Type':'application/json'},
    body:JSON.stringify({articleId,requestId}),
  });
  const body=await response.json();
  assert.equal(response.status,202,JSON.stringify(body));
  return body.task.id;
}

async function waitFor(check){
  let lastError;
  for(let i=0;i<80;i++){
    try{
      await check();
      return;
    }catch(error){
      lastError=error;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  throw lastError;
}

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|WITH|PRAGMA|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}

let runtimeModulePromise;
function taskRuntimeModule(){
  return runtimeModulePromise??=build({entryPoints:['worker/task-runtime.mjs'],bundle:true,write:false,format:'esm',platform:'node',plugins:[workersPlugin]})
    .then(bundle=>import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`));
}
