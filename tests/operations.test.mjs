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

async function fixture(){
  const bundle=await build({
    stdin:{contents:`import worker from './worker/index.mjs';
      globalThis.OPERATIONS_QUEUE_SENDS={};
      globalThis.OPERATIONS_WORKFLOW_STATUS='waiting';
      const workflow={
        async get(id){
          if(id!=='task-${ids.activeTask}-a1')throw new Error('Workflow instance not found');
          return {id,status:async()=>({status:globalThis.OPERATIONS_WORKFLOW_STATUS,error:null})};
        },
      };
      function wrap(rawEnv,name){
        const actual=rawEnv[name];
        return {
          async send(body){
            globalThis.OPERATIONS_QUEUE_SENDS[name]??=[];
            globalThis.OPERATIONS_QUEUE_SENDS[name].push(body);
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
          if(url.pathname==='/fixture/workflow-status'){
            if(request.method==='POST'){
              const body=await request.json();
              globalThis.OPERATIONS_WORKFLOW_STATUS=body.status;
            }
            return Response.json({status:globalThis.OPERATIONS_WORKFLOW_STATUS});
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
    bindings:{ADMIN_TOKEN:'test-admin-token',TASK_RUNTIME_ENABLED:'true',MAX_TASK_ATTEMPTS:'3'},
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
    '0014_mail_delivery.sql','0018_outbox_receipts.sql']){
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
      VALUES ('2026-10',5,5,0.25)`),
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
  const {mf}=await fixture();
  try{
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
    assert.equal(body.metrics.authUnavailable,0);
    assert.equal(body.metrics.mailUnknown,1);
    assert.deepEqual(body.configuration,{
      maxTaskAttempts:3,maxLaunchAttempts:5,queueDeadLetterAfterMs:900_000,
      taskRetryBaseDelayMs:900_000,taskRetryMaxDelayMs:21_600_000,
      maxMailAttempts:20,maxFirecrawlPerDay:120,
      maxPdfOcrPagesPerDay:50,maxPdfOcrPagesPerMonth:1000,
    });
    const serialized=JSON.stringify(body);
    assert.ok(!serialized.includes('reader@example.test'),serialized);
    assert.ok(!serialized.includes('secret-token'),serialized);
    assert.ok(!serialized.includes('https://jwc.example.test'),serialized);
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

async function adminPost(mf,path){
  return mf.dispatchFetch(`https://feed.test${path}`,{
    method:'POST',headers:{Authorization:'Bearer test-admin-token'},
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
