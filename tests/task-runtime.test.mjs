import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const articleId='1234567890abcdef12345678';
const articleUrl='https://jwc.cqu.edu.cn/info/1082/1.htm';

const workersPlugin={
  name:'task-runtime-workers-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'task-runtime-workers-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'task-runtime-workers-stub'},()=>({
      loader:'js',
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

const firecrawlPlugin={
  name:'task-runtime-firecrawl-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/\.\/firecrawl\.mjs$/},()=>({path:'firecrawl',namespace:'task-runtime-firecrawl-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'task-runtime-firecrawl-stub'},()=>({
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
            metadata:{statusCode:200,creditsUsed:1,proxyUsed:true},
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
          if(mode==='rate-limit')throw new Error('Firecrawl HTTP 429: rate limit exceeded');
          if(mode==='long-rate-limit'){
            const error=new Error('Firecrawl HTTP 429: rate limit exceeded');
            error.retryAfterMs=12*60*60*1000;
            throw error;
          }
          if(mode==='quota')throw new Error('Firecrawl HTTP 402: quota exhausted');
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
}={}){
  const bundle=await build({
    stdin:{
      contents:`
        import worker from './worker/index.mjs';
        import {apiRoute} from './worker/api.mjs';
        import {createTaskRuntime,handleFeedJobs} from './worker/task-runtime.mjs';
        import {CaptureWorkflow} from './worker/capture-workflow.mjs';
        import {workflowStep as step} from './tests/helpers/workflow-step.mjs';

        globalThis.TASK_RUNTIME_QUEUE_BODIES=[];
        globalThis.TASK_RUNTIME_WORKFLOW_CALLS=[];
        globalThis.TASK_RUNTIME_QUEUE_SENDS=[];
        globalThis.TASK_RUNTIME_QUEUE_MODE='real';
        globalThis.TASK_RUNTIME_DB_FAULTS={sqlIncludes:'',times:0,error:'Injected D1 failure'};
        globalThis.TASK_RUNTIME_CREATE_FAILURES_REMAINING=0;
        globalThis.TASK_RUNTIME_PLATFORM_STATUS='business';
        globalThis.TASK_RUNTIME_WORKFLOW_MODE='run';
        globalThis.TASK_RUNTIME_ACTIVE_WORKFLOWS=[];
        const instances=new Map();
        const instance=id=>{
          if(!instances.has(id))throw new Error('Workflow instance not found');
          return {id,status:async()=>({status:instances.get(id).status,error:instances.get(id).error})};
        };
        const workflow={
          async create({id,params}){
            globalThis.TASK_RUNTIME_WORKFLOW_CALLS.push({op:'create',id});
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
          const env={...rawEnv,DB:instrumentDb(rawEnv.DB),CAPTURE:workflow,FEED_JOBS:{
            async send(body,options){
              if(globalThis.TASK_RUNTIME_QUEUE_MODE==='fail')throw new Error('Injected queue send failure');
              globalThis.TASK_RUNTIME_QUEUE_SENDS.push(body);
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
              sends:globalThis.TASK_RUNTIME_QUEUE_SENDS,
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
            const message={body,attempt:1,ack(){acked=true;},retry(){retried=true;}};
            await handleFeedJobs({messages:[message]},env,{workflow});
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
            });
            if(url.pathname.startsWith('/api/'))return apiRoute(request,env);
            return worker.fetch(request,env);
          },
          async queue(batch,rawEnv){
            const env=prepareEnv(rawEnv);
            for(const message of batch.messages)globalThis.TASK_RUNTIME_QUEUE_BODIES.push(message.body);
            await handleFeedJobs(batch,env,{workflow});
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
    plugins:[workersPlugin,firecrawlPlugin],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,
    script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',
    compatibilityFlags:['nodejs_compat'],
    bindings:{
      ADMIN_TOKEN:'test-admin-token',
      BASE_URL:'https://feed.test',
      BRIDGE_SECRET:'test-bridge-secret',
      CRAWL_ENABLED:String(crawlEnabled),
      PDF_OCR_ENABLED:'false',
      TASK_RUNTIME_ENABLED:String(runtimeEnabled),
      ...(recheckRuntime?{ARCHIVE_VERSIONS_ENABLED:'true'}:{}),
    },
    d1Databases:['DB'],
    r2Buckets:['ARCHIVE'],
    queueProducers:{FEED_JOBS:{queueName:'feed-jobs'}},
    queueConsumers:{'feed-jobs':{maxBatchSize:1,maxRetries:3,deadLetterQueue:'feed-jobs-dlq'}},
  }));
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql',
    ...(recheckRuntime?['0007_archive_versions.sql','0008_content_events.sql','0017_archive_recheck.sql']:[]),
    '0018_outbox_receipts.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await db.prepare("INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.cqu.edu.cn/')").run();
  await db.prepare("INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,attempts,lease_until) VALUES (?,'jwc',?,'队列采集通知','2026-10-10','2026-10-11',?,?,?)")
    .bind(articleId,articleUrl,articleStatus,articleAttempts,leaseUntil).run();
  return {mf,db,bucket};
}

test('admin capture task survives queue handoff and archives one article for reading',async()=>{
  const {mf,db,bucket}=await fixture();
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'manual-20261012-1'}),
    });
    if(create.status!==202)assert.fail(await create.text());
    const created=await create.json();
    assert.equal(created.task.state,'queued');
    assert.equal(created.task.articleId,articleId);
    assert.equal(created.duplicate,false);

    const duplicate=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.equal(status.task.state,'succeeded');
    assert.equal(status.attempt.workflowInstanceId,`task-${created.task.id}-a1`);
    assert.equal(status.attempt.state,'succeeded');
    assert.equal(status.article.status,'complete');

    const queue=await(await mf.dispatchFetch('https://feed.test/fixture/queue')).json();
    assert.deepEqual(queue.messages,[payload]);
    const scrapes=await(await mf.dispatchFetch('https://feed.test/fixture/scrapes')).json();
    assert.deepEqual(scrapes.calls,[articleUrl]);
    const workflows=await(await mf.dispatchFetch('https://feed.test/fixture/workflows')).json();
    assert.deepEqual(workflows.calls,[{op:'create',id:`task-${created.task.id}-a1`}]);

    const reading=await(await mf.dispatchFetch('https://feed.test/api/articles?q='+encodeURIComponent('中文正文'))).json();
    assert.deepEqual(reading.articles.map(row=>row.id),[articleId]);
    const article=await db.prepare('SELECT prefix,snapshot_key FROM articles WHERE id=?').bind(articleId).first();
    const snapshot=await bucket.get(article.snapshot_key);
    assert.match(await snapshot.text(),/队列采集通知/);
    const manifest=await(await bucket.get(`${article.prefix}/manifest.json`)).json();
    assert.equal(manifest.status,'complete');
  }finally{
    await mf.dispose();
  }
});

test('admin capture task entrance rejects missing or invalid admin tokens independently of feed session',async()=>{
  const {mf}=await fixture();
  try{
    for(const headers of [
      {'Content-Type':'application/json'},
      {Authorization:'Bearer wrong-admin-token','Content-Type':'application/json'},
      {Authorization:'Bearer wrong-admin-token','Content-Type':'application/json',Cookie:'__Host-feed_session=feed-reader-session'},
    ]){
      const response=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
        method:'POST',
        headers,
        body:JSON.stringify({articleId,requestId:'auth-check-1'}),
      });
      assert.equal(response.status,401);
      assert.equal((await response.json()).error,'Unauthorized');
    }
  }finally{
    await mf.dispose();
  }
});

test('capture task creation stays disabled by default while authenticated status reads remain available',async()=>{
  const {mf,db}=await fixture({runtimeEnabled:false,crawlEnabled:false});
  try{
    const disabled=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'disabled-1'}),
    });
    assert.equal(disabled.status,503);
    assert.equal((await disabled.json()).error,'Capture task runtime is disabled');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tasks').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first()).n,0);

    const list=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(list.status,200);
    assert.deepEqual(await list.json(),{tasks:[]});
  }finally{
    await mf.dispose();
  }
});

test('capture task committed before queue enrollment is recovered by dispatching the same outbox',async()=>{
  const {mf,db}=await fixture();
  try{
    const mode=await(await mf.dispatchFetch('https://feed.test/fixture/queue',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'fail'}),
    })).json();
    assert.equal(mode.mode,'fail');
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token'},
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
  const {mf,db}=await fixture();
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
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token'},
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

test('Workflow create receipt failure replays with the same instance instead of creating a random one',async()=>{
  const {mf,db}=await fixture();
  try{
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
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
  const {mf,db}=await fixture();
  try{
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
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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

test('429 captures a bounded deferred retry sequence and stops after three attempts',async()=>{
  const {mf,db}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'rate-limit'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'rate-limit-1'}),
    });
    const created=await create.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'deferred');
    });
    await waitFor(async()=>{
      assert.equal(await workflowStatus(mf,`task-${created.task.id}-a1`),'complete');
    });
    let current=await task(db,created.task.id);
    assert.equal(current.attemptNo,1);
    assert.ok(current.dueAt>Date.now()+14*60*1000,current.dueAt);
    assert.match(current.lastError,/429|rate limit/i);
    assert.equal(await attemptCode(db,created.task.id,1),'rate_limited');
    assert.equal((await scrapes(mf)).calls.length,1);

    for(let expectedAttempts of [2,3]){
      await db.prepare('UPDATE tasks SET due_at=? WHERE id=? AND attempt_no=?')
        .bind(Date.now()-1000,created.task.id,expectedAttempts-1).run();
      const recovery=await(await mf.dispatchFetch('https://feed.test/internal/capture-tasks/recover',{
        method:'POST',
        headers:{Authorization:'Bearer test-admin-token'},
      })).json();
      assert.equal(recovery.recovered,1,JSON.stringify({
        recovery,
        task:await task(db,created.task.id),
        workflow:await workflowStatus(mf,`task-${created.task.id}-a${expectedAttempts-1}`),
      }));
      await waitFor(async()=>{
        const row=await task(db,created.task.id);
        assert.equal(row.attemptNo,expectedAttempts);
        assert.equal(row.state,expectedAttempts===3?'blocked':'deferred');
      });
      await waitFor(async()=>{
        assert.equal(await workflowStatus(mf,`task-${created.task.id}-a${expectedAttempts}`),'complete');
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
      headers:{Authorization:'Bearer test-admin-token'},
    });
    await waitFor(async()=>{
      assert.equal((await scrapes(mf)).calls.length,3);
    });
  }finally{
    await mf.dispose();
  }
});

test('a skipped Archive claim defers the task instead of reporting capture success',async()=>{
  const {mf,db}=await fixture({articleStatus:'collecting',leaseUntil:Date.now()+10*60*1000});
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token'},
    })).json();
    assert.equal(status.task.state,'deferred');
    assert.equal(status.attempt.state,'deferred');
    assert.equal(status.article.status,'collecting');
  }finally{
    await mf.dispose();
  }
});

test('quota exhaustion becomes blocked instead of entering a paid retry loop',async()=>{
  const {mf,db}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'quota'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token'},
    });
    await waitFor(async()=>{
      assert.equal((await scrapes(mf)).calls.length,1);
    });
  }finally{
    await mf.dispose();
  }
});

test('start-job redelivery while running keeps the task running and the same capture in flight',async()=>{
  const {mf,db}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:'hang'}),
    });
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'running-replay-1'}),
    });
    const created=await create.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'running');
    });
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
    assert.equal(workflows.calls.filter(call=>call.op==='create').length,1);
  }finally{
    await mf.dispose();
  }
});

test('provider Retry-After beyond the local backoff cap remains the earliest retry time',async()=>{
  const {mf,db}=await fixture();
  try{
    await mf.dispatchFetch('https://feed.test/fixture/scrape-mode',{method:'POST',body:JSON.stringify({mode:'long-rate-limit'})});
    const before=Date.now();
    const response=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({articleId,requestId:'provider-minimum-delay'}),
    });
    assert.equal(response.status,202);
    const created=await response.json();
    await waitFor(async()=>{
      assert.equal((await task(db,created.task.id)).state,'deferred');
      assert.equal(await workflowStatus(mf,`task-${created.task.id}-a1`),'complete');
    });
    assert.ok((await task(db,created.task.id)).dueAt>=before+12*60*60*1000);
    const recovery=await mf.dispatchFetch(`https://feed.test/internal/operations/tasks/${created.task.id}/recover`,{
      method:'POST',headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(recovery.status,202);
    assert.equal((await recovery.json()).recovered,0);
    assert.equal((await task(db,created.task.id)).attemptNo,1);
    assert.equal((await scrapes(mf)).calls.length,1);
  }finally{await mf.dispose();}
});

test('a scheduled recheck launches the existing CaptureWorkflow and records an immutable replay',async()=>{
  const {mf,db}=await fixture({recheckRuntime:true});
  try{
    const create=await mf.dispatchFetch('https://feed.test/internal/capture-tasks',{
      method:'POST',
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
      headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
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
    assert.equal(attempt.workflow_instance_id,`task-${recheck.scheduled[0]}-a1`);
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
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}
