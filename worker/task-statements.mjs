import {sha} from './utils.mjs';

export function launchDedupeKey(taskId,attempt){
  return `start:${taskId}:a${attempt}`;
}

export async function launchOutboxId(taskId,attempt){
  return (await sha(launchDedupeKey(taskId,attempt))).slice(0,24);
}

export function launchOutboxStatement(env,{id,taskId,attempt,timestamp,guardSql='',guardArgs=[]}){
  const gate=guardSql?` AND ${guardSql}`:'';
  return env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
    SELECT ?,'feed-jobs',?,?,?,?,? FROM tasks WHERE id=? AND attempt_no=? AND state='queued'${gate}
    ON CONFLICT(topic,dedupe_key) DO NOTHING`)
    .bind(id,launchDedupeKey(taskId,attempt),JSON.stringify({
      v:1,type:'start-job',outboxId:id,taskId,attempt,
    }),timestamp,timestamp,timestamp,taskId,attempt,...guardArgs);
}
