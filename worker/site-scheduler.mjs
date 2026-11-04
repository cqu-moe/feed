import {captureFailure} from './capture-error.mjs';
import {backfillTaskSql} from './backfill-control.mjs';

export function browserTaskKind(kind){
  return ['capture','recheck','discover','backfill'].includes(kind);
}

export async function claimSiteExecution(env,task,now=Date.now()){
  if(!browserTaskKind(task?.kind))return {admitted:true};
  const leaseMs=20*60*1000;
  const timestamp=Number(now);
  const row=await env.DB.prepare(`
    WITH candidate AS (
      SELECT COALESCE(json_extract(t.payload_json,'$.source.siteId'),s.site_id) AS site_id
      FROM tasks t JOIN sources s ON s.id=t.source_id JOIN sites site ON site.id=s.site_id
      WHERE t.id=? AND t.attempt_no=? AND t.state IN ('queued','starting','running')
    )
    INSERT INTO site_execution_leases(site_id,owner_task_id,owner_attempt_no,acquired_at,lease_until,generation)
    SELECT site_id,?,?,?,?+?,1 FROM candidate
    WHERE TRUE
    ON CONFLICT(site_id) DO UPDATE SET
      owner_task_id=excluded.owner_task_id,
      owner_attempt_no=excluded.owner_attempt_no,
      acquired_at=excluded.acquired_at,
      lease_until=excluded.lease_until,
      generation=CASE WHEN site_execution_leases.owner_task_id=excluded.owner_task_id
        AND site_execution_leases.owner_attempt_no=excluded.owner_attempt_no
        THEN site_execution_leases.generation ELSE site_execution_leases.generation+1 END
    WHERE site_execution_leases.lease_until<=?
      OR (site_execution_leases.owner_task_id=excluded.owner_task_id
        AND site_execution_leases.owner_attempt_no=excluded.owner_attempt_no)
    RETURNING site_id,generation
  `).bind(task.id,task.attempt_no,task.id,task.attempt_no,timestamp,timestamp,leaseMs,timestamp).first();
  if(!row)return {admitted:false,busy:true};
  return {admitted:true,siteId:row.site_id,generation:row.generation,taskId:task.id,attemptNo:task.attempt_no};
}

export async function verifySiteExecution(env,taskId,attemptNo,now=Date.now()){
  const row=await env.DB.prepare(`SELECT lease.site_id,lease.generation
    FROM site_execution_leases lease JOIN tasks t ON t.id=lease.owner_task_id
    WHERE lease.owner_task_id=? AND lease.owner_attempt_no=? AND t.attempt_no=?
      AND t.state='running' AND lease.lease_until>?`)
    .bind(taskId,attemptNo,attemptNo,Number(now)).first();
  if(!row)throw new Error('Site execution admission expired');
  return {siteId:row.site_id,taskId,attemptNo,generation:row.generation};
}

export function delayBusyLaunch(env,taskId,attemptNo,now=Date.now()){
  const timestamp=Number(now),jitter=parseInt(taskId.slice(0,6),16)%15000;
  return env.DB.prepare(`UPDATE outbox SET state='queued',available_at=?,last_error='site_busy',updated_at=?
    WHERE topic='feed-jobs' AND dedupe_key=? AND state IN ('queued','sent')`)
    .bind(timestamp+15000+jitter,timestamp,`start:${taskId}:a${attemptNo}`).run();
}

export async function releaseSiteExecution(env,{siteId,taskId,attemptNo,generation},now=Date.now()){
  if(!siteId)return false;
  const result=await env.DB.prepare(`UPDATE site_execution_leases
    SET owner_task_id=NULL,owner_attempt_no=NULL,acquired_at=NULL,lease_until=0,generation=generation+1
    WHERE site_id=? AND owner_task_id=? AND owner_attempt_no=? AND generation=?`)
    .bind(siteId,taskId,attemptNo,generation).run();
  const released=(result.meta?.changes??0)>0;
  if(released)await env.DB.prepare(`UPDATE outbox SET available_at=?,last_error=NULL
    WHERE topic='feed-jobs' AND state='queued' AND last_error='site_busy'
      AND json_extract(payload_json,'$.taskId') IN (SELECT t.id FROM tasks t JOIN sources s ON s.id=t.source_id
        WHERE COALESCE(json_extract(t.payload_json,'$.source.siteId'),s.site_id)=? AND t.state='queued')`)
    .bind(Number(now),siteId).run();
  return released;
}


export async function releaseOwnedSiteExecution(env,taskId,attemptNo,now=Date.now()){
  const lease=await env.DB.prepare(`SELECT site_id,generation FROM site_execution_leases
    WHERE owner_task_id=? AND owner_attempt_no=?`).bind(taskId,attemptNo).first();
  if(!lease)return false;
  return releaseSiteExecution(env,{siteId:lease.site_id,generation:lease.generation,taskId,attemptNo},now);
}

// Reuse the persisted launch outbox; a successor claims the site atomically
// when delivered. No second queue or container polling is needed.
export async function handoffOrReleaseSiteExecution(env,admission,now=Date.now()){
  const released=await releaseSiteExecution(env,admission,now);
  if(!released)return {released:false};
  const next=await env.DB.prepare(`SELECT o.id FROM outbox o JOIN tasks t ON t.id=json_extract(o.payload_json,'$.taskId')
    WHERE o.topic='feed-jobs' AND o.state IN ('queued','sent') AND o.available_at<=? AND t.due_at<=?
      AND t.state='queued' AND t.attempt_no=json_extract(o.payload_json,'$.attempt')
      AND (
        t.kind IN ('capture','recheck')
        OR t.kind='discover'
        OR t.kind='backfill' AND EXISTS(SELECT 1 FROM discovery_admissions a
          WHERE a.task_id=t.id AND a.attempt_no=t.attempt_no AND a.lane=t.kind)
          AND ${backfillTaskSql()}
      )
      AND COALESCE(json_extract(t.payload_json,'$.source.siteId'),(SELECT s.site_id FROM sources s WHERE s.id=t.source_id))=?
    ORDER BY t.priority,t.due_at,t.id LIMIT 1`).bind(now,now,admission.siteId).first();
  return {released:true,outboxId:next?.id};
}

export async function runSiteTask(env,step,taskId,attemptNo,name,timeout,run){
  const maxAttempts=Math.min(10,Math.max(1,Number(env.MAX_TASK_ATTEMPTS)||3));
  const baseDelay=Math.max(60000,Number(env.TASK_RETRY_BASE_DELAY_MS)||900000);
  const maxDelay=Math.max(baseDelay,Number(env.TASK_RETRY_MAX_DELAY_MS)||21600000);
  let originTries=0,archiveTries=0;
  for(let n=0;;n++){
    const result=await step.do(n?`${name}-try-${n}`:name,{retries:{limit:0,delay:'5 seconds'},timeout},async()=>{
      const task=await env.DB.prepare("SELECT * FROM tasks WHERE id=? AND attempt_no=? AND state='running'").bind(taskId,attemptNo).first();
      if(!task)return {superseded:true};
      const admission=await claimSiteExecution(env,task);
      if(!admission.admitted)return {capacity:true,retryAfterMs:30000};
      try{return await run(admission);}
      catch(error){return captureFailure(error);}
      finally{await releaseSiteExecution(env,admission);}
    });
    // Pause, quota and permanent errors must reach the owning task unchanged.
    const transient=result?.retryable||result?.code==='rate_limited'||result?.code==='browser_transient';
    const waiting=result?.capacity||result?.skipped;
    if(!waiting&&!transient&&!result?.resumeSaved)return result;
    if(!waiting&&(result.resumeSaved?++archiveTries:++originTries)>=maxAttempts)
      return {...result,originAttemptsExhausted:true};
    const delay=waiting?Math.min(30000*(n+1),900000):Math.min(baseDelay*2**Math.max(0,(result.resumeSaved?archiveTries:originTries)-1),maxDelay);
    await step.sleep(`${name}-wait-${n}`,Math.max(delay,result.retryAfterMs??0));
  }
}
