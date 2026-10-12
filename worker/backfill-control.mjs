// The same current-state fence is used for admission and page publication.
export function backfillEnabledSql(source='s'){
  return `${source}.enabled=1 AND ${source}.validation_state='verified' AND ${source}.backfill_state='running'
    AND EXISTS(SELECT 1 FROM sites enabled_site WHERE enabled_site.id=${source}.site_id AND enabled_site.enabled=1)`;
}

export function backfillTaskSql(task='t'){
  return `EXISTS(SELECT 1 FROM sources s WHERE s.id=${task}.source_id
    AND s.config_version=json_extract(${task}.payload_json,'$.source.configVersion')
    AND s.backfill_run_id=json_extract(${task}.payload_json,'$.runId') AND ${backfillEnabledSql()})`;
}

export async function readBackfillControl(env,source,runId){
  const row=await env.DB.prepare(`SELECT s.backfill_max_pages,CASE WHEN ${backfillEnabledSql()} THEN 1 ELSE 0 END AS allowed
    FROM sources s WHERE s.id=? AND s.config_version=? AND s.backfill_run_id=?`)
    .bind(source.id,source.configVersion,runId).first();
  if(!row)return {superseded:true};
  if(!row.allowed)return {deferred:true,error:'Backfill is paused or source/site is disabled or unverified',retryAfterMs:12*60*60*1000};
  return {maxPages:row.backfill_max_pages};
}

// A permit belongs to a task attempt, so at-least-once Queue/outbox delivery
// cannot spend it twice. Concurrent dispatchers share one atomic lane counter.
export async function admitDiscovery(env,taskId,attempt,at){
  const task=await env.DB.prepare('SELECT kind,payload_json FROM tasks WHERE id=?').bind(taskId).first();
  if(!task||!['discover','backfill'].includes(task.kind)||JSON.parse(task.payload_json).mode==='validate')return true;
  const interval=bounded(env.DISCOVERY_ADMISSION_INTERVAL_SEC,60,60,3600)*1000;
  const slot=Math.floor(at/interval)*interval;
  const limit=task.kind==='backfill'?bounded(env.MAX_BACKFILL_TASKS_PER_RUN,5,0,100):bounded(env.MAX_LIVE_DISCOVERY_TASKS_PER_RUN,20,0,100);
  const guard=task.kind==='backfill'?` AND ${backfillTaskSql()}`:'';
  await env.DB.prepare(`INSERT INTO discovery_admissions(task_id,attempt_no,lane,slot,admitted_at)
    SELECT t.id,t.attempt_no,t.kind,?,? FROM tasks t WHERE t.id=? AND t.attempt_no=?
      AND t.state IN ('queued','starting','running')${guard}
      AND (SELECT COUNT(*) FROM discovery_admissions WHERE lane=t.kind AND slot=?)<?
    ON CONFLICT(task_id,attempt_no) DO NOTHING`).bind(slot,at,taskId,attempt,slot,limit).run();
  const admitted=await env.DB.prepare(`SELECT 1 FROM discovery_admissions a JOIN tasks t ON t.id=a.task_id
    WHERE a.task_id=? AND a.attempt_no=?${guard}`).bind(taskId,attempt).first();
  if(!admitted&&task.kind==='backfill')await env.DB.prepare(`UPDATE sources SET backfill_next_at=?
    WHERE id=(SELECT source_id FROM tasks WHERE id=?) AND backfill_run_id=? AND backfill_state='running'`)
    .bind(slot+interval,taskId,JSON.parse(task.payload_json).runId).run();
  return Boolean(admitted);
}

// Retention keeps every permit that can still identify the active task attempt.
// Terminal permits and attempts already replaced by a newer attempt are safe to
// delete only after the configured age; each recovery clears a bounded batch.
export async function retainDiscoveryAdmissions(env,at){
  const retentionMs=bounded(env.DISCOVERY_ADMISSION_RETENTION_MS,7*24*60*60*1000,60*60*1000,30*24*60*60*1000);
  const result=await env.DB.prepare(`DELETE FROM discovery_admissions WHERE rowid IN (
      SELECT a.rowid FROM discovery_admissions a JOIN tasks t ON t.id=a.task_id
      WHERE a.admitted_at<=? AND (t.state IN ('succeeded','cancelled') OR t.attempt_no>a.attempt_no)
      ORDER BY a.admitted_at,a.task_id,a.attempt_no LIMIT 100)`).bind(at-retentionMs).run();
  return result.meta?.changes??0;
}

// Compose with the task terminal transition so the source cannot remain running
// after its current page becomes terminal. Old runs/configurations never win.
export function backfillFailureStatement(env,taskId,attempt,at){
  return env.DB.prepare(`UPDATE sources SET backfill_state='failed',
      backfill_last_error=(SELECT last_error FROM tasks WHERE id=?),updated_at=?
    WHERE backfill_state IN ('running','paused') AND EXISTS(SELECT 1 FROM tasks t
      WHERE t.id=? AND t.attempt_no=? AND t.kind='backfill' AND t.state IN ('failed','blocked')
      AND t.source_id=sources.id AND json_extract(t.payload_json,'$.runId')=sources.backfill_run_id
      AND json_extract(t.payload_json,'$.source.configVersion')=sources.config_version)`)
    .bind(taskId,at,taskId,attempt);
}

function bounded(value,fallback,min,max){const n=Number(value);return Number.isSafeInteger(n)?Math.max(min,Math.min(max,n)):fallback;}
