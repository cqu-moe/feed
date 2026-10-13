import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const now=Date.now();
const ids={
  article:'aaaaaaaaaaaaaaaaaaaaaaaa',
  captureTask:'bbbbbbbbbbbbbbbbbbbbbbbb',
  discoverTask:'cccccccccccccccccccccccc',
  matchTask:'dddddddddddddddddddddddd',
  revision:'eeeeeeeeeeeeeeeeeeeeeeee',
  event:'111111111111111111111111',
  delivery:'222222222222222222222222',
  mailMessage:'333333333333333333333333',
  jobOutbox:'444444444444444444444444',
  eventOutbox:'555555555555555555555555',
  mailOutbox:'666666666666666666666666',
  queuedOutbox:'777777777777777777777777',
  activeTask:'888888888888888888888888',
  launchTask:'999999999999999999999999',
  launchOutbox:'abababababababababababab',
};
const hashes={
  artifact:'a'.repeat(64),
  manifest:'b'.repeat(64),
  raw:'c'.repeat(64),
  semantic:'d'.repeat(64),
  mailPayload:'e'.repeat(64),
  recipient:'f'.repeat(64),
};
const topics=['feed-jobs','feed-events','feed-mail'];

const workflowStub={
  name:'operations-workflow-stub',
  setup(buildApi){
    buildApi.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-workers',namespace:'operations-workflow-stub'}));
    buildApi.onLoad({filter:/.*/,namespace:'operations-workflow-stub'},()=>({
      loader:'js',
      contents:'export class WorkflowEntrypoint{constructor(env={}){this.env=env;}}',
    }));
  },
};

async function fixture({bindings={}}={}){
  const bundle=await build({
    stdin:{contents:`import worker from './worker/index.mjs';
      import {handleFeedJobs} from './worker/task-runtime.mjs';
      globalThis.OPERATIONS_QUEUE_SENDS={};
      globalThis.OPERATIONS_WORKFLOW_STATUS='waiting';
      globalThis.OPERATIONS_NOW=${now};
      let statusBarrier=0,statusWaiters=[];
      globalThis.OPERATIONS_QUEUE_MODE='normal';
      const workflow={
        async get(id){
          if(id!=='task-${ids.activeTask}-a1')throw new Error('Workflow instance not found');
          if(globalThis.OPERATIONS_WORKFLOW_STATUS==='unavailable')throw new Error('Workflow status unavailable');
          return {id,status:async()=>{
            if(statusBarrier)await new Promise(resolve=>{
              statusWaiters.push(resolve);
              if(statusWaiters.length===statusBarrier){statusBarrier=0;statusWaiters.splice(0).forEach(done=>done());}
            });
            return {status:globalThis.OPERATIONS_WORKFLOW_STATUS,error:null};
          }};
        },
      };
      function wrap(rawEnv,name){
        const actual=rawEnv[name];
        return {
          async send(body){
            globalThis.OPERATIONS_QUEUE_SENDS[name]??=[];
            globalThis.OPERATIONS_QUEUE_SENDS[name].push(body);
            if(globalThis.OPERATIONS_QUEUE_MODE.startsWith('consume')){
              await handleFeedJobs({messages:[{body,attempts:1,ack(){},retry(){throw new Error('Consumer retried');}}]},rawEnv);
            }
            if(globalThis.OPERATIONS_QUEUE_MODE.endsWith('fail'))throw new Error('Queue response lost');
            return await actual.send(body,{contentType:'json'});
          },
        };
      }
      export default {
        async fetch(request,rawEnv){
          const env={...rawEnv,CAPTURE:workflow,
            FEED_JOBS:wrap(rawEnv,'FEED_JOBS'),
            FEED_EVENTS:wrap(rawEnv,'FEED_EVENTS'),
            FEED_MAIL:wrap(rawEnv,'FEED_MAIL')};
          const url=new URL(request.url);
          if(url.pathname==='/fixture/queue-sends')return Response.json(globalThis.OPERATIONS_QUEUE_SENDS);
          if(url.pathname==='/fixture/clock'){
            if(request.method==='POST')globalThis.OPERATIONS_NOW=Date.parse((await request.json()).at);
            return Response.json({at:new Date(globalThis.OPERATIONS_NOW).toISOString()});
          }
          if(url.pathname==='/fixture/queue-mode'){
            globalThis.OPERATIONS_QUEUE_MODE=(await request.json()).mode;
            return Response.json({ok:true});
          }
          if(url.pathname==='/fixture/workflow-status'){
            if(request.method==='POST'){
              const body=await request.json();
              globalThis.OPERATIONS_WORKFLOW_STATUS=body.status;
              statusBarrier=body.barrier??0;
            }
            return Response.json({status:globalThis.OPERATIONS_WORKFLOW_STATUS});
          }
          if(url.pathname==='/internal/operations/diagnostics'){
            const nativeDateNow=Date.now;
            Date.now=()=>globalThis.OPERATIONS_NOW;
            try{return await worker.fetch(request,env);}
            finally{Date.now=nativeDateNow;}
          }
          return worker.fetch(request,env);
        },
      };`,
      resolveDir:process.cwd(),
      sourcefile:'operations-fixture.mjs',
    },
    bundle:true,write:false,format:'esm',platform:'browser',external:['node:buffer','node:*'],
    plugins:[workflowStub],
  });
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
    bindings:{ADMIN_TOKEN:'test-admin-token',TASK_RUNTIME_ENABLED:'true',CRAWL_ENABLED:'true',MAX_TASK_ATTEMPTS:'3',...bindings},
    d1Databases:['DB'],r2Buckets:['ARCHIVE'],
    queueProducers:{
      FEED_JOBS:{queueName:'feed-jobs'},
      FEED_EVENTS:{queueName:'feed-events'},
      FEED_MAIL:{queueName:'feed-mail'},
    },
  }));
  const db=await mf.getD1Database('DB');
  for(const name of ['0001_feed.sql','0003_collection_lease.sql','0004_pdf_ocr.sql','0005_task_runtime.sql',
    '0006_sources.sql','0007_archive_versions.sql','0008_content_events.sql','0009_subscriptions.sql',
    '0010_subscription_editing.sql','0011_archive_migration.sql','0013_notification_matching.sql',
    '0014_mail_delivery.sql','0015_history_backfill.sql','0016_mail_digests.sql','0018_outbox_receipts.sql']){
    await applyMigration(db,await readFile(`migrations/${name}`,'utf8'));
  }
  await seed(db);
  return {mf,db};
}

async function seed(db){
  const old=now-2*60*60*1000;
  const stale=now-16*60_000;
  const statements=[
    db.prepare(`INSERT INTO sources(id,name,url) VALUES ('jwc','教务处','https://jwc.example.test/source?token=secret-token')`),
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
      VALUES (?,'jwc','https://jwc.example.test/article?token=secret-token','诊断链路通知','2026-10-12','2026-10-12','partial')`)
      .bind(ids.article),
    db.prepare(`INSERT INTO usage(day,kind,used) VALUES ('2026-10-12','firecrawl',3)`),
    db.prepare(`INSERT INTO usage(day,kind,used) VALUES ('2026-10-12','archive_bytes',268435456)`),
    db.prepare(`INSERT INTO pdf_ocr_usage(period,reserved_pages,processed_pages,estimated_usd)
      VALUES ('2026-10',5,5,0.25),('2026-10-11',2,2,0.10),('2026-10-12',3,3,0.15)`),
    db.prepare(`INSERT INTO pdf_ocr_budget(id,day,month,day_pages,month_pages) VALUES (1,?,?,3,5)`)
      .bind(new Date(now).toISOString().slice(0,10),new Date(now).toISOString().slice(0,7)),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,1,'application/octet-stream',?)`).bind(hashes.artifact,'objects/test',old),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at,last_error)
      VALUES (?,'capture',?,'jwc',?,?,'failed',?,1,?,?,?)`)
      .bind(ids.captureTask,`capture:${ids.article}:diagnostic`,ids.article,'{}',old,old,old,
        'Workflow failed after Bearer secret-token; notify reader@example.test'),
    db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,handed_off_at,ended_at,error_code)
      VALUES (?,1,?,'failed',?,?,?,'capture_failed')`)
      .bind(ids.captureTask,`task-${ids.captureTask}-a1`,old,old,old),
    db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
        requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,source_metadata_json,title)
      VALUES (?,?,1,?,?,'assembling',1,1,?,?,?,'baseline','{}',?)`)
      .bind(ids.revision,ids.article,ids.captureTask,old,hashes.artifact,hashes.raw,hashes.semantic,'诊断链路通知'),
    db.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,required,state,error_code)
      VALUES (?,'attachment:pdf','attachment',1,'pending','attachment_failed')`).bind(ids.revision),
    db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,payload_hash,created_at)
      VALUES (?,?,?,'initial',?,?,?,?)`)
      .bind(ids.event,ids.revision,ids.article,old,now-6*60_000,hashes.semantic,old),
    db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,date_precision,source_timezone)
      VALUES (?,'jwc',?,'live','minute','Asia/Shanghai')`).bind(ids.event,now-12*60_000),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'discover',?,'jwc',?,?,'queued',?,1,?,?)`)
      .bind(ids.discoverTask,`discover:jwc:diagnostic`,ids.article,'{}',old,old,old),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'match-event',?,'jwc',?,?,'queued',?,1,?,?)`)
      .bind(ids.matchTask,`match:${ids.event}:jwc:g0`,ids.article,'{}',old,old,old),
    db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,state,attempts,created_at,updated_at)
      VALUES (?,'feed-jobs',?,?,?,'sent',2,?,?)`)
      .bind(ids.jobOutbox,`start:${ids.discoverTask}:a1`,JSON.stringify({v:1,type:'start-job',outboxId:ids.jobOutbox,taskId:ids.discoverTask,attempt:1}),old,old,old),
    db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,state,attempts,created_at,updated_at)
      VALUES (?,'feed-events',?,?,?,'sent',2,?,?)`)
      .bind(ids.eventOutbox,`match-source:${ids.matchTask}:p0`,JSON.stringify({v:1,type:'match-source',outboxId:ids.eventOutbox,taskId:ids.matchTask,eventId:ids.event,sourceId:'jwc',generation:0,page:0}),old,old,old),
    db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,state,attempts,created_at,updated_at)
      VALUES (?,'feed-events',?,?,?,'queued',0,?,?)`)
      .bind(ids.queuedOutbox,`event:${ids.event}`,JSON.stringify({v:1,type:'event-ready',outboxId:ids.queuedOutbox,eventId:ids.event,revisionId:ids.revision}),old,old,old),
    db.prepare(`INSERT INTO user_deliveries(id,owner_sub,event_id,state,delivery_kind,available_at,created_at,updated_at)
      VALUES (?,'owner',?,'submission_unknown','immediate',?,?,?)`)
      .bind(ids.delivery,ids.event,old,old,old),
    db.prepare(`INSERT INTO mail_messages(id,owner_sub,kind,state,payload_key,payload_hash,recipient_hash,idempotency_key,
        submitted_at,attempts,last_error,created_at,updated_at)
      VALUES (?,'owner','immediate','submission_unknown',?,?,?,?,?,1,'reconciliation_required; reader@example.test',?,?)`)
      .bind(ids.mailMessage,`private/mail/${hashes.mailPayload}`,hashes.mailPayload,hashes.recipient,
        `feed-mail/${ids.mailMessage}`,old,old,old),
    db.prepare(`INSERT INTO mail_items(message_id,delivery_id,event_id,ordinal) VALUES (?,?,?,0)`)
      .bind(ids.mailMessage,ids.delivery,ids.event),
    db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,state,attempts,last_error,created_at,updated_at)
      VALUES (?,'feed-mail',?,?,?,'sent',2,'send failed after Bearer secret-token; reader@example.test',?,?)`)
      .bind(ids.mailOutbox,`send-mail:${ids.mailMessage}:0`,JSON.stringify({v:1,type:'send-mail',outboxId:ids.mailOutbox,messageId:ids.mailMessage}),old,old,old),
    db.prepare(`INSERT INTO outbox_receipts(outbox_id,topic,state,attempts,last_error,created_at,updated_at)
      VALUES (?,'feed-mail','failed',2,'send failed after Bearer secret-token; reader@example.test',?,?)`)
      .bind(ids.mailOutbox,old,old),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'capture',?,'jwc',?,?,'running',?,1,?,?)`)
      .bind(ids.activeTask,`capture:${ids.article}:active`,ids.article,'{}',now,old,old),
    db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,handed_off_at)
      VALUES (?,1,?,'running',?,?)`)
      .bind(ids.activeTask,`task-${ids.activeTask}-a1`,old,old),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,attempt_no,created_at,updated_at)
      VALUES (?,'discover',?,'jwc',?,?,'queued',?,1,?,?)`)
      .bind(ids.launchTask,`discover:jwc:launch`,ids.article,'{}',stale,old,stale),
    db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,state,attempts,created_at,updated_at)
      VALUES (?,'feed-jobs',?,?,?,'queued',0,?,?)`)
      .bind(ids.launchOutbox,`start:${ids.launchTask}:a1`,
        JSON.stringify({v:1,type:'start-job',outboxId:ids.launchOutbox,taskId:ids.launchTask,attempt:1}),stale,old,stale),
  ];
  for(const [index,statement] of statements.entries()){
    try{await db.batch([statement]);}
    catch(error){throw new Error(`seed statement ${index}: ${error.message}`);}
  }
}

test('operations diagnostics links bounded business identities and redacts unsafe facts',async()=>{
  const {mf,db}=await fixture();
  try{
    const unsafe='Provider rejected {"token":"synthetic-json-secret","api_key":"synthetic-json-key","clientSecret":"synthetic-client-secret"}; Authorization: Basic synthetic-basic; Bearer synthetic-bearer; reader@example.test https://a.test/?token=synthetic-query';
    await db.prepare('UPDATE tasks SET last_error=? WHERE id=?').bind(unsafe,ids.captureTask).run();
    await db.prepare('UPDATE task_attempts SET error_code=? WHERE task_id=?').bind(unsafe,ids.captureTask).run();
    await db.prepare('UPDATE revision_requirements SET error_code=? WHERE revision_id=?').bind(unsafe,ids.revision).run();
    const response=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics',{
      headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(body.queues.map(queue=>queue.topic),topics);
    assert.deepEqual(body.queues.map(queue=>queue.deadLetters.map(item=>item.outboxId)),[
      [ids.jobOutbox],[ids.eventOutbox],[ids.mailOutbox],
    ]);
    const event=body.queues[1].deadLetters[0];
    assert.equal(event.kind,'queue_handoff');
    assert.equal(event.lastError,null);
    assert.equal(event.taskId,ids.matchTask);
    assert.equal(event.eventId,ids.event);
    assert.equal(event.revisionId,ids.revision);
    assert.equal(event.sourceId,'jwc');
    const task=body.tasks.find(item=>item.id===ids.captureTask);
    assert.equal(task.kind,'workflow_failure');
    assert.equal(task.handedOffAt,oldIsoValue());
    assert.equal(task.revisionId,ids.revision);
    assert.equal(task.eventId,ids.event);
    assert.equal(body.tasks.find(item=>item.id===ids.activeTask)?.kind,'workflow_stale');
    assert.equal(body.tasks.find(item=>item.id===ids.launchTask)?.kind,'queue_handoff');
    const requirement=body.requirements[0];
    assert.equal(requirement.kind,'missing_requirement');
    assert.equal(requirement.taskId,ids.captureTask);
    assert.equal(requirement.eventId,ids.event);
    assert.equal(body.messages[0].kind,'mail_unknown');
    assert.equal(body.messages[0].messageId,ids.mailMessage);
    assert.equal(body.messages[0].eventId,ids.event);
    assert.equal(body.metrics.oldestBacklog.id,ids.queuedOutbox);
    assert.equal(body.metrics.readyLatency.count,1);
    assert.equal(body.metrics.readyLatency.maxMs,6*60_000);
    assert.equal(body.metrics.missingRequirements,1);
    assert.equal(body.metrics.paidVendorCalls,3);
    assert.equal(body.metrics.paidOcrPages,5);
    assert.equal(body.metrics.ocrPagesToday,3);
    assert.equal(body.metrics.ocrPagesThisMonth,5);
    assert.equal(body.metrics.authUnavailable,0);
    assert.equal(body.metrics.mailUnknown,1);
    assert.deepEqual(body.configuration,{
      maxTaskAttempts:3,maxLaunchAttempts:5,queueDeadLetterAfterMs:900_000,
      taskRetryBaseDelayMs:900_000,taskRetryMaxDelayMs:21_600_000,
      maxMailAttempts:20,maxFirecrawlPerDay:120,
      maxPdfOcrPagesPerDay:50,maxPdfOcrPagesPerMonth:1000,
    });
    const serialized=JSON.stringify(body);
    assert.doesNotMatch(serialized,/synthetic-/);
    assert.ok(!serialized.includes('reader@example.test'),serialized);
    assert.ok(!serialized.includes('secret-token'),serialized);
    assert.ok(!serialized.includes('https://jwc.example.test'),serialized);
  }finally{
    await mf.dispose();
  }
});

test('operations OCR metrics follow the current UTC budget period without rewriting it',async()=>{
  const {mf,db}=await fixture();
  const diagnostics=async()=>{
    const response=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics',{
      headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(response.status,200,await response.clone().text());
    return (await response.json()).metrics;
  };
  const setClock=at=>mf.dispatchFetch('https://feed.test/fixture/clock',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at}),
  });
  try{
    await setClock('2026-10-13T00:15:09Z');
    await db.prepare(`INSERT INTO pdf_ocr_budget(id,day,month,day_pages,month_pages)
      VALUES (1,'2026-10-12','2026-10',3,7)
      ON CONFLICT(id) DO UPDATE SET day='2026-10-12',month='2026-10',day_pages=3,month_pages=7`).run();
    let metrics=await diagnostics();
    assert.equal(metrics.ocrPagesToday,0);
    assert.equal(metrics.ocrPagesThisMonth,7);
    assert.equal(metrics.paidOcrPages,5);

    await setClock('2026-11-01T00:15:09Z');
    await db.prepare(`UPDATE pdf_ocr_budget SET day='2026-10-31',month='2026-10',day_pages=3,month_pages=9`).run();
    metrics=await diagnostics();
    assert.equal(metrics.ocrPagesToday,0);
    assert.equal(metrics.ocrPagesThisMonth,0);
    assert.equal(metrics.paidOcrPages,5);

    await db.prepare(`UPDATE pdf_ocr_budget SET day='2026-11-01',month='2026-11',day_pages=2,month_pages=4`).run();
    metrics=await diagnostics();
    assert.equal(metrics.ocrPagesToday,2);
    assert.equal(metrics.ocrPagesThisMonth,4);
    assert.equal(metrics.paidOcrPages,5);

    const budget=await db.prepare('SELECT day,month,day_pages,month_pages FROM pdf_ocr_budget WHERE id=1').first();
    assert.deepEqual(budget,{day:'2026-11-01',month:'2026-11',day_pages:2,month_pages:4});
  }finally{
    await mf.dispose();
  }
});

test('operations DLQ replay is targeted and preserves the persisted business identity',async()=>{
  const {mf,db}=await fixture();
  try{
    const replay=await mf.dispatchFetch('https://feed.test/internal/operations/replay',{
      method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({outboxId:ids.mailOutbox,topic:'feed-mail'}),
    });
    assert.equal(replay.status,202,await replay.text());
    const sent=await getSends(mf);
    assert.deepEqual(sent.FEED_MAIL,[JSON.parse(await outboxPayload(db,ids.mailOutbox))]);
    const receipt=await db.prepare('SELECT state,attempts,replay_count FROM outbox_receipts WHERE outbox_id=?')
      .bind(ids.mailOutbox).first();
    assert.deepEqual(receipt,{state:'queued',attempts:2,replay_count:1});

    const wrongTopic=await mf.dispatchFetch('https://feed.test/internal/operations/replay',{
      method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({outboxId:ids.mailOutbox,topic:'feed-jobs'}),
    });
    assert.equal(wrongTopic.status,409);
    const processed=await db.prepare(`UPDATE outbox_receipts SET state='processed' WHERE outbox_id=?`)
      .bind(ids.mailOutbox).run();
    assert.equal(processed.meta.changes,1);
    const rejected=await mf.dispatchFetch('https://feed.test/internal/operations/replay',{
      method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
      body:JSON.stringify({outboxId:ids.mailOutbox,topic:'feed-mail'}),
    });
    assert.equal(rejected.status,409);
    assert.equal((await getSends(mf)).FEED_MAIL.length,1);
  }finally{
    await mf.dispose();
  }
});

test('targeted task recovery does not duplicate active workflows and retries only terminated instances',async()=>{
  const {mf,db}=await fixture();
  try{
    const active=await adminPost(mf,`/internal/operations/tasks/${ids.activeTask}/recover`);
    assert.equal(active.status,202);
    assert.deepEqual(await active.json(),{id:ids.activeTask,state:'running',recovered:0,workflowStatus:'waiting'});
    assert.equal((await taskRow(db,ids.activeTask)).attemptNo,1);
    assert.deepEqual((await getSends(mf)).FEED_JOBS??[],[]);

    const launch=await adminPost(mf,`/internal/operations/tasks/${ids.launchTask}/recover`);
    assert.equal(launch.status,202);
    assert.deepEqual(await launch.json(),{id:ids.launchTask,state:'queued',recovered:1,workflowStatus:null});
    const launchSends=(await getSends(mf)).FEED_JOBS;
    assert.equal(launchSends.length,1);
    assert.deepEqual(launchSends[0],{
      v:1,type:'start-job',outboxId:ids.launchOutbox,taskId:ids.launchTask,attempt:1,
    });

    await setWorkflowStatus(mf,'errored');
    const retried=await adminPost(mf,`/internal/operations/tasks/${ids.activeTask}/recover`);
    assert.equal(retried.status,202);
    assert.deepEqual(await retried.json(),{id:ids.activeTask,state:'queued',recovered:1,workflowStatus:'errored'});
    const row=await taskRow(db,ids.activeTask);
    assert.equal(row.attemptNo,2);
    assert.equal(row.state,'queued');
    const sends=(await getSends(mf)).FEED_JOBS;
    assert.equal(sends.length,2);
    assert.deepEqual({taskId:sends[1].taskId,attempt:sends[1].attempt},{taskId:ids.activeTask,attempt:2});
  }finally{
    await mf.dispose();
  }
});

test('failed and due deferred recovery requires a confirmed terminal platform instance',async()=>{
  for(const state of ['failed','deferred']){
    const {mf,db}=await fixture();
    try{
      await db.prepare('UPDATE tasks SET state=?,due_at=? WHERE id=?').bind(state,now-1,ids.activeTask).run();
      for(const platform of ['waiting','running','paused','queued','waitingForPause','rollingBack','unknown','unavailable']){
        await setWorkflowStatus(mf,platform);
        const response=await adminPost(mf,`/internal/operations/tasks/${ids.activeTask}/recover`);
        if(['unknown','unavailable'].includes(platform))assert.equal(response.status,503);
        else{
          assert.equal(response.status,202);
          assert.equal((await response.json()).recovered,0,`${state}/${platform}`);
        }
        assert.equal((await taskRow(db,ids.activeTask)).attemptNo,1);
        assert.deepEqual((await getSends(mf)).FEED_JOBS??[],[]);
      }
      await adminPost(mf,'/fixture/workflow-status',{status:'complete',barrier:2});
      const responses=await Promise.all([1,2].map(()=>adminPost(mf,`/internal/operations/tasks/${ids.activeTask}/recover`)));
      const results=await Promise.all(responses.map(response=>response.json()));
      assert.equal(results.reduce((sum,result)=>sum+result.recovered,0),1);
      assert.deepEqual(await taskRow(db,ids.activeTask),{state:'queued',attemptNo:2});
      assert.equal((await getSends(mf)).FEED_JOBS.length,1);
    }finally{await mf.dispose();}
  }
});

test('targeted dispatch and operations replay share the durable discovery admission budget',async()=>{
  const {mf,db}=await fixture({bindings:{
    SOURCE_MANAGEMENT_ENABLED:'true',
    MAX_LIVE_DISCOVERY_TASKS_PER_RUN:'0',
  }});
  try{
    const replay=await adminPost(mf,'/internal/operations/replay',{outboxId:ids.jobOutbox,topic:'feed-jobs'});
    assert.equal(replay.status,409);

    const recovered=await adminPost(mf,`/internal/operations/tasks/${ids.launchTask}/recover`);
    assert.equal(recovered.status,202);
    assert.deepEqual(await recovered.json(),{
      id:ids.launchTask,state:'queued',recovered:0,workflowStatus:null,
    });
    assert.deepEqual((await getSends(mf)).FEED_JOBS??[],[]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM discovery_admissions').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM outbox_receipts WHERE outbox_id=?').bind(ids.jobOutbox).first()).n,0);
  }finally{
    await mf.dispose();
  }
});

test('replay preserves a fast consumer processed receipt even when the queue response is lost',async()=>{
  for(const mode of ['consume','consume-and-fail']){
    const {mf,db}=await fixture();
    try{
      await db.prepare("UPDATE mail_messages SET state='accepted' WHERE id=?").bind(ids.mailMessage).run();
      await adminPost(mf,'/fixture/queue-mode',{mode});
      const response=await adminPost(mf,'/internal/operations/replay',{outboxId:ids.mailOutbox,topic:'feed-mail'});
      assert.equal(response.status,mode==='consume'?202:503);
      const receipt=await db.prepare('SELECT state,processed_at,last_error FROM outbox_receipts WHERE outbox_id=?').bind(ids.mailOutbox).first();
      assert.equal(receipt.state,'processed');
      assert.ok(receipt.processed_at>0);
      assert.equal(receipt.last_error,null);
      const again=await adminPost(mf,'/internal/operations/replay',{outboxId:ids.mailOutbox,topic:'feed-mail'});
      assert.equal(again.status,409);
      assert.equal((await getSends(mf)).FEED_MAIL.length,1);
    }finally{await mf.dispose();}
  }
});

test('replay atomically starts a fresh retry window for simultaneous and repeated requests',async()=>{
  const {mf,db}=await fixture();
  try{
    const replay=()=>adminPost(mf,'/internal/operations/replay',{outboxId:ids.mailOutbox,topic:'feed-mail'});
    const concurrent=await Promise.all([replay(),replay()]);
    assert.deepEqual(concurrent.map(response=>response.status).sort(),[202,409]);
    assert.equal((await replay()).status,409);
    assert.equal((await getSends(mf)).FEED_MAIL.length,1);
    const diagnostics=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics',{
      headers:{Authorization:'Bearer test-admin-token'},
    }).then(response=>response.json());
    assert.deepEqual(diagnostics.queues.find(queue=>queue.topic==='feed-mail').deadLetters,[]);
    // Expire only the new replay window; the original outbox identity and age stay unchanged.
    await db.prepare('UPDATE outbox_receipts SET last_replayed_at=? WHERE outbox_id=?').bind(now-16*60_000,ids.mailOutbox).run();
    assert.equal((await replay()).status,202);
    assert.deepEqual((await getSends(mf)).FEED_MAIL,Array(2).fill(JSON.parse(await outboxPayload(db,ids.mailOutbox))));
    assert.equal((await db.prepare('SELECT replay_count FROM outbox_receipts WHERE outbox_id=?').bind(ids.mailOutbox).first()).replay_count,2);
    await db.prepare('UPDATE outbox_receipts SET last_replayed_at=? WHERE outbox_id=?').bind(now-16*60_000,ids.mailOutbox).run();
    await adminPost(mf,'/fixture/queue-mode',{mode:'fail'});
    assert.equal((await replay()).status,503);
    assert.equal((await replay()).status,409);
    assert.equal((await getSends(mf)).FEED_MAIL.length,3);
  }finally{await mf.dispose();}
});

test('OCR diagnostics trace the complete descriptor to bounded requirements across source revisions',async()=>{
  const {mf,db}=await fixture();
  try{
    const ocrId='f'.repeat(24),ocrOutbox='ef'.repeat(12),optionsHash='9'.repeat(64);
    const descriptor={v:1,inputHash:hashes.artifact,processor:'mistral-ocr',processorVersion:'v1',optionsHash,options:{model:'test'}};
    await db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,'objects/other',1,'application/pdf',?)`).bind(hashes.raw,now).run();
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'ocr',?,?,'failed',?,?,?)`).bind(ocrId,JSON.stringify(['ocr',hashes.artifact,'mistral-ocr','v1',optionsHash]),JSON.stringify(descriptor),now,now-1,now-1).run();
    await db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,state,available_at,created_at,updated_at)
      VALUES (?,'feed-jobs',?,?,'sent',?,?,?)`).bind(ocrOutbox,`start:${ocrId}:a1`,JSON.stringify({v:1,type:'start-job',outboxId:ocrOutbox,taskId:ocrId,attempt:1}),now-3600000,now-3600000,now-3600000).run();
    const revisions=[];
    for(let i=0;i<3;i++){
      const article=(30+i).toString(16).padStart(24,'0'),capture=(40+i).toString(16).padStart(24,'0'),revision=(50+i).toString(16).padStart(24,'0');
      revisions.push(revision);
      await db.prepare(`INSERT INTO sources(id,name,url) VALUES (?,?,?)`).bind(`ocr${i}`,`OCR ${i}`,`https://example.test/${i}`).run();
      await db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status) VALUES (?,?,?,'OCR','2026-10-12','2026-10-12','partial')`).bind(article,`ocr${i}`,`https://example.test/ocr/${i}`).run();
      await db.prepare(`INSERT INTO tasks(id,kind,business_key,article_id,payload_json,state,due_at,created_at,updated_at)
        VALUES (?,'capture',?,?,'{}','succeeded',?,?,?)`).bind(capture,`capture:ocr:${i}`,article,now,now,now).run();
      await db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,source_metadata_json,title)
        VALUES (?,?,1,?,?,'assembling',1,?,?,?,'baseline','{}','OCR')`).bind(revision,article,capture,now,hashes.artifact,hashes.raw,hashes.semantic).run();
      for(const [slot,hash,processor,version,options] of [
        ['body:ocr',hashes.artifact,'mistral-ocr','v1',optionsHash],
        ['other:input',hashes.raw,'mistral-ocr','v1',optionsHash],
        ['other:processor',hashes.artifact,'other-ocr','v1',optionsHash],
        ['other:version',hashes.artifact,'mistral-ocr','v2',optionsHash],
        ['other:options',hashes.artifact,'mistral-ocr','v1','8'.repeat(64)],
      ]){
        await db.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,required,state,input_hash,processor,processor_version,options_hash)
          VALUES (?,?,'body_ocr',1,'pending',?,?,?,?)`).bind(revision,slot,hash,processor,version,options).run();
      }
    }
    const diagnostics=limit=>mf.dispatchFetch(`https://feed.test/internal/operations/diagnostics?limit=${limit}`,{headers:{Authorization:'Bearer test-admin-token'}}).then(response=>response.json());
    const body=await diagnostics(20),ocr=body.tasks.find(task=>task.id===ocrId);
    assert.equal(ocr.sourceId,'ocr0');
    assert.equal(ocr.revisionId,revisions[0]);
    assert.deepEqual(ocr.references.map(ref=>[ref.revisionId,ref.slotKey]),revisions.map(id=>[id,'body:ocr']));
    assert.equal(ocr.referencesTruncated,false);
    assert.deepEqual(body.queues[0].deadLetters.find(item=>item.outboxId===ocrOutbox).references,ocr.references);
    for(const requirement of body.requirements.filter(row=>row.requirementKind==='body_ocr')){
      assert.equal(requirement.taskId,requirement.slotKey==='body:ocr'?ocrId:null);
      assert.ok(requirement.captureTaskId);
    }
    const bounded=(await diagnostics(2)).tasks.find(task=>task.id===ocrId);
    assert.equal(bounded.references.length,2);
    assert.equal(bounded.referencesTruncated,true);
  }finally{await mf.dispose();}
});

test('operations endpoints are admin-only and bounded',async()=>{
  const {mf}=await fixture();
  try{
    const unauthorized=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics');
    assert.equal(unauthorized.status,401);
    const invalid=await adminPost(mf,'/internal/operations/tasks/ffffffffffffffffffffffff/recover');
    assert.equal(invalid.status,404);
    const unsupported=await adminPost(mf,`/internal/operations/tasks/${ids.matchTask}/recover`);
    assert.equal(unsupported.status,400);
    const bounded=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics?limit=999',{
      headers:{Authorization:'Bearer test-admin-token'},
    });
    assert.equal(bounded.status,200);
    assert.equal((await bounded.json()).limit,100);
  }finally{
    await mf.dispose();
  }
});

test('disabled crawl or runtime rejects recovery and job replay without blocking diagnostics or mail replay',async()=>{
  for(const flag of ['CRAWL_ENABLED','TASK_RUNTIME_ENABLED']){
    const {mf,db}=await fixture({bindings:{[flag]:'false'}});
    try{
      const before=await taskRow(db,ids.launchTask);
      const recovered=await adminPost(mf,`/internal/operations/tasks/${ids.launchTask}/recover`);
      assert.equal(recovered.status,503,flag);
      const replay=await adminPost(mf,'/internal/operations/replay',{outboxId:ids.jobOutbox,topic:'feed-jobs'});
      assert.equal(replay.status,503,flag);
      assert.deepEqual(await taskRow(db,ids.launchTask),before);
      assert.deepEqual((await getSends(mf)).FEED_JOBS??[],[]);
      const diagnostics=await mf.dispatchFetch('https://feed.test/internal/operations/diagnostics',{
        headers:{Authorization:'Bearer test-admin-token'},
      });
      assert.equal(diagnostics.status,200);
      const mail=await adminPost(mf,'/internal/operations/replay',{outboxId:ids.mailOutbox,topic:'feed-mail'});
      assert.equal(mail.status,202);
    }finally{await mf.dispose();}
  }
});

async function adminPost(mf,path,body){
  return mf.dispatchFetch(`https://feed.test${path}`,{
    method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
}

async function getSends(mf){
  return mf.dispatchFetch('https://feed.test/fixture/queue-sends')
    .then(response=>response.json());
}

async function setWorkflowStatus(mf,status){
  const response=await mf.dispatchFetch('https://feed.test/fixture/workflow-status',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status}),
  });
  assert.equal(response.status,200);
}

async function outboxPayload(db,id){
  return (await db.prepare('SELECT payload_json FROM outbox WHERE id=?').bind(id).first()).payload_json;
}

async function taskRow(db,id){
  return db.prepare('SELECT state,attempt_no AS attemptNo FROM tasks WHERE id=?').bind(id).first();
}

function oldIsoValue(){
  return new Date(now-2*60*60_000).toISOString();
}

async function applyMigration(db,sql){
  const statements=sql.split(/;\s*\n(?=CREATE|ALTER|PRAGMA|$)/)
    .map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\b/i.test(statement));
  for(const statement of statements)await db.prepare(statement).run();
}
