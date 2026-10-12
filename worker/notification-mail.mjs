import {sha} from './utils.mjs';
import {createNotifications} from './notifications.mjs';
import {createResendProvider} from './mail-provider-resend.mjs';

const idPattern=/^[a-f0-9]{24}$/;
const minute=60_000;
const terminal=new Set(['accepted','delivered','bounced','complained','cancelled','rejected']);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeCode=value=>/^[a-z0-9_]{1,80}$/.test(value??'')?value:'provider_unavailable';

// Notifications owns the delivery ledger; transport and provider adapters never claim items.
export function createMail(env,{now=()=>Date.now(),provider=createResendProvider(env,{now})}={}){
  const notifications=createNotifications(env,{now});
  const enabled=()=>env.MAIL_ENABLED==='true';
  const limit=Math.max(1,Math.min(50,Number(env.MAIL_PREPARE_LIMIT)||20));
  const maxAttempts=Math.max(1,Math.min(10,Number(env.MAX_MAIL_ATTEMPTS)||6));

  async function list(){
    const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,kind,state,provider_id AS providerId,
      submitted_at AS submittedAt,accepted_at AS acceptedAt,delivered_at AS deliveredAt,
      bounced_at AS bouncedAt,complained_at AS complainedAt,next_attempt_at AS nextAttemptAt,
      attempts,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
      FROM mail_messages ORDER BY created_at DESC,id LIMIT 100`).all();
    return {enabled:enabled(),messages:rows.results};
  }

  function gate(assessment){
    return {sql:`(SELECT COALESCE(json_group_array(id||':'||config_version),'[]') FROM
      (SELECT id,config_version FROM subscriptions WHERE owner_sub=? ORDER BY id))=?
      AND (SELECT COUNT(*) FROM event_sources WHERE event_id=?)=?
      AND (SELECT COUNT(*) FROM event_source_corrections WHERE event_id=?)=?`,
    args:[assessment.ownerSub,assessment.configStamp,assessment.event.id,assessment.sourceCount,assessment.event.id,assessment.corrections]};
  }

  async function assess(delivery){
    const result=await notifications.assessDelivery(delivery.owner_sub,delivery.event_id);
    const suppression=result.recipient?await env.DB.prepare('SELECT reason FROM mail_suppressions WHERE recipient_hash=?')
      .bind(await sha(result.recipient.trim().toLowerCase())).first():null;
    return {...result,ownerSub:delivery.owner_sub,suppressionReason:suppression?`email_${suppression.reason}`:result.suppressionReason};
  }

  async function hold(delivery,assessment){
    const reason=assessment.suppressionReason??'no_eligible_match';
    const backlog=assessment.eligible&&reason!=='date_unverified';
    await env.DB.prepare(`UPDATE user_deliveries SET suppression_reason=?,backlog_at=CASE WHEN ? THEN COALESCE(backlog_at,?) ELSE backlog_at END,
      delivery_kind=CASE WHEN ? THEN 'daily_digest' ELSE delivery_kind END,available_at=?,updated_at=?
      WHERE id=? AND state='pending'`).bind(reason,backlog?1:0,now(),backlog?1:0,now()+5*minute,now(),delivery.id).run();
  }

  async function preparePending(){
    if(!enabled())return {disabled:true,prepared:0};
    const rows=await env.DB.prepare(`SELECT * FROM user_deliveries WHERE state='pending'
      AND delivery_kind='immediate' AND available_at<=? ORDER BY available_at,id LIMIT ?`).bind(now(),limit).all();
    let prepared=0;
    for(const delivery of rows.results){
      const assessment=await assess(delivery);
      if(!assessment.eligible||assessment.suppressionReason){await hold(delivery,assessment);continue;}
      if(assessment.mode!=='immediate'||delivery.backlog_at!==null){
        await env.DB.prepare(`UPDATE user_deliveries SET delivery_kind='daily_digest',updated_at=?
          WHERE id=? AND state='pending'`).bind(now(),delivery.id).run();continue;
      }
      const id=crypto.randomUUID().replaceAll('-','').slice(0,24),at=now();
      const origin=new URL(env.BASE_URL);
      if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
        throw new Error('mail_origin_invalid');
      const event=assessment.event,title=event.title.slice(0,500);
      const link=`${origin.origin}/articles/${event.articleId}?revision=${event.revisionId}`;
      const label=event.kind==='update'?'内容更新':'新通知';
      const payload={from:env.MAIL_FROM,to:assessment.recipient,subject:`${label}：${title}`.replace(/[\r\n]/g,' ').slice(0,200),
        text:`${label}\n${title}\n查看完整版本：${link}\n管理订阅：${origin.origin}/subscriptions`,
        html:`<h1>${escape(label)}</h1><p>${escape(title)}</p><p><a href="${escape(link)}">查看完整版本</a></p><p><a href="${escape(origin.origin)}/subscriptions">管理订阅</a></p>`,
        tags:[{name:'feed_message_id',value:id}]};
      if(typeof payload.from!=='string'||!payload.from||/[\r\n]/.test(payload.from))throw new Error('mail_sender_missing');
      const object=await savePrivate(JSON.stringify(payload));
      const recipientHash=await sha(payload.to.trim().toLowerCase());
      const checked=gate(assessment),key=`feed-mail/${id}`,outboxId=(await sha(`mail:${id}:0`)).slice(0,24);
      const message={v:1,type:'send-mail',outboxId,messageId:id};
      const result=await env.DB.batch([
        env.DB.prepare(`UPDATE user_deliveries SET state='claimed',claimed_message_id=?,suppression_reason=NULL,updated_at=?
          WHERE id=? AND state='pending' AND backlog_at IS NULL AND ${checked.sql}
          AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE recipient_hash=?)`)
          .bind(id,at,delivery.id,...checked.args,recipientHash),
        env.DB.prepare(`INSERT INTO mail_messages(id,owner_sub,kind,state,payload_key,payload_hash,recipient_hash,idempotency_key,next_attempt_at,created_at,updated_at)
          SELECT ?,?,'immediate','prepared',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM user_deliveries WHERE id=? AND claimed_message_id=?)`)
          .bind(id,delivery.owner_sub,object.key,object.hash,recipientHash,key,at,at,at,delivery.id,id),
        env.DB.prepare(`INSERT INTO mail_items(message_id,delivery_id,event_id,ordinal)
          SELECT ?,id,event_id,0 FROM user_deliveries WHERE id=? AND claimed_message_id=?`).bind(id,delivery.id,id),
        env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
          SELECT ?,'feed-mail',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_messages WHERE id=?)`)
          .bind(outboxId,`send-mail:${id}:0`,JSON.stringify(message),at,at,at,id),
      ]);
      prepared+=Number(result[0].meta.changes>0);
    }
    return {prepared};
  }

  async function savePrivate(text){
    const hash=await sha(text),key=`private/mail/sha256/${hash}`;
    const bytes=new TextEncoder().encode(text);
    await env.ARCHIVE.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:hash,httpMetadata:{contentType:'application/json'}});
    const stored=await env.ARCHIVE.get(key);
    if(!stored||stored.size!==bytes.length||await sha(await stored.arrayBuffer())!==hash)throw new Error('mail_snapshot_unavailable');
    return {key,hash};
  }

  async function readPrivate(key,hash){
    if(key!==`private/mail/sha256/${hash}`)throw new Error('mail_snapshot_invalid');
    const object=await env.ARCHIVE.get(key);
    if(!object)throw new Error('mail_snapshot_unavailable');
    const text=await object.text();
    if(await sha(text)!==hash)throw new Error('mail_snapshot_invalid');
    return JSON.parse(text);
  }

  async function deliver(id){
    if(!idPattern.test(id??''))throw new Error('mail_id_invalid');
    let message=await env.DB.prepare('SELECT * FROM mail_messages WHERE id=?').bind(id).first();
    if(!message)throw new Error('mail_message_missing');
    if(terminal.has(message.state))return {id,state:message.state};
    if(!enabled())return {id,state:message.state,disabled:true};
    let at=now();
    if(message.next_attempt_at===null)return {id,state:message.state};
    if(message.next_attempt_at>at||message.lease_until>at)return {id,state:message.state};
    if(message.submitted_at===null&&message.attempts>=maxAttempts){
      await env.DB.prepare(`UPDATE mail_messages SET state='deferred',last_error='retry_limit_reached',next_attempt_at=NULL,updated_at=?
        WHERE id=? AND submitted_at IS NULL AND (lease_until IS NULL OR lease_until<=?)`).bind(at,id,at).run();
      return {id,state:'deferred'};
    }
    const payload=await readPrivate(message.payload_key,message.payload_hash);
    if(message.submitted_at!==null){
      if(message.next_attempt_at===null)return {id,state:message.state};
      const expired=at-message.submitted_at>=23.5*3600_000;
      const exhausted=message.attempts>=maxAttempts;
      let reason=expired||exhausted?'reconciliation_required':null;
      if(!reason){
        const delivery=await env.DB.prepare(`SELECT d.* FROM user_deliveries d JOIN mail_items i ON i.delivery_id=d.id
          WHERE i.message_id=?`).bind(id).first();
        const current=await assess(delivery);
        if(!current.eligible||current.suppressionReason||current.recipient!==payload.to)
          reason='reconciliation_required';
      }
      if(reason){
        await env.DB.batch([
          env.DB.prepare(`UPDATE mail_messages SET state='submission_unknown',last_error=?,next_attempt_at=NULL,
            lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)
            AND state IN ('submitting','deferred','submission_unknown')`).bind(reason,at,id,at),
          env.DB.prepare(`UPDATE user_deliveries SET state='submission_unknown',updated_at=? WHERE claimed_message_id=?
            AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state='submission_unknown')`).bind(at,id,id),
        ]);
        return {id,state:'submission_unknown'};
      }
    }
    let checked=null;
    if(message.submitted_at===null){
      const delivery=await env.DB.prepare(`SELECT d.* FROM user_deliveries d JOIN mail_items i ON i.delivery_id=d.id
        WHERE i.message_id=?`).bind(id).first();
      if(!delivery)throw new Error('mail_claim_missing');
      const assessment=await assess(delivery);
      if(assessment.suppressionReason==='auth_unavailable'){
        await env.DB.prepare(`UPDATE mail_messages SET state='deferred',last_error='auth_unavailable',next_attempt_at=?,updated_at=?
          WHERE id=? AND submitted_at IS NULL AND (lease_until IS NULL OR lease_until<=?)`)
          .bind(at+minute,at,id,at).run();
        return {id,state:'deferred'};
      }
      const recovered=message.last_error==='auth_unavailable';
      if(recovered||!assessment.eligible||assessment.suppressionReason||assessment.mode!==message.kind||assessment.recipient!==payload.to){
        const reason=assessment.suppressionReason??(recovered?'recovered_backlog':!assessment.eligible?'no_eligible_match':assessment.recipient!==payload.to?'recipient_changed':'mode_changed');
        const backlog=Boolean(assessment.eligible&&(assessment.suppressionReason||recovered));
        await env.DB.batch([
          env.DB.prepare(`UPDATE mail_messages SET state='cancelled',last_error=?,next_attempt_at=NULL,updated_at=?
            WHERE id=? AND submitted_at IS NULL AND (lease_until IS NULL OR lease_until<=?)`).bind(reason,at,id,at),
          env.DB.prepare(`UPDATE user_deliveries SET state='pending',claimed_message_id=NULL,suppression_reason=?,
            backlog_at=CASE WHEN ? THEN COALESCE(backlog_at,?) ELSE backlog_at END,
            delivery_kind=CASE WHEN ? THEN 'daily_digest' ELSE delivery_kind END,updated_at=?
            WHERE claimed_message_id=? AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state='cancelled')`)
            .bind(['recipient_changed','mode_changed','recovered_backlog'].includes(reason)?null:reason,backlog?1:0,at,backlog?1:0,at,id,id),
        ]);
        return {id,state:'cancelled'};
      }
      checked=gate(assessment);
    }
    // Start the lease after potentially slow R2/Auth reads, and fence the state we assessed.
    at=now();
    const token=crypto.randomUUID();
    const acquired=await env.DB.prepare(`UPDATE mail_messages SET state='submitting',lease_token=?,lease_until=?,
      submitted_at=COALESCE(submitted_at,?),attempts=attempts+1,updated_at=?
      WHERE id=? AND state IN ('prepared','deferred','submitting','submission_unknown')
        AND attempts=? AND submitted_at IS ?
        AND (lease_until IS NULL OR lease_until<=?) AND next_attempt_at<=?
        AND (submitted_at IS NULL OR submitted_at>?)
        AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE recipient_hash=mail_messages.recipient_hash)
        ${checked?`AND ${checked.sql}`:''}`)
      .bind(token,at+2*minute,at,at,id,message.attempts,message.submitted_at,at,at,at-23.5*3600_000,...(checked?.args??[])).run();
    if(!acquired.meta.changes)return {id,state:'in_progress'};
    // A webhook may commit while the claim is acquired. No network request has happened yet.
    const suppression=await env.DB.prepare('SELECT reason FROM mail_suppressions WHERE recipient_hash=?').bind(message.recipient_hash).first();
    if(suppression){
      const uncertain=message.submitted_at!==null,state=uncertain?'submission_unknown':'cancelled';
      await env.DB.batch([
        env.DB.prepare(`UPDATE mail_messages SET state=?,last_error=?,submitted_at=?,next_attempt_at=NULL,
          lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?`)
          .bind(state,uncertain?'reconciliation_required':`email_${suppression.reason}`,message.submitted_at,at,id,token),
        env.DB.prepare(`UPDATE user_deliveries SET state=?,claimed_message_id=CASE WHEN ? THEN claimed_message_id ELSE NULL END,
          suppression_reason=?,delivery_kind=CASE WHEN ? THEN delivery_kind ELSE 'daily_digest' END,
          backlog_at=COALESCE(backlog_at,?),updated_at=? WHERE claimed_message_id=?
          AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state=?)`)
          .bind(uncertain?'submission_unknown':'pending',uncertain?1:0,`email_${suppression.reason}`,uncertain?1:0,at,at,id,id,state),
      ]);
      return {id,state};
    }
    const result=await provider.send(payload,{idempotencyKey:message.idempotency_key});
    if(result.status==='accepted'){
      await env.DB.batch([
        env.DB.prepare(`UPDATE mail_messages SET state='accepted',provider_id=?,accepted_at=COALESCE(accepted_at,?),
          lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,last_error=NULL,updated_at=?
          WHERE id=? AND lease_token=?`).bind(result.providerId,at,at,id,token),
        env.DB.prepare(`UPDATE user_deliveries SET state='accepted',updated_at=? WHERE claimed_message_id=?
          AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state='accepted')`)
          .bind(at,id,id),
      ]);
    }else{
      // A later rejection/429 says nothing about the earlier request whose reply was lost.
      const uncertain=message.submitted_at!==null;
      const state=result.status==='unknown'||uncertain?'submission_unknown':result.status==='rejected'?'rejected':'deferred';
      const manual=uncertain&&result.status==='rejected';
      await env.DB.batch([
        env.DB.prepare(`UPDATE mail_messages SET state=?,lease_token=NULL,lease_until=NULL,last_error=?,
          submitted_at=CASE WHEN ? THEN NULL ELSE submitted_at END,next_attempt_at=?,updated_at=? WHERE id=? AND lease_token=?`)
          .bind(state,manual?'reconciliation_required':safeCode(result.code),result.status==='deferred'&&message.submitted_at===null?1:0,
            state==='rejected'||manual?null:at+Math.min(6*3600_000,Math.max(minute,result.retryAfterMs??minute*2**Math.min(message.attempts,8))),at,id,token),
        env.DB.prepare(`UPDATE user_deliveries SET state=?,suppression_reason=?,updated_at=? WHERE claimed_message_id=?
          AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state=?)`)
          .bind(state==='submission_unknown'?'submission_unknown':state==='rejected'?'suppressed':'claimed',safeCode(result.code),at,id,id,state),
      ]);
    }
    return {id,state:(await env.DB.prepare('SELECT state FROM mail_messages WHERE id=?').bind(id).first()).state};
  }

  async function recover(){
    const receipts=await env.DB.prepare(`SELECT id FROM mail_webhook_receipts WHERE state='pending' AND next_attempt_at<=? AND attempts<6
      ORDER BY received_at,id LIMIT ?`).bind(now(),limit).all();
    for(const receipt of receipts.results){
      try{await applyReceipt(receipt.id);}catch{await deferReceipt(receipt.id);}
    }
    if(!enabled())return {disabled:true,receipts:receipts.results.length};
    const prepared=await preparePending();
    const rows=await env.DB.prepare(`SELECT id,attempts FROM mail_messages WHERE state IN ('prepared','deferred','submitting','submission_unknown')
      AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)
      ORDER BY updated_at,id LIMIT ?`).bind(now(),now(),limit).all();
    for(const row of rows.results){
      const outboxId=(await sha(`mail:${row.id}:${row.attempts}`)).slice(0,24),at=now();
      // Queue retries are finite, but Cron must also stop resurrecting a poison message.
      // Dispatch attempts survive failures that happen before the provider lease can be acquired.
      const stopped=await env.DB.batch([
        env.DB.prepare(`UPDATE mail_messages SET state=CASE WHEN submitted_at IS NULL THEN 'deferred' ELSE 'submission_unknown' END,
          last_error=CASE WHEN submitted_at IS NULL THEN 'retry_limit_reached' ELSE 'reconciliation_required' END,
          next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND attempts=? AND state IN ('prepared','deferred','submitting','submission_unknown')
          AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)
          AND EXISTS(SELECT 1 FROM outbox WHERE id=? AND attempts>=?)`)
          .bind(at,row.id,row.attempts,at,at,outboxId,maxAttempts),
        env.DB.prepare(`UPDATE user_deliveries SET state='submission_unknown',updated_at=? WHERE claimed_message_id=?
          AND EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state='submission_unknown' AND next_attempt_at IS NULL)`)
          .bind(at,row.id,row.id),
      ]);
      if(stopped[0].meta.changes)continue;
      await env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
        SELECT ?,'feed-mail',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND attempts=?
          AND state IN ('prepared','deferred','submitting','submission_unknown') AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?))
        ON CONFLICT(topic,dedupe_key) DO UPDATE SET state='queued',available_at=excluded.available_at,updated_at=excluded.updated_at
        WHERE outbox.attempts<?`)
        .bind(outboxId,`send-mail:${row.id}:${row.attempts}`,JSON.stringify({v:1,type:'send-mail',outboxId,messageId:row.id}),at,at,at,row.id,row.attempts,at,at,maxAttempts).run();
    }
    return {...prepared,recovered:rows.results.length};
  }

  async function receiveWebhook(request){
    const event=await provider.verifyWebhook(request);
    const object=await savePrivate(JSON.stringify(event));
    await env.DB.prepare(`INSERT INTO mail_webhook_receipts(id,payload_key,payload_hash,received_at)
      VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(event.id,object.key,object.hash,now()).run();
    const saved=await env.DB.prepare('SELECT payload_hash,state FROM mail_webhook_receipts WHERE id=?').bind(event.id).first();
    if(saved.payload_hash!==object.hash){const error=new Error('webhook_receipt_conflict');error.status=409;throw error;}
    if(saved.state!=='pending')return {received:true};
    try{await applyReceipt(event.id);}catch{return {received:true,pending:true};}
    return {received:true};
  }

  async function deferReceipt(id){
    await env.DB.prepare(`UPDATE mail_webhook_receipts SET attempts=attempts+1,next_attempt_at=?,last_error='receipt_apply_failed'
      WHERE id=? AND state='pending'`).bind(now()+5*minute,id).run();
  }

  async function reconcile(id){
    if(!idPattern.test(id??''))return null;
    const message=await env.DB.prepare('SELECT * FROM mail_messages WHERE id=?').bind(id).first();
    if(!message)return null;
    if(!message.provider_id)return {id,state:message.state,reason:'provider_identity_required'};
    const result=await provider.get(message.provider_id);
    if(result.status!=='found'||result.event==='unknown')return {id,state:message.state,reason:'provider_unavailable'};
    const receiptId=`lookup:${id}:${result.event}`;
    const event={id:receiptId,type:result.event,providerId:result.providerId,recipient:result.recipient,tags:result.tags,occurredAt:now()};
    const object=await savePrivate(JSON.stringify(event));
    await env.DB.prepare(`INSERT INTO mail_webhook_receipts(id,payload_key,payload_hash,received_at)
      VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(receiptId,object.key,object.hash,now()).run();
    await applyReceipt(receiptId);
    return {id,state:(await env.DB.prepare('SELECT state FROM mail_messages WHERE id=?').bind(id).first()).state};
  }

  async function applyReceipt(id){
    const receipt=await env.DB.prepare("SELECT * FROM mail_webhook_receipts WHERE id=? AND state='pending'").bind(id).first();
    if(!receipt)return;
    const event=await readPrivate(receipt.payload_key,receipt.payload_hash);
    const tagged=event.tags?.feed_message_id;
    const message=await env.DB.prepare(`SELECT * FROM mail_messages WHERE provider_id=? OR id=? ORDER BY provider_id IS NULL LIMIT 1`)
      .bind(event.providerId,idPattern.test(tagged??'')?tagged:'').first();
    if(!message||event.type==='ignored'||message.submitted_at===null
      ||(message.provider_id!==null&&message.provider_id!==event.providerId)
      ||(tagged&&tagged!==message.id)||message.recipient_hash!==await sha(event.recipient.trim().toLowerCase())){
      await env.DB.prepare("UPDATE mail_webhook_receipts SET state='ignored',processed_at=? WHERE id=? AND state='pending'").bind(now(),id).run();
      return;
    }
    const columns={accepted:'accepted_at',delivered:'delivered_at',bounced:'bounced_at',complained:'complained_at'};
    const column=columns[event.type];
    if(!column)throw new Error('webhook_event_invalid');
    const at=now(),state=`CASE WHEN complained_at IS NOT NULL OR ?='complained' THEN 'complained'
      WHEN bounced_at IS NOT NULL OR ?='bounced' THEN 'bounced'
      WHEN delivered_at IS NOT NULL OR ?='delivered' THEN 'delivered' ELSE 'accepted' END`;
    const statements=[
      env.DB.prepare(`UPDATE mail_messages SET provider_id=?,${column==='accepted_at'?'':`${column}=COALESCE(${column},?),`}
        accepted_at=COALESCE(accepted_at,?),state=${state},lease_token=NULL,lease_until=NULL,
        next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND (provider_id IS NULL OR provider_id=?)`)
        .bind(event.providerId,...(column==='accepted_at'?[]:[event.occurredAt]),event.occurredAt,event.type,event.type,event.type,at,message.id,event.providerId),
      env.DB.prepare(`UPDATE user_deliveries SET state=CASE
        WHEN EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state IN ('bounced','complained')) THEN 'suppressed'
        WHEN EXISTS(SELECT 1 FROM mail_messages WHERE id=? AND state='delivered') THEN 'delivered' ELSE 'accepted' END,
        suppression_reason=(SELECT CASE WHEN state IN ('bounced','complained') THEN 'email_'||state ELSE NULL END FROM mail_messages WHERE id=?),
        updated_at=? WHERE claimed_message_id=?`).bind(message.id,message.id,message.id,at,message.id),
    ];
    if(['bounced','complained'].includes(event.type))statements.push(env.DB.prepare(`INSERT INTO mail_suppressions(recipient_hash,reason,provider_id,created_at)
      VALUES (?,?,?,?) ON CONFLICT(recipient_hash) DO UPDATE SET reason=CASE WHEN mail_suppressions.reason='complained' THEN 'complained' ELSE excluded.reason END`)
      .bind(message.recipient_hash,event.type,event.providerId,at));
    statements.push(env.DB.prepare("UPDATE mail_webhook_receipts SET state='processed',message_id=?,processed_at=? WHERE id=? AND state='pending'")
      .bind(message.id,at,id));
    await env.DB.batch(statements);
  }
  return {preparePending,deliver,recover,list,receiveWebhook,reconcile};
}

export async function handleMailMessage(body,env,dependencies){
  if(!body||body.v!==1||body.type!=='send-mail'||!idPattern.test(body.outboxId??'')||!idPattern.test(body.messageId??'')
    ||Object.keys(body).sort().join(',')!=='messageId,outboxId,type,v')throw new Error('mail_message_invalid');
  const row=await env.DB.prepare("SELECT payload_json FROM outbox WHERE id=? AND topic='feed-mail'").bind(body.outboxId).first();
  if(!row||row.payload_json!==JSON.stringify(body))throw new Error('mail_outbox_mismatch');
  return createMail(env,dependencies).deliver(body.messageId);
}
