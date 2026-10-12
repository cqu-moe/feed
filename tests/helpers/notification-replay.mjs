import {handleFeedJobs} from '../../worker/task-runtime.mjs';

// Transport replay at the approved asynchronous test seam; never shipped by the Worker.
export async function replayMatchOutbox(env,now,limit=20){
  const at=now();
  const rows=await env.DB.prepare(`SELECT id,payload_json FROM outbox
    WHERE topic='feed-events' AND state='queued' AND available_at<=?
      AND json_extract(payload_json,'$.type')='match-source'
    ORDER BY available_at,id LIMIT ?`).bind(at,limit).all();
  for(const row of rows.results){
    let acked=false;
    await handleFeedJobs({messages:[{body:JSON.parse(row.payload_json),
      ack(){acked=true;},retry(){}}]},env,{now});
    if(!acked)throw new Error('Match transport requested retry');
    await env.DB.prepare(`UPDATE outbox SET state='sent',updated_at=? WHERE id=? AND state='queued'`)
      .bind(at,row.id).run();
  }
  const pending=await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox
    WHERE topic='feed-events' AND state='queued' AND json_extract(payload_json,'$.type')='match-source'`).first();
  return {processed:rows.results.length,pendingPages:pending.n};
}
