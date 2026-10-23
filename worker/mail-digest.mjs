import {sha} from './utils.mjs';
import {renderDigestMail} from './mail-template.mjs';

const day=86400_000;

// This compiler owns window membership. The existing mail sender owns transport and recovery.
export function createDigestCompiler(env,{now,assess,savePrivate,gate}){
  const maxItems=Math.max(1,Math.min(50,Math.trunc(Number(env.DIGEST_MAX_ITEMS)||20)));
  const maxBytes=Math.max(8192,Math.min(262144,Math.trunc(Number(env.DIGEST_MAX_BYTES)||65536)));
  return async function prepareDigests(){
    if(env.MAIL_ENABLED!=='true')return {disabled:true,prepared:0};
    const at=now(),cutoff=Math.floor((at-12*3600_000)/day)*day+12*3600_000;
    const owners=await env.DB.prepare(`SELECT DISTINCT d.owner_sub FROM user_deliveries d
      JOIN content_events e ON e.id=d.event_id WHERE d.state='pending'
      AND (d.delivery_kind='daily_digest' OR d.backlog_at IS NOT NULL)
      AND d.created_at<=? AND e.ready_at<=? AND d.available_at<=?
      AND NOT EXISTS(SELECT 1 FROM mail_digest_windows w WHERE w.owner_sub=d.owner_sub AND (w.window_end=? OR w.state='open'))
      ORDER BY d.owner_sub LIMIT 20`).bind(cutoff,cutoff,at,cutoff).all();
    for(const row of owners.results)await env.DB.prepare(`INSERT INTO mail_digest_windows(owner_sub,window_end,created_at,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(owner_sub,window_end) DO NOTHING`).bind(row.owner_sub,cutoff,at,at).run();
    const windows=await env.DB.prepare(`SELECT * FROM mail_digest_windows WHERE state='open' AND window_end<=?
      ORDER BY updated_at,owner_sub LIMIT 20`).bind(cutoff).all();
    let prepared=0;
    for(const window of windows.results){
      const rows=await env.DB.prepare(`SELECT d.* FROM user_deliveries d JOIN content_events e ON e.id=d.event_id
        WHERE d.owner_sub=? AND d.state='pending' AND (d.delivery_kind='daily_digest' OR d.backlog_at IS NOT NULL)
        AND d.id>? AND d.created_at<=? AND e.ready_at<=? AND d.available_at<=? ORDER BY d.id LIMIT ?`)
        .bind(window.owner_sub,window.cursor,window.window_end,window.window_end,at,maxItems+1).all();
      const page=rows.results.slice(0,maxItems),assessments=await assess(page);
      if(assessments.some(item=>item.suppressionReason==='auth_unavailable')){
        await env.DB.prepare('UPDATE mail_digest_windows SET updated_at=? WHERE owner_sub=? AND window_end=?')
          .bind(at,window.owner_sub,window.window_end).run();continue;
      }
      const id=(await sha(`digest:${window.owner_sub}:${window.window_end}:${window.next_chunk}`)).slice(0,24);
      const items=[];
      let payload=null,cursor=window.cursor,consumed=0;
      for(const [index,delivery] of page.entries()){
        const assessment=assessments[index];
        if(assessment.eligible&&!assessment.suppressionReason&&(assessment.mode==='daily_digest'||delivery.backlog_at!==null)){
          const proposed=[...items,{delivery,assessment}];
          const rendered=render(env,proposed,id,window.window_end,window.next_chunk);
          if(new TextEncoder().encode(JSON.stringify(rendered)).length>maxBytes){
            if(!items.length)throw new Error('mail_digest_item_too_large');
            break;
          }
          items.push({delivery,assessment});payload=rendered;
        }
        cursor=delivery.id;consumed++;
      }
      const state=rows.results.length>consumed?'open':'closed';
      if(!items.length){
        await env.DB.prepare(`UPDATE mail_digest_windows SET cursor=?,state=?,updated_at=?
          WHERE owner_sub=? AND window_end=? AND cursor=? AND next_chunk=? AND claim_token IS NULL`)
          .bind(cursor,state,at,window.owner_sub,window.window_end,window.cursor,window.next_chunk).run();continue;
      }
      const object=await savePrivate(JSON.stringify(payload));
      const recipientHash=await sha(payload.to.trim().toLowerCase());
      const checked=gate(items.map(item=>item.assessment)),key=`feed-mail/${id}`;
      const outboxId=(await sha(`mail:${id}:0`)).slice(0,24);
      const message={v:1,type:'send-mail',outboxId,messageId:id};
      const token=crypto.randomUUID(),memberIds=JSON.stringify(items.map(item=>item.delivery.id));
      const windowGate='EXISTS(SELECT 1 FROM mail_digest_windows WHERE owner_sub=? AND window_end=? AND claim_token=?)';
      const windowArgs=[window.owner_sub,window.window_end,token];
      const results=await env.DB.batch([
        env.DB.prepare(`UPDATE mail_digest_windows SET claim_token=? WHERE owner_sub=? AND window_end=?
          AND state='open' AND cursor=? AND next_chunk=? AND claim_token IS NULL`)
          .bind(token,window.owner_sub,window.window_end,window.cursor,window.next_chunk),
        env.DB.prepare(`UPDATE user_deliveries SET state='claimed',claimed_message_id=?,suppression_reason=NULL,updated_at=?
          WHERE id IN (SELECT value FROM json_each(?)) AND state='pending' AND ${windowGate} AND ${checked.sql}
          AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE recipient_hash=?)`)
          .bind(id,at,memberIds,...windowArgs,...checked.args,recipientHash),
        env.DB.prepare(`INSERT INTO mail_messages(id,owner_sub,kind,state,payload_key,payload_hash,recipient_hash,idempotency_key,next_attempt_at,created_at,updated_at)
          SELECT ?,?,'daily_digest','prepared',?,?,?,?,?,?,? WHERE ${windowGate}
          AND (SELECT COUNT(*) FROM user_deliveries WHERE claimed_message_id=?)=? ON CONFLICT(id) DO NOTHING`)
          .bind(id,window.owner_sub,object.key,object.hash,recipientHash,key,at,at,at,...windowArgs,id,items.length),
        env.DB.prepare(`INSERT INTO mail_items(message_id,delivery_id,event_id,ordinal)
          SELECT ?,d.id,d.event_id,CAST(j.key AS INTEGER) FROM json_each(?) j JOIN user_deliveries d ON d.id=j.value
          WHERE d.claimed_message_id=? AND EXISTS(SELECT 1 FROM mail_messages WHERE id=?)
          ON CONFLICT(message_id,delivery_id) DO NOTHING`).bind(id,memberIds,id,id),
        env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
          SELECT ?,'feed-mail',?,?,?,?,? WHERE ${windowGate} AND EXISTS(SELECT 1 FROM mail_messages WHERE id=?)
          ON CONFLICT(topic,dedupe_key) DO NOTHING`)
          .bind(outboxId,`send-mail:${id}:0`,JSON.stringify(message),at,at,at,...windowArgs,id),
        env.DB.prepare(`UPDATE user_deliveries SET state='pending',claimed_message_id=NULL WHERE claimed_message_id=?
          AND NOT EXISTS(SELECT 1 FROM mail_messages WHERE id=?)`).bind(id,id),
        env.DB.prepare(`UPDATE mail_digest_windows SET cursor=?,next_chunk=next_chunk+1,state=?,updated_at=?
          WHERE owner_sub=? AND window_end=? AND claim_token=? AND EXISTS(SELECT 1 FROM mail_messages WHERE id=?)`)
          .bind(cursor,state,at,...windowArgs,id),
        env.DB.prepare('UPDATE mail_digest_windows SET claim_token=NULL WHERE owner_sub=? AND window_end=? AND claim_token=?')
          .bind(...windowArgs),
      ]);
      prepared+=Number(results[2].meta.changes>0);
    }
    return {prepared};
  };
}

function render(env,items,id,windowEnd,chunk){
  const origin=new URL(env.BASE_URL);
  if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
    throw new Error('mail_origin_invalid');
  const date=new Date(windowEnd+8*3600_000).toISOString().slice(0,10);
  const lines=items.map(({assessment:{event}})=>({title:event.title,label:event.kind==='update'?'内容更新':'新通知',
    link:`${origin.origin}/articles/${event.articleId}?revision=${event.revisionId}`}));
  return renderDigestMail({from:env.MAIL_FROM,to:items[0].assessment.recipient,date,chunk,items:lines,
    manageUrl:`${origin.origin}/subscriptions`,productUrl:origin.origin,messageId:id});
}
