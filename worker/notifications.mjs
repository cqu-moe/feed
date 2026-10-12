import {sha} from './utils.mjs';
import {createFeedAuthClient} from './feed-auth-client.mjs';
import {computeSubscriptionRuntime} from './subscription-runtime.mjs';
import {rssUrlForOwner} from './subscription-credentials.mjs';
import {storeTextObject,verifyObject} from './archive-objects.mjs';

const idPattern=/^[a-f0-9]{24}$/;

export function createNotifications(env,{now=()=>Date.now()}={}){
  const auth=createFeedAuthClient(env);
  const timestamp=()=>{const value=now();return value instanceof Date?value.getTime():value;};

  async function eventWithSources(eventId){
    const event=await env.DB.prepare(`SELECT e.id,e.revision_id AS revisionId,e.article_id AS articleId,
        e.kind,e.observed_at AS observedAt,e.ready_at AS readyAt,e.history_only AS historyOnly,
        r.title,r.change_kind AS changeKind
      FROM content_events e JOIN article_revisions r ON r.id=e.revision_id WHERE e.id=?`)
      .bind(eventId).first();
    if(!event)return null;
    const sources=await env.DB.prepare(`SELECT es.*,(
        SELECT corrected_dates_json FROM event_source_corrections c
        WHERE c.event_id=es.event_id AND c.source_id=es.source_id
        ORDER BY generation DESC LIMIT 1
      ) AS corrected_dates_json,(
        SELECT generation FROM event_source_corrections c
        WHERE c.event_id=es.event_id AND c.source_id=es.source_id
        ORDER BY generation DESC LIMIT 1
      ) AS correction_generation
      FROM event_sources es WHERE es.event_id=? ORDER BY es.source_id`)
      .bind(eventId).all();
    return {event,sources:sources.results.map(source=>({...source,evidence:correctedEvidence(source)}))};
  }

  function correctedEvidence(source){
    const base={
      firstSeenAt:source.article_source_first_seen_at,
      discoveryClass:source.discovery_class,
      publishedAt:source.published_at,
      publishedDay:source.published_day,
      datePrecision:source.date_precision,
      timezone:source.source_timezone,
    };
    if(!source.corrected_dates_json)return base;
    let correction;
    try{correction=JSON.parse(source.corrected_dates_json);}catch{return base;}
    return {
      ...base,
      ...(correction.datePrecision?{datePrecision:correction.datePrecision}:{}),
      ...(correction.publishedAt!==undefined?{publishedAt:correction.publishedAt}:{}),
      ...(correction.publishedDay!==undefined?{publishedDay:correction.publishedDay}:{}),
      correctionGeneration:source.correction_generation,
    };
  }

  async function matchTaskStatements({eventId,sourceId,generation=0,page=0}){
    const businessKey=`match:${eventId}:${sourceId}:g${generation}`;
    const taskId=(await sha(businessKey)).slice(0,24);
    const dedupeKey=`match-source:${taskId}:p${page}`;
    const outboxId=(await sha(`outbox:${dedupeKey}`)).slice(0,24);
    const at=timestamp();
    return {
      taskId,
      message:{v:1,type:'match-source',outboxId,taskId,eventId,sourceId,generation,page},
      statements:[
        env.DB.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,priority,due_at,attempt_no,created_at,updated_at)
          SELECT ?,'match-event',?,?,?,?,'queued',70,?,1,?,?
          WHERE EXISTS(SELECT 1 FROM content_events WHERE id=?) AND EXISTS(SELECT 1 FROM event_sources WHERE event_id=? AND source_id=?)
          ON CONFLICT(business_key) DO NOTHING`)
          .bind(taskId,businessKey,sourceId,(await eventWithSources(eventId))?.event.articleId,
            JSON.stringify({eventId,sourceId,generation}),at,at,at,eventId,eventId,sourceId),
        env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
          SELECT ?,'feed-events',?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM tasks WHERE id=? AND state IN ('queued','running'))
          ON CONFLICT(topic,dedupe_key) DO NOTHING`)
          .bind(outboxId,dedupeKey,JSON.stringify({v:1,type:'match-source',outboxId,taskId,eventId,sourceId,generation,page}),
            at,at,at,taskId),
      ],
    };
  }

  async function enqueueEvent(eventId){
    if(!idPattern.test(eventId??''))throw validationError('Invalid content event id',400);
    const current=await eventWithSources(eventId);
    if(!current)throw validationError('Content event not found',404);
    const statements=[];
    const messages=[];
    for(const source of current.sources){
      const built=await matchTaskStatements({
        eventId,sourceId:source.source_id,generation:source.evidence.correctionGeneration??0,
      });
      messages.push(built.message);
      statements.push(...built.statements);
    }
    const committed=await env.DB.batch(statements);
    return {tasks:committed.filter((_,index)=>index%2===0).reduce((total,result)=>total+(result.meta?.changes??0),0),messages};
  }

  async function reconcileSourceAssociation(input){
    const rows=await env.DB.prepare(`SELECT e.id,COALESCE((SELECT MAX(generation) FROM event_source_corrections
        WHERE event_id=e.id AND source_id=?),0) AS generation
      FROM content_events e WHERE e.article_id=? AND e.id>? ORDER BY e.id LIMIT 51`)
      .bind(input.sourceId,input.articleId,input.afterEventId).all();
    const page=rows.results.slice(0,50),statements=[];
    for(const event of page){
      statements.push(env.DB.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,
          discovery_class,published_at,published_day,date_precision,source_timezone)
        SELECT ?,source_id,first_seen_at,discovery_class,published_at,published_day,date_precision,source_timezone
        FROM article_sources WHERE article_id=? AND source_id=?
        ON CONFLICT(event_id,source_id) DO NOTHING`).bind(event.id,input.articleId,input.sourceId));
      const matching=await matchTaskStatements({eventId:event.id,sourceId:input.sourceId,generation:event.generation});
      statements.push(...matching.statements);
    }
    if(rows.results.length>50){
      const continuation=await articleSourceAssociationStatements(env,{
        ...input,afterEventId:page.at(-1).id,timestamp:timestamp(),
      });
      statements.push(...continuation.statements);
    }
    if(statements.length)await env.DB.batch(statements);
    return {associated:page.length,hasNext:rows.results.length>50};
  }

  async function verifyDate(eventId,command){
    if(!idPattern.test(eventId??''))throw validationError('Invalid content event id',400);
    if(!command||typeof command!=='object'||Array.isArray(command))throw validationError('Invalid date verification command',400);
    const sourceId=command.sourceId;
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(sourceId??''))throw validationError('Invalid event source',400);
    if(!/^[A-Za-z0-9._:-]{8,100}$/.test(command.requestId??''))throw validationError('Invalid date verification request id',400);
    if(typeof command.verifiedBy!=='string'||!/^\S.{0,79}$/.test(command.verifiedBy))
      throw validationError('Invalid verified operator',400);
    if(!command.evidence||typeof command.evidence!=='object'||Array.isArray(command.evidence))
      throw validationError('Date verification evidence is required',400);

    const current=await eventWithSources(eventId);
    if(!current)throw validationError('Content event not found',404);
    const source=current.sources.find(item=>item.source_id===sourceId);
    if(!source)throw validationError('Event source is missing',404);
    const dates=correctedDates(command,source.source_timezone);
    const commandHash=await sha(JSON.stringify({requestId:command.requestId,eventId,sourceId,
      verifiedBy:command.verifiedBy,dates,evidence:command.evidence}));
    const replay=await env.DB.prepare(`SELECT * FROM event_source_corrections
      WHERE event_id=? AND source_id=? AND request_id=?`).bind(eventId,sourceId,command.requestId).first();
    if(replay){
      if(replay.command_hash!==commandHash)throw validationError('Date verification request conflicts with its original content',409);
      return correctionResult(replay);
    }
    const at=timestamp();
    const record={v:1,eventId,sourceId,verifiedBy:command.verifiedBy,verifiedAt:at,
      datePrecision:dates.datePrecision,publishedAt:dates.publishedAt,publishedDay:dates.publishedDay,
      evidence:command.evidence};
    const evidenceText=JSON.stringify(record);
    if(evidenceText.length>65536)throw validationError('Date verification evidence is too large',400);
    const object=await storeTextObject(env,evidenceText,'application/json');
    const generation=(source.evidence.correctionGeneration??0)+1;
    const correctionId=(await sha(`date-correction:${eventId}:${sourceId}:g${generation}`)).slice(0,24);
    const built=await matchTaskStatements({eventId,sourceId,generation});
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
        VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`)
        .bind(object.sha256,object.r2Key,object.byteSize,object.mediaType,object.verifiedAt),
      env.DB.prepare(`INSERT INTO event_source_corrections(id,event_id,source_id,generation,evidence_object_hash,
          corrected_dates_json,request_id,command_hash,verified_by,verified_at,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM artifact_objects WHERE sha256=?)
          AND EXISTS(SELECT 1 FROM event_sources WHERE event_id=? AND source_id=?)
        ON CONFLICT DO NOTHING`)
        .bind(correctionId,eventId,sourceId,generation,object.sha256,JSON.stringify(dates),
          command.requestId,commandHash,command.verifiedBy,at,at,object.sha256,eventId,sourceId),
      ...built.statements,
    ]);
    const committed=await env.DB.prepare('SELECT * FROM event_source_corrections WHERE command_hash=?')
      .bind(commandHash).first();
    if(!committed)throw validationError('Date correction was superseded',409);
    return correctionResult(committed);
  }

  function correctedDates(command,timezone){
    const precision=command.datePrecision;
    if(precision==='unknown')return {datePrecision:precision,publishedAt:null,publishedDay:null};
    if(precision==='day'){
      const day=command.publishedDay;
      if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10)!==day)
        throw validationError('Invalid corrected publication day',400);
      if(command.publishedAt!==undefined&&command.publishedAt!==null)
        throw validationError('Day precision cannot set an exact time',400);
      return {datePrecision:precision,publishedAt:null,publishedDay:day,timezone};
    }
    if(precision==='minute'){
      const value=command.publishedAt;
      if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)
        throw validationError('Invalid corrected publication time',400);
      if(command.publishedDay!==undefined&&command.publishedDay!==null)
        throw validationError('Minute precision must not separately set a day',400);
      return {datePrecision:precision,publishedAt:value,publishedDay:null,timezone};
    }
    throw validationError('Invalid corrected date precision',400);
  }

  function correctionResult(row){
    return {correction:{eventId:row.event_id,sourceId:row.source_id,generation:row.generation,
      evidenceObjectHash:row.evidence_object_hash,verifiedBy:row.verified_by,
      verifiedAt:iso(row.verified_at,'correction verified')}};
  }

  async function readDateEvidence(eventId,sourceId,generation){
    if(!idPattern.test(eventId??'')||!/^[A-Za-z0-9_-]{1,64}$/.test(sourceId??'')
      ||!Number.isSafeInteger(generation)||generation<1)return null;
    const row=await env.DB.prepare(`SELECT c.*,o.r2_key,o.byte_size,o.media_type
      FROM event_source_corrections c JOIN artifact_objects o ON o.sha256=c.evidence_object_hash
      WHERE c.event_id=? AND c.source_id=? AND c.generation=?`)
      .bind(eventId,sourceId,generation).first();
    if(!row)return null;
    await verifyObject(env,{sha256:row.evidence_object_hash,r2Key:row.r2_key,
      byteSize:row.byte_size,mediaType:row.media_type});
    const object=await env.ARCHIVE.get(row.r2_key);
    if(!object)throw validationError('Date verification evidence is unavailable',503);
    const evidence=await object.json();
    if(evidence?.eventId!==eventId||evidence?.sourceId!==sourceId)
      throw validationError('Date verification evidence identity is invalid',500);
    return evidence;
  }

  async function processMatchTask(payload){
    const input=parseMatchMessage(payload);
    const task=await env.DB.prepare(`SELECT * FROM tasks WHERE id=? AND kind='match-event'`).bind(input.taskId).first();
    if(!task)throw validationError('Match task not found',404);
    if(task.state==='succeeded')return {state:'succeeded',page:checkpoint(task).page,hasNext:false};
    const context=JSON.parse(task.payload_json);
    if(context.eventId!==input.eventId||context.sourceId!==input.sourceId||context.generation!==input.generation)
      throw validationError('Match message does not match its task',409);
    const before=checkpoint(task),pageSize=boundedInteger(env.NOTIFICATION_MATCH_PAGE_SIZE,50,1,50);
    if(before.page!==input.page)return {state:'superseded',page:before.page,hasNext:before.hasNext};
    const current=await eventWithSources(input.eventId);
    if(!current)throw validationError('Content event not found',404);
    const source=current.sources.find(item=>item.source_id===input.sourceId);
    if(!source)throw validationError('Event source is missing',404);
    if((source.evidence.correctionGeneration??0)>input.generation){
      await cancelSupersededMatch(task.id,input);
      return {state:'superseded',page:before.page,hasNext:false};
    }
    const taskGate=`EXISTS(SELECT 1 FROM tasks current WHERE current.id=? AND current.kind='match-event'
      AND current.state='queued' AND current.checkpoint_json IS ?)
      AND COALESCE((SELECT MAX(generation) FROM event_source_corrections WHERE event_id=? AND source_id=?),0)=?
      AND (SELECT COUNT(*) FROM event_source_corrections WHERE event_id=?)=?`;
    const taskArgs=[task.id,task.checkpoint_json,input.eventId,input.sourceId,input.generation,input.eventId,
      current.sources.reduce((sum,item)=>sum+(item.evidence.correctionGeneration??0),0)];

    const targets=await env.DB.prepare(`SELECT t.id AS target_id,t.effective_from,s.id AS subscription_id,
        s.owner_sub,s.name,s.requested_enabled,s.priority,s.email_mode,s.created_at,s.deleted_at
      FROM subscription_sources t JOIN subscriptions s ON s.id=t.subscription_id
      WHERE t.source_id=? AND t.removed_at IS NULL AND s.deleted_at IS NULL
        AND (?='' OR t.id>?)
      ORDER BY t.id LIMIT ?`)
      .bind(input.sourceId,before.lastTargetId??'',before.lastTargetId??'',pageSize+1).all();
    const page=targets.results.slice(0,pageSize);
    if(!page.length){
      const at=timestamp(),checkpointJson=JSON.stringify({...before,page:before.page,hasNext:false});
      await env.DB.batch([
        env.DB.prepare(`UPDATE tasks SET state='succeeded',checkpoint_json=?,updated_at=?
          WHERE id=? AND state='queued' AND checkpoint_json IS ?`)
          .bind(checkpointJson,at,task.id,task.checkpoint_json),
      ]);
      await cancelSupersededMatch(task.id,input);
      return {state:'succeeded',page:before.page,hasNext:false};
    }

    const runtimes=await subscriptionRuntimes(page.map(row=>row.owner_sub));
    const decisions=page.map(row=>decide(current.event,source.evidence,row));
    const hasNext=targets.results.length>pageSize;
    const page_number=before.page+1;
    const next={lastTargetId:page.at(-1).target_id,page:page_number,hasNext};
    const nextCheckpoint=JSON.stringify(next);
    const at=timestamp();
    const statements=[];
    for(const [index,row] of page.entries()){
      const decision=decisions[index];
      statements.push(env.DB.prepare(`INSERT INTO notification_matches(event_id,subscription_id,target_id,owner_sub,eligibility_kind,reason,matched_at)
        SELECT ?,?,?,?,?,?,? WHERE ${taskGate}
        ON CONFLICT(event_id,subscription_id,target_id) DO UPDATE SET
          eligibility_kind=excluded.eligibility_kind,reason=excluded.reason,matched_at=excluded.matched_at`)
        .bind(input.eventId,row.subscription_id,row.target_id,row.owner_sub,decision.kind,decision.reason,at,...taskArgs));
    }
    const owners=await ownerCandidates(current,[...new Set(page.map(row=>row.owner_sub))],runtimes);
    for(const [ownerSub,candidate] of owners){
      if(!candidate.eligible){
        statements.push(env.DB.prepare(`UPDATE user_deliveries SET suppression_reason=?,updated_at=?
          WHERE owner_sub=? AND event_id=? AND state='pending' AND ${taskGate}`)
          .bind(candidate.suppressionReason,at,ownerSub,input.eventId,...taskArgs));
        continue;
      }
      const deliveryId=(await sha(`delivery:${ownerSub}:${input.eventId}`)).slice(0,24);
      statements.push(env.DB.prepare(`INSERT INTO user_deliveries(id,owner_sub,event_id,state,delivery_kind,available_at,suppression_reason,backlog_at,created_at,updated_at)
        SELECT ?,?,?,'pending',?,?,?,?,?,? WHERE ${taskGate}
        ON CONFLICT(owner_sub,event_id) DO UPDATE SET
          delivery_kind=CASE WHEN user_deliveries.state='pending'
            THEN CASE WHEN COALESCE(user_deliveries.backlog_at,excluded.backlog_at) IS NOT NULL
              THEN 'daily_digest' ELSE excluded.delivery_kind END
            ELSE user_deliveries.delivery_kind END,
          suppression_reason=CASE WHEN user_deliveries.state='pending' THEN excluded.suppression_reason ELSE user_deliveries.suppression_reason END,
          backlog_at=COALESCE(user_deliveries.backlog_at,excluded.backlog_at),
          updated_at=excluded.updated_at`)
        .bind(deliveryId,ownerSub,input.eventId,candidate.mode,current.event.readyAt,candidate.suppressionReason,
          candidate.suppressionReason?at:null,at,at,...taskArgs));
    }
    if(hasNext){
      const continuation=await matchTaskStatements({eventId:input.eventId,sourceId:input.sourceId,
        generation:input.generation,page:page_number});
      if(continuation.taskId!==task.id)throw validationError('Continuation changed match task identity',409);
      statements.push(env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
        SELECT ?,'feed-events',?,?,?,?,? WHERE ${taskGate}
        ON CONFLICT(topic,dedupe_key) DO NOTHING`)
        .bind(continuation.message.outboxId,`match-source:${task.id}:p${page_number}`,
          JSON.stringify(continuation.message),at,at,at,...taskArgs));
    }
    statements.push(env.DB.prepare(`UPDATE tasks SET state=?,checkpoint_json=?,updated_at=?
      WHERE id=? AND ${taskGate}`)
      .bind(hasNext?'queued':'succeeded',nextCheckpoint,at,task.id,...taskArgs));
    const committed=await env.DB.batch(statements);
    if(!committed.at(-1).meta?.changes){
      await cancelSupersededMatch(task.id,input);
      const latest=await env.DB.prepare('SELECT state,checkpoint_json FROM tasks WHERE id=?').bind(task.id).first();
      if(latest.state==='queued'&&latest.checkpoint_json===task.checkpoint_json)
        throw validationError('Source evidence changed during matching; retry',409);
      return {state:'superseded',page:before.page,hasNext:before.hasNext};
    }
    return {state:hasNext?'queued':'succeeded',page:page_number,hasNext};
  }

  async function ownerCandidates(current,owners,runtimes){
    const rows=await env.DB.prepare(`SELECT s.owner_sub,s.id AS subscription_id,s.email_mode,t.effective_from,t.source_id
      FROM subscriptions s JOIN subscription_sources t ON t.subscription_id=s.id AND t.removed_at IS NULL
      JOIN event_sources es ON es.source_id=t.source_id AND es.event_id=?
      WHERE s.deleted_at IS NULL AND s.owner_sub IN (${owners.map(()=>'?').join(',')})`)
      .bind(current.event.id,...owners).all();
    const result=new Map(owners.map(owner=>[owner,{eligible:false,suppressionReason:'no_eligible_match'}]));
    const sources=new Map(current.sources.map(source=>[source.source_id,source.evidence]));
    for(const row of rows.results){
      if(!sources.has(row.source_id))throw validationError('Source association changed during matching; retry',409);
      const decision=decide(current.event,sources.get(row.source_id),row);
      const previous=result.get(row.owner_sub);
      if(!decision.eligible){
        if(!previous.eligible&&decision.kind==='pending')previous.suppressionReason='date_unverified';
        continue;
      }
      const runtime=runtimes.get(row.subscription_id);
      const suppressionReason=runtime?.emailStatus==='active'?null:runtime?.emailStatus??'auth_unavailable';
      const candidate={...decision,suppressionReason,mode:suppressionReason?'daily_digest':decision.mode};
      if(!previous.eligible||(previous.suppressionReason&&!suppressionReason)
        ||(!suppressionReason&&candidate.mode==='immediate'))result.set(row.owner_sub,candidate);
    }
    return result;
  }

  async function cancelSupersededMatch(taskId,input){
    await env.DB.prepare(`UPDATE tasks SET state='cancelled',last_error='date_generation_superseded',updated_at=?
      WHERE id=? AND state='queued' AND EXISTS(SELECT 1 FROM event_source_corrections
        WHERE event_id=? AND source_id=? AND generation>?)`)
      .bind(timestamp(),taskId,input.eventId,input.sourceId,input.generation).run();
  }

  async function subscriptionRuntimes(ownerSubs){
    const owners=[...new Set(ownerSubs)];
    if(!owners.length)return new Map();
    const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
        email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
        rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
        rss_revoked_at AS rssRevokedAt,deleted_at IS NOT NULL AS deleted,config_version AS configVersion
      FROM subscriptions WHERE owner_sub IN (${owners.map(()=>'?').join(',')}) ORDER BY priority,created_at,id`)
      .bind(...owners).all();
    const result=new Map();
    for(const owner of owners){
      const account=await auth.getRecipient(owner);
      const policyState=account.ok
        ?{status:'available',policy:account.data.policy}
        :{status:'auth_unavailable',policy:{access:false,subscriptionLimit:{kind:'missing'}}};
      const runtimes=computeSubscriptionRuntime(rows.results.filter(row=>row.ownerSub===owner),policyState,
        account.ok?account.data.recipient.status:'unverified');
      for(const [subscriptionId,runtime] of runtimes)result.set(subscriptionId,runtime);
    }
    return result;
  }

  function decide(event,source,row){
    const evidence=source;
    if(event.historyOnly===1||(event.kind==='initial'&&evidence.discoveryClass!=='live'))
      return decision(false,'suppressed','历史导入或迁移基线不补发邮件');
    if(evidence.datePrecision==='unknown')
      return decision(false,'pending','日期待核实');
    if(event.kind==='update'){
      if(event.observedAt<row.effective_from)
        return decision(false,'suppressed','修改发生在栏目生效前');
      if(event.observedAt<evidence.firstSeenAt)
        return decision(false,'suppressed','栏目在修改观察后才出现');
      return decision(true,'update','修改在栏目生效后发生',row.email_mode);
    }
    if(evidence.firstSeenAt<row.effective_from)
      return decision(false,'suppressed','订阅前已观察到的内容不补发');
    if(evidence.datePrecision==='minute'){
      if(Date.parse(evidence.publishedAt)<row.effective_from)
        return decision(false,'suppressed','发布时间早于栏目生效时间');
      return decision(true,'new','发布时间不早于栏目生效时间',row.email_mode);
    }
    const effectiveDay=localDay(row.effective_from,evidence.timezone);
    if((evidence.publishedDay??'')<effectiveDay||evidence.firstSeenAt<row.effective_from)
      return decision(false,'suppressed','发布日期或首次发现早于栏目生效');
    return decision(true,'new','发布日期不早于栏目生效当天',row.email_mode);
  }

  function decision(eligible,kind,reason,emailMode='off'){
    if(!eligible)return {eligible,kind,reason,mode:null};
    if(emailMode==='off')return {eligible:false,kind:'suppressed',reason:'邮件已关闭',mode:'off'};
    return {eligible:true,kind,reason,mode:emailMode};
  }

  async function subscriptionMatches(subscriptionId,runtime){
    if(!idPattern.test(subscriptionId??''))return [];
    const rows=await env.DB.prepare(`SELECT m.event_id AS eventId,e.kind AS eventKind,r.title,m.eligibility_kind AS eligibilityKind,
        m.reason,e.ready_at AS readyAt,m.matched_at AS matchedAt,s.email_mode AS emailMode,
        d.id AS deliveryId,d.state AS deliveryState,d.delivery_kind AS deliveryKind,d.suppression_reason AS suppressionReason,
        es.date_precision AS sourceDatePrecision,c.corrected_dates_json AS correctedDatesJson,c.generation AS correctionGeneration
      FROM notification_matches m
      JOIN content_events e ON e.id=m.event_id
      JOIN article_revisions r ON r.id=e.revision_id
      JOIN subscriptions s ON s.id=m.subscription_id
      LEFT JOIN event_sources es ON es.event_id=m.event_id AND es.source_id IN
        (SELECT source_id FROM subscription_sources WHERE id=m.target_id)
      LEFT JOIN event_source_corrections c ON c.event_id=m.event_id AND c.source_id=es.source_id
        AND c.generation=(SELECT MAX(generation) FROM event_source_corrections where event_id=m.event_id AND source_id=es.source_id)
      LEFT JOIN user_deliveries d ON d.owner_sub=m.owner_sub AND d.event_id=m.event_id
      WHERE m.subscription_id=? ORDER BY m.matched_at DESC,m.event_id LIMIT 50`)
      .bind(subscriptionId).all();
    return rows.results.map(row=>{
      let status,reason=row.reason;
      if(row.eligibilityKind==='pending'){
        status='waiting_date_verification';reason='日期待核实';
      }else if(row.reason==='邮件已关闭'||row.emailMode==='off'){
        status='mail_off';reason='邮件已关闭';
      }else if(row.eligibilityKind==='suppressed'){
        status='suppressed';
      }else if(row.deliveryState==='pending'&&runtime&&runtime.emailStatus!=='active'){
        status=runtime.emailStatus;
        reason={auth_unavailable:'Auth 暂不可用，候选已保留',quota_exceeded:'超出当前额度，候选已保留',
          email_unverified:'邮箱未验证，候选已保留',paused:'订阅已暂停，候选已保留',
          access_revoked:'访问权益已停用，候选已保留',deleted:'订阅已删除，候选已保留'}[status]??'候选已保留，等待恢复';
      }else if(row.deliveryId&&row.deliveryKind==='immediate'){
        status=row.deliveryState==='pending'
          ?(row.emailMode==='immediate'?'pending_immediate':'merged_immediate')
          :row.deliveryState;
        if(row.deliveryState==='pending'&&row.emailMode!=='immediate'&&row.reason!=='邮件已关闭')
          reason='同一事件已被及时提醒占用';
      }else if(row.deliveryId){
        status=row.deliveryState==='pending'?'pending_daily_digest':row.deliveryState;
      }else{
        status='suppressed';reason=row.reason||'按历史规则抑制';
      }
      return {
        eventId:row.eventId,eventKind:row.eventKind,title:row.title,status,reason,
        readyAt:new Date(row.readyAt).toISOString(),matchedAt:new Date(row.matchedAt).toISOString(),
        datePrecision:row.correctedDatesJson?parseCorrectedDates(row.correctedDatesJson).datePrecision:row.sourceDatePrecision,
      };
    });
  }

  async function readSubscription(subscriptionId,ownerSub){
    if(!idPattern.test(subscriptionId??''))return null;
    const row=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
        email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
        rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
        rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,config_version AS configVersion
      FROM subscriptions WHERE id=? AND owner_sub=?`).bind(subscriptionId,ownerSub).first();
    if(!row)return null;
    const {runtimes}=await (async()=>{
      const account=await auth.getRecipient(row.ownerSub);
      const policyState=account.ok?{status:'available',policy:account.data.policy}
        :{status:'auth_unavailable',policy:{access:false,subscriptionLimit:{kind:'missing'}}};
      const rows=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,name,requested_enabled AS requestedEnabled,priority,
          email_mode AS emailMode,activated_at AS activatedAt,created_at AS createdAt,deleted_at AS deletedAt,
          rss_token_generation AS rssTokenGeneration,rss_token_ciphertext AS rssTokenCiphertext,
          rss_revoked_at IS NOT NULL AS rssRevoked,deleted_at IS NOT NULL AS deleted,config_version AS configVersion
        FROM subscriptions WHERE owner_sub=?`).bind(row.ownerSub).all();
      return {runtimes:computeSubscriptionRuntime(rows.results,policyState,account.ok?account.data.recipient.status:'unverified')};
    })();
    const targets=await env.DB.prepare(`SELECT t.source_id AS sourceId,s.name AS sourceName,t.effective_from AS effectiveFrom
      FROM subscription_sources t JOIN sources s ON s.id=t.source_id
      WHERE t.subscription_id=? AND t.removed_at IS NULL ORDER BY t.source_id`).bind(subscriptionId).all();
    const runtime=runtimes.get(subscriptionId);
    const deletedSnapshot=row.deletedAt===null?null:
      await env.DB.prepare('SELECT deleted_source_ids_json FROM subscriptions WHERE id=?').bind(subscriptionId).first();
    return {
      id:row.id,name:row.name,requestedEnabled:row.requestedEnabled===1,priority:row.priority,version:row.configVersion,
      ownerSub:row.ownerSub,
      emailMode:row.emailMode,activatedAt:new Date(row.activatedAt).toISOString(),createdAt:iso(row.createdAt, 'delivery created'),
      deletedAt:row.deletedAt===null?null:new Date(row.deletedAt).toISOString(),
      targetSourceIds:targets.results.map(target=>target.sourceId),
      savedSourceIds:deletedSnapshot?JSON.parse(deletedSnapshot.deleted_source_ids_json):targets.results.map(target=>target.sourceId),
      targets:targets.results.map(target=>({sourceId:target.sourceId,sourceName:target.sourceName,
        effectiveFrom:new Date(target.effectiveFrom).toISOString()})),
      effectiveStatus:runtime.effectiveStatus,selected:runtime.selected,
      rssStatus:runtime.rssStatus,emailStatus:runtime.emailStatus,
      notificationMatches:await subscriptionMatches(subscriptionId,runtime),
      rssUrl:row.rssRevoked===1?null:await rssUrlForOwner(env,row),
    };
  }

  async function eventStatus(eventId){
    if(!idPattern.test(eventId??''))return null;
    const current=await eventWithSources(eventId);
    if(!current)return null;
    const event=current.event;
    const matches=await env.DB.prepare(`SELECT m.*,s.name AS subscription_name
      FROM notification_matches m JOIN subscriptions s ON s.id=m.subscription_id
      WHERE m.event_id=? ORDER BY CASE s.email_mode WHEN 'immediate' THEN 0 WHEN 'daily_digest' THEN 1 ELSE 2 END,s.created_at,s.id`)
      .bind(eventId).all();
    const delivery=await env.DB.prepare(`SELECT id,owner_sub AS ownerSub,event_id AS eventId,state,delivery_kind AS kind,
        available_at AS availableAt,suppression_reason AS suppressionReason,created_at AS createdAt,updated_at AS updatedAt
      FROM user_deliveries WHERE event_id=? ORDER BY owner_sub`).bind(eventId).all();
    const tasks=await env.DB.prepare(`SELECT id,state,checkpoint_json AS checkpoint,payload_json AS payload,created_at AS createdAt,updated_at AS updatedAt
      FROM tasks WHERE kind='match-event' AND article_id=? AND json_extract(payload_json,'$.eventId')=?
      ORDER BY created_at,id`).bind(event.articleId,eventId).all();
    const corrections=await env.DB.prepare(`SELECT event_id AS eventId,source_id AS sourceId,generation,
        evidence_object_hash AS evidenceObjectHash,verified_by AS verifiedBy,verified_at AS verifiedAt
      FROM event_source_corrections WHERE event_id=? ORDER BY source_id,generation`).bind(eventId).all();
    return {
      event:{...event,observedAt:iso(event.observedAt, 'event observed'),readyAt:iso(event.readyAt, 'event ready'),
        historyOnly:event.historyOnly===1},
      sources:current.sources.map(source=>({
        sourceId:source.source_id,firstSeenAt:iso(source.article_source_first_seen_at, 'source first seen'),
        discoveryClass:source.discovery_class,publishedAt:source.evidence.publishedAt??null,
        publishedDay:source.evidence.publishedDay??null,datePrecision:source.evidence.datePrecision,
        timezone:source.source_timezone,correctionGeneration:source.evidence.correctionGeneration??0,
      })),
      matches:matches.results.map(row=>({subscriptionId:row.subscription_id,subscriptionName:row.subscription_name,
        ownerSub:row.owner_sub,eligibilityKind:row.eligibility_kind,reason:row.reason,
        matchedAt:iso(row.matched_at, 'match')})),
      deliveries:delivery.results.map(presentDelivery),
      delivery:delivery.results[0]?presentDelivery(delivery.results[0]):null,
      corrections:corrections.results.map(row=>({...row,verifiedAt:iso(row.verifiedAt,'correction verified')})),
      matchTasks:tasks.results.map(task=>{
        const progress=checkpoint({...task,checkpoint_json:task.checkpoint_json??task.checkpoint});
        return {id:task.id,state:task.state,...progress,pages:progress.page,
          createdAt:iso(task.createdAt??task.created_at,'task created'),
          updatedAt:iso(task.updatedAt??task.updated_at,'task updated')};
      }),
    };
  }

  function presentDelivery(row){
    return {id:row.id,ownerSub:row.ownerSub,eventId:row.eventId,state:row.state,kind:row.kind,
      availableAt:iso(row.availableAt, 'delivery available'),suppressionReason:row.suppressionReason??null,
      createdAt:iso(row.createdAt, 'delivery created'),updatedAt:iso(row.updatedAt, 'delivery updated')};
  }

  return {
    enqueueEvent,reconcileSourceAssociation,processMatchTask,verifyDate,readDateEvidence,eventStatus,readSubscription,
  };
}

export async function articleSourceAssociationStatements(env,{articleId,sourceId,timestamp,discoveryTaskId,afterEventId='',taskGuard={sql:'1',args:[]}}){
  if(!idPattern.test(articleId??'')||!idPattern.test(discoveryTaskId??'')
    ||!/^[A-Za-z0-9_-]{1,64}$/.test(sourceId??'')||!Number.isSafeInteger(timestamp)
    ||afterEventId!==''&&!idPattern.test(afterEventId))throw validationError('Invalid source association handoff',400);
  const dedupeKey=`association:${articleId}:${sourceId}:${discoveryTaskId}:${afterEventId}`;
  const outboxId=(await sha(`outbox:${dedupeKey}`)).slice(0,24);
  const message={v:1,type:'source-associated',outboxId,articleId,sourceId,discoveryTaskId,afterEventId};
  return {statements:[env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
    SELECT ?,'feed-events',?,?,?,?,? WHERE ${taskGuard.sql}
      AND EXISTS(SELECT 1 FROM article_sources WHERE article_id=? AND source_id=?)
    ON CONFLICT(topic,dedupe_key) DO NOTHING`)
    .bind(outboxId,dedupeKey,JSON.stringify(message),timestamp,timestamp,timestamp,...taskGuard.args,articleId,sourceId)]};
}

function parseCorrectedDates(value){
  try{return JSON.parse(value);}catch{return {};}
}

function iso(value,label){
  const time=new Date(value).getTime();
  if(!Number.isFinite(time))throw validationError(`Invalid ${label} timestamp`,500);
  return new Date(time).toISOString();
}

function checkpoint(task){
  try{
    const value=JSON.parse(task.checkpoint_json??'{}');
    return {lastTargetId:typeof value.lastTargetId==='string'?value.lastTargetId:'',page:Number.isSafeInteger(value.page)?value.page:0,
      hasNext:value.hasNext===true};
  }catch{return {lastTargetId:'',page:0,hasNext:false};}
}

function localDay(value,timezone){
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
  catch{return new Date(value).toISOString().slice(0,10);}
}

function parseMatchMessage(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.v!==1||payload.type!=='match-source'
    ||!idPattern.test(payload.taskId??'')||!idPattern.test(payload.eventId??''))
    throw validationError('Invalid match message',400);
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(payload.sourceId??''))throw validationError('Invalid match source',400);
  if(!Number.isSafeInteger(payload.generation)||payload.generation<0||!Number.isSafeInteger(payload.page)||payload.page<0)
    throw validationError('Invalid match generation',400);
  return {...payload};
}

function boundedInteger(value,defaultValue,min,max){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:defaultValue;
}

function validationError(message,status=400){
  const error=new Error(message);
  error.name='NotificationError';
  error.status=status;
  return error;
}
