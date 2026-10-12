import {cleanError,sha} from './utils.mjs';
import {createSources} from './sources.mjs';

const activeStates=['queued','starting','running'];
const platformStates=new Set(['queued','running','paused','waiting','waitingForPause','rollingBack']);
const terminalPlatformStates=new Set(['complete','errored','terminated']);
const idPattern=/^[a-f0-9]{24}$/;
const replayAfterMs=15*60*1000;

export function createTaskRuntime(env,{now=()=>Date.now(),queue=env.FEED_JOBS,workflow=env.CAPTURE}={}){
  const maxAttempts=boundedInteger(env.MAX_TASK_ATTEMPTS,3,1,10);
  const articleStatus=env.ARCHIVE_VERSIONS_ENABLED==='true'
    ?"COALESCE((SELECT CASE WHEN r.state='ready' THEN 'complete' ELSE 'partial' END FROM article_revisions r WHERE r.id=json_extract(a.result_json,'$.revisionId')),ar.status)"
    :'ar.status';
  const runtime={
    async submitCapture({articleId,requestId}){
      if(!idPattern.test(articleId??''))throw new ValidationError('articleId must be a 24-character lowercase hex id');
      if(!/^[A-Za-z0-9._:-]{8,100}$/.test(requestId??''))throw new ValidationError('requestId must contain 8-100 URI-safe characters');
      const row=await env.DB.prepare('SELECT id,source_id FROM articles WHERE id=?').bind(articleId).first();
      if(!row)throw new ValidationError('Article not found');
      const source=await createSources(env).find(row.source_id);
      if(!source)throw new ValidationError('Article source is not configured');
      const businessKey=`capture:${articleId}:${requestId}`,taskId=(await sha(businessKey)).slice(0,24);
      const timestamp=now(),outboxId=await launchOutboxId(taskId,1);
      const results=await env.DB.batch([
        env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
          VALUES (?,'capture',?,?,?,?,'queued',?,?,?) ON CONFLICT(business_key) DO NOTHING`)
          .bind(taskId,businessKey,row.source_id,articleId,JSON.stringify({source}),timestamp,timestamp,timestamp),
        startOutboxStatement(env,{id:outboxId,taskId,attempt:1,timestamp}),
      ]);
      return {task:await runtime.status(taskId),duplicate:results[0].meta.changes===0};
    },

    async dispatchDueOutbox(limit=20){
      const timestamp=now();
      const rows=await env.DB.prepare(`SELECT * FROM outbox WHERE state='queued' AND available_at<=?
        ORDER BY available_at,id LIMIT ?`).bind(timestamp,boundedInteger(limit,20,1,100)).all();
      const dispatched=[];
      for(const row of rows.results){
        const target=row.topic==='feed-jobs'?queue:row.topic==='feed-events'?env.FEED_EVENTS:env.FEED_MAIL;
        try{
          if(!target)throw new Error(`Queue binding unavailable for ${row.topic}`);
          await target.send(JSON.parse(row.payload_json),{contentType:'json'});
          // Sending first intentionally permits duplicates after a crash. The consumer owns idempotency.
          await env.DB.prepare(`UPDATE outbox SET state='sent',attempts=attempts+1,last_error=NULL,updated_at=?
            WHERE id=? AND state='queued'`).bind(timestamp,row.id).run();
          dispatched.push(row.id);
        }catch(error){
          await env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,last_error=?,available_at=?,updated_at=?
            WHERE id=? AND state='queued'`).bind(cleanError(error),timestamp+Math.min(6*60*60*1000,60_000*2**Math.min(row.attempts,9)),timestamp,row.id).run();
        }
      }
      return dispatched;
    },

    async startJob(payload){
      const message=parseStartMessage(payload);
      const outbox=await env.DB.prepare("SELECT dedupe_key,payload_json FROM outbox WHERE id=? AND topic='feed-jobs'")
        .bind(message.outboxId).first();
      if(!outbox||outbox.dedupe_key!==startDedupeKey(message.taskId,message.attempt)
        ||!sameMessage(message,JSON.parse(outbox.payload_json)))throw new SchemaError('Message does not match its persisted outbox');
      let task=await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(message.taskId).first();
      if(!task)throw new Error('Task not found');
      if(message.attempt<task.attempt_no)return {state:task.state,acked:'stale-attempt'};
      if(message.attempt!==task.attempt_no)throw new SchemaError('Future task attempt');
      if(!activeStates.includes(task.state))return {state:task.state,acked:'terminal'};
      if(task.kind!=='capture')throw new SchemaError('Unsupported workflow kind');
      const instanceId=workflowInstanceId(task.id,message.attempt),timestamp=now();
      await env.DB.batch([
        env.DB.prepare(`UPDATE tasks SET state='starting',updated_at=? WHERE id=? AND state='queued' AND attempt_no=?`)
          .bind(timestamp,task.id,message.attempt),
        env.DB.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at)
          SELECT id,attempt_no,?,'starting',? FROM tasks WHERE id=? AND attempt_no=? AND state IN ('starting','running')
          ON CONFLICT(task_id,attempt_no) DO NOTHING`).bind(instanceId,timestamp,task.id,message.attempt),
      ]);
      task=await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(task.id).first();
      if(task.attempt_no!==message.attempt||!activeStates.includes(task.state))return {state:task.state,acked:'superseded'};
      const attempt=await env.DB.prepare('SELECT * FROM task_attempts WHERE task_id=? AND attempt_no=?')
        .bind(task.id,message.attempt).first();
      if(attempt?.workflow_instance_id!==instanceId)throw new Error('Workflow attempt ledger is missing');
      const instance=attempt.handed_off_at!==null
        ?await workflow.get(instanceId)
        :await ensureWorkflow(workflow,instanceId,{taskId:task.id,attempt:message.attempt});
      const status=await instance.status();
      await persistWorkflowStatus(env,{taskId:task.id,attemptNo:message.attempt,status,now});
      return {state:(await runtime.status(task.id)).state,workflowInstanceId:instanceId,platformStatus:status.status};
    },

    async recover({limit=20}={}){
      const timestamp=now(),pageSize=boundedInteger(limit,20,1,100);
      // A sent message may expire or enter its launch DLQ. Re-send the same identity, with a finite launch budget.
      const stranded=await env.DB.prepare(`SELECT t.id,t.attempt_no,o.id AS outbox_id,o.attempts,a.workflow_instance_id FROM tasks t
        LEFT JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
        JOIN outbox o ON o.topic='feed-jobs' AND o.dedupe_key='start:'||t.id||':a'||t.attempt_no
        WHERE t.state IN ('queued','starting') AND o.state='sent' AND o.updated_at<=?
        AND NOT EXISTS(SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.attempt_no=t.attempt_no AND a.handed_off_at IS NOT NULL)
        ORDER BY o.updated_at,o.id LIMIT ?`).bind(timestamp-replayAfterMs,pageSize).all();
      for(const row of stranded.results){
        if(row.workflow_instance_id){
          try{
            const instance=await workflow.get(row.workflow_instance_id),status=await instance.status();
            await persistWorkflowStatus(env,{taskId:row.id,attemptNo:row.attempt_no,status,now});
            continue;
          }catch{ /* An unconfirmed handoff may only retry its original identity. */ }
        }
        if(row.attempts>=5){
          await env.DB.prepare(`UPDATE tasks SET state='blocked',last_error='launch_delivery_exhausted',updated_at=?
            WHERE id=? AND attempt_no=? AND state IN ('queued','starting')`).bind(timestamp,row.id,row.attempt_no).run();
        }else{
          await env.DB.prepare("UPDATE outbox SET state='queued',available_at=?,updated_at=? WHERE id=? AND state='sent'")
            .bind(timestamp,timestamp,row.outbox_id).run();
        }
      }
      const rows=await env.DB.prepare(`SELECT t.*,a.workflow_instance_id,a.result_json FROM tasks t
        JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
        WHERE t.state IN ('starting','running') OR (t.state='deferred' AND t.due_at<=?)
        ORDER BY t.updated_at,t.id LIMIT ?`).bind(timestamp,pageSize).all();
      let recovered=0;
      for(const task of rows.results){
        try{
          const instance=await workflow.get(task.workflow_instance_id),status=await instance.status();
          if(task.state!=='deferred'){
            await persistWorkflowStatus(env,{taskId:task.id,attemptNo:task.attempt_no,status,now});
            continue;
          }
          if(!terminalPlatformStates.has(status.status))continue;
          if(task.attempt_no>=maxAttempts){
            await env.DB.prepare("UPDATE tasks SET state='blocked',last_error='retry_limit_reached',updated_at=? WHERE id=? AND attempt_no=? AND state='deferred'")
              .bind(timestamp,task.id,task.attempt_no).run();continue;
          }
          const next=task.attempt_no+1,id=await launchOutboxId(task.id,next);
          const result=await env.DB.batch([
            env.DB.prepare(`UPDATE tasks SET state='queued',attempt_no=?,due_at=?,checkpoint_json=NULL,updated_at=?
              WHERE id=? AND attempt_no=? AND state='deferred' AND due_at<=?`)
              .bind(next,timestamp,timestamp,task.id,task.attempt_no,timestamp),
            startOutboxStatement(env,{id,taskId:task.id,attempt:next,timestamp}),
          ]);
          recovered+=Number(result[0].meta.changes>0);
        }catch(error){
          await env.DB.prepare("UPDATE tasks SET last_error=?,updated_at=? WHERE id=? AND attempt_no=? AND state IN ('starting','running','deferred')")
            .bind(cleanError(error),timestamp,task.id,task.attempt_no).run();
        }
      }
      const dispatched=await runtime.dispatchDueOutbox(pageSize);
      return {dispatched,reconciled:rows.results.length,recovered};
    },

    async status(taskId){
      if(!idPattern.test(taskId??''))return null;
      return env.DB.prepare(`SELECT t.id,t.kind,t.business_key,t.source_id AS sourceId,t.article_id AS articleId,
        t.state,t.due_at AS dueAt,t.attempt_no AS attemptNo,t.last_error AS lastError,
        t.created_at AS createdAt,t.updated_at AS updatedAt,a.workflow_instance_id AS workflowInstanceId,
        a.state AS attemptState,a.started_at AS startedAt,a.handed_off_at AS handedOffAt,a.ended_at AS endedAt,
        a.error_code AS errorCode,${articleStatus} AS articleStatus,ar.captured_at AS articleCapturedAt
        FROM tasks t LEFT JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
        LEFT JOIN articles ar ON ar.id=t.article_id WHERE t.id=?`).bind(taskId).first();
    },
    async list({limit=50}={}){
      const rows=await env.DB.prepare(`SELECT t.id,t.state,t.article_id AS articleId,t.source_id AS sourceId,
        t.last_error AS lastError,t.created_at AS createdAt,t.updated_at AS updatedAt,t.due_at AS dueAt,t.attempt_no AS attemptNo,
        a.workflow_instance_id AS workflowInstanceId,a.state AS attemptState,ar.title AS articleTitle,${articleStatus} AS articleStatus
        FROM tasks t LEFT JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
        LEFT JOIN articles ar ON ar.id=t.article_id ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
        .bind(boundedInteger(limit,50,1,100)).all();return rows.results;
    },
  };
  return runtime;
}

export async function handleFeedJobs(batch,env,dependencies={}){
  const runtime=createTaskRuntime(env,dependencies);
  for(const message of batch.messages){
    try{await runtime.startJob(message.body);message.ack();}
    catch(error){
      console.warn(JSON.stringify({event:'job_handoff_failed',error:cleanError(error)}));
      message.retry({delaySeconds:Math.min(300,30*2**Math.max(0,(message.attempts??1)-1))});
    }
  }
}

export async function finishCaptureTask(env,taskId,attemptNo,result,now=()=>Date.now()){
  const timestamp=now(),maxAttempts=boundedInteger(env.MAX_TASK_ATTEMPTS,3,1,10);
  let state='succeeded',errorCode=null,dueAt=timestamp;
  if(result.skipped||result.deferred){
    errorCode=result.skipped?'capture_busy':classifyLimit(result.error);
    state=errorCode==='quota_exhausted'||attemptNo>=maxAttempts?'blocked':'deferred';
    const retryAfter=Number.isFinite(result.retryAfterMs)?Math.max(0,result.retryAfterMs):0;
    if(retryAfter>24*60*60*1000)state='blocked';
    const jitter=(parseInt(taskId.slice(0,6),16)%60)*1000;
    dueAt=timestamp+Math.max(Math.min(retryAfter,24*60*60*1000),errorCode==='capture_busy'?60_000:Math.min(6*60*60*1000,15*60*1000*2**(attemptNo-1)+jitter));
  }else if(result.error){state='failed';errorCode='capture_failed';}
  await env.DB.batch([
    env.DB.prepare(`UPDATE tasks SET state=?,due_at=?,last_error=?,checkpoint_json=?,updated_at=?
      WHERE id=? AND attempt_no=? AND state IN ('starting','running')`)
      .bind(state,dueAt,result.skipped?'Capture is busy':result.error??null,JSON.stringify(result),timestamp,taskId,attemptNo),
    env.DB.prepare(`UPDATE task_attempts SET state=?,result_json=COALESCE(result_json,?),ended_at=?,error_code=?
      WHERE task_id=? AND attempt_no=? AND state IN ('starting','running')
      AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt_no=? AND state=?)`)
      .bind(state,JSON.stringify(result),timestamp,errorCode,taskId,attemptNo,taskId,attemptNo,state),
  ]);
}

export async function failCaptureTask(env,taskId,attemptNo,error,now=()=>Date.now()){
  const receipt=await env.DB.prepare('SELECT result_json FROM task_attempts WHERE task_id=? AND attempt_no=?')
    .bind(taskId,attemptNo).first();
  if(receipt?.result_json)return finishCaptureTask(env,taskId,attemptNo,JSON.parse(receipt.result_json),now);
  const message=cleanError(error),classification=classifyLimit(message);
  return finishCaptureTask(env,taskId,attemptNo,{error:message,...(classification!=='provider_error'?{deferred:true}:{})},now);
}

async function persistWorkflowStatus(env,{taskId,attemptNo,status,now}){
  if(!terminalPlatformStates.has(status.status)&&!platformStates.has(status.status))throw new Error('Workflow status is unknown');
  const timestamp=now();
  // This durable fact is the launch Queue acknowledgement boundary, independent of business completion.
  await env.DB.prepare(`UPDATE task_attempts SET handed_off_at=COALESCE(handed_off_at,?) WHERE task_id=? AND attempt_no=?`)
    .bind(timestamp,taskId,attemptNo).run();
  const current=await env.DB.prepare(`SELECT t.state,a.result_json FROM tasks t JOIN task_attempts a
    ON a.task_id=t.id AND a.attempt_no=t.attempt_no WHERE t.id=? AND t.attempt_no=?`).bind(taskId,attemptNo).first();
  if(!current||!activeStates.includes(current.state))return;
  if(terminalPlatformStates.has(status.status)){
    if(current.result_json)return finishCaptureTask(env,taskId,attemptNo,JSON.parse(current.result_json),now);
    return failCaptureTask(env,taskId,attemptNo,status.error?.message??status.error??`Workflow ${status.status} without a saved capture result`,now);
  }
  const running=status.status!=='queued';
  await env.DB.batch([
    env.DB.prepare(`UPDATE tasks SET state=CASE WHEN state='running' OR ? THEN 'running' ELSE 'starting' END,updated_at=?
      WHERE id=? AND attempt_no=? AND state IN ('starting','running')`).bind(running?1:0,timestamp,taskId,attemptNo),
    env.DB.prepare(`UPDATE task_attempts SET state=CASE WHEN state='running' OR ? THEN 'running' ELSE 'starting' END
      WHERE task_id=? AND attempt_no=? AND state IN ('starting','running')`).bind(running?1:0,taskId,attemptNo),
  ]);
}

async function ensureWorkflow(workflow,id,params){
  try{return await workflow.create({id,params});}
  catch(error){
    try{const existing=await workflow.get(id);await existing.status();return existing;}
    catch{throw error;}
  }
}
function parseStartMessage(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==5)throw new SchemaError('Invalid start-job payload');
  const {v,type,outboxId,taskId,attempt}=payload;
  if(v!==1||type!=='start-job'||!idPattern.test(outboxId??'')||!idPattern.test(taskId??'')
    ||!Number.isSafeInteger(attempt)||attempt<1||attempt>1000)throw new SchemaError('Invalid start-job identity');
  return {v,type,outboxId,taskId,attempt};
}
function sameMessage(a,b){return ['v','type','outboxId','taskId','attempt'].every(key=>a[key]===b?.[key]);}
function startOutboxStatement(env,{id,taskId,attempt,timestamp}){
  return env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
    SELECT ?,'feed-jobs',?,?,?,?,? FROM tasks WHERE id=? AND attempt_no=? AND state='queued'
    ON CONFLICT(topic,dedupe_key) DO NOTHING`)
    .bind(id,startDedupeKey(taskId,attempt),JSON.stringify({v:1,type:'start-job',outboxId:id,taskId,attempt}),timestamp,timestamp,timestamp,taskId,attempt);
}
function startDedupeKey(taskId,attempt){return `start:${taskId}:a${attempt}`;}
async function launchOutboxId(taskId,attempt){return (await sha(startDedupeKey(taskId,attempt))).slice(0,24);}
function workflowInstanceId(taskId,attempt){return `task-${taskId}-a${attempt}`;}
function classifyLimit(message){
  if(/\b402\b|\b(?:budget|quota|credit)s?\b/i.test(message??''))return 'quota_exhausted';
  if(/\b429\b|rate limit/i.test(message??''))return 'rate_limited';
  return 'provider_error';
}
function boundedInteger(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)?Math.min(max,Math.max(min,n)):fallback;}
export class ValidationError extends Error{}
class SchemaError extends Error{}
