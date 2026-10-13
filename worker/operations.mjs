import {cleanError} from './utils.mjs';
import {requireCrawlRuntime} from './task-runtime.mjs';
import {admitDiscovery} from './backfill-control.mjs';

const idPattern=/^[a-f0-9]{24}$/;
const topics=['feed-jobs','feed-events','feed-mail'];
const workflowKinds=new Set(['discover','capture','ocr']);
const scopedPayloadTypes=new Set(['start-job','check-ready','event-ready','match-source','source-associated','send-mail']);

export function createOperations(env,{now=()=>Date.now()}={}){
  const timestamp=()=> {
    const value=now();
    return value instanceof Date?value.getTime():value;
  };
  const limit=boundedInteger(env.OPERATIONS_DIAGNOSTIC_LIMIT,20,1,100);
  const queueDeadLetterAfterMs=boundedDuration(env.QUEUE_DEAD_LETTER_AFTER_MS,15*60*1000,60*1000,7*24*60*60*1000);
  const cache=new Map();

  return {
    async diagnostics({requestedLimit=limit}={}){
      const pageSize=boundedInteger(requestedLimit,limit,1,100),at=timestamp();
      const [queues,tasks,requirements,messages,metrics]=await Promise.all([
        deadLetters(pageSize,at),
        taskDiagnostics(pageSize,at),
        requirementDiagnostics(pageSize),
        messageDiagnostics(pageSize),
        metricsSnapshot(at),
      ]);
      return {
        generatedAt:new Date(at).toISOString(),limit:pageSize,queues,tasks,requirements,messages,metrics,
        configuration:configuration(),
      };
    },

    async replay(input){
      validateReplay(input);
      const at=timestamp(),row=await env.DB.prepare(`SELECT o.id,o.topic,o.payload_json,o.state,o.updated_at,
          r.state AS receipt_state,r.last_replayed_at
        FROM outbox o LEFT JOIN outbox_receipts r ON r.outbox_id=o.id WHERE o.id=?`)
        .bind(input.outboxId).first();
      if(!row)throw operationsError('Outbox message not found',404);
      if(row.topic!==input.topic)throw operationsError('Outbox topic does not match the selected queue',409);
      if(row.state!=='sent')throw operationsError('Outbox message is not in its sent state',409);
      if(row.receipt_state==='processed')throw operationsError('Outbox message was already processed',409);
      if(at-Math.max(row.updated_at,row.last_replayed_at??0)<queueDeadLetterAfterMs)
        throw operationsError('Outbox message has not exceeded the Queue retry window',409);
      const target=row.topic==='feed-jobs'?env.FEED_JOBS:row.topic==='feed-events'?env.FEED_EVENTS:env.FEED_MAIL;
      if(!target)throw operationsError(`Queue binding unavailable for ${row.topic}`,503);
      let payload;
      try{payload=JSON.parse(row.payload_json);}catch{throw operationsError('Outbox payload is invalid',500);}
      const links=await linksFor(payload);
      if(!inScope(payload,links))throw operationsError('Outbox message belongs to a separately owned business flow',409);
      if(payload.type==='start-job')requireCrawlRuntime(env);
      if(payload.type==='start-job'&&env.SOURCE_MANAGEMENT_ENABLED==='true'
        &&!await admitDiscovery(env,payload.taskId,payload.attempt,at))
        throw operationsError('Discovery admission budget is exhausted',409);
      // Claim before sending: a fast consumer may already have processed this message when send resolves.
      const claimed=await env.DB.prepare(`INSERT INTO outbox_receipts(outbox_id,topic,state,attempts,replay_count,last_error,last_replayed_at,created_at,updated_at)
        SELECT id,topic,'queued',0,1,NULL,?,?,? FROM outbox WHERE id=? AND state='sent' AND updated_at<=?
        ON CONFLICT(outbox_id) DO UPDATE SET state='queued',replay_count=replay_count+1,last_error=NULL,
          last_replayed_at=excluded.last_replayed_at,updated_at=excluded.updated_at
        WHERE outbox_receipts.state<>'processed'
          AND (outbox_receipts.last_replayed_at IS NULL OR outbox_receipts.last_replayed_at<=?)`)
        .bind(at,at,at,row.id,at-queueDeadLetterAfterMs,at-queueDeadLetterAfterMs).run();
      if(!claimed.meta.changes)throw operationsError('Outbox replay is already claimed or processed',409);
      try{await target.send(payload,{contentType:'json'});}
      catch(error){
        // An ambiguous Queue response retains its wait window and cannot overwrite a processed receipt.
        await env.DB.prepare(`UPDATE outbox_receipts SET state='failed',last_error=?,updated_at=?
          WHERE outbox_id=? AND state<>'processed' AND last_replayed_at=?`)
          .bind(cleanError(error),timestamp(),row.id,at).run();
        throw error;
      }
      return {outboxId:row.id,topic:row.topic,replayed:true,replayCount:await receiptReplayCount(row.id)};
    },
  };

  async function deadLetters(pageSize,at){
    const result=[];
    for(const topic of topics){
      const rows=await env.DB.prepare(`SELECT o.id AS outboxId,o.topic,o.payload_json,o.attempts,o.updated_at,
          r.state AS receiptState,r.attempts AS receiptAttempts,r.replay_count AS replayCount,r.last_error AS receiptError
        FROM outbox o LEFT JOIN outbox_receipts r ON r.outbox_id=o.id
        WHERE o.topic=? AND o.state='sent' AND o.updated_at<=?
          AND (r.outbox_id IS NULL OR r.state<>'processed')
          AND (r.last_replayed_at IS NULL OR r.last_replayed_at<=?)
        ORDER BY o.updated_at,o.id LIMIT ?`).bind(topic,at-queueDeadLetterAfterMs,at-queueDeadLetterAfterMs,pageSize).all();
      const items=[];
      for(const row of rows.results){
        const payload=parseIdentity(row.payloadJson??row.payload_json);
        const links=await linksFor(payload,pageSize);
        if(!inScope(payload,links))continue;
        items.push({
          outboxId:row.outboxId,topic,messageType:payload?.type??'unknown',kind:'queue_handoff',
          ...links,attempts:row.attempts,replayCount:row.replayCount??0,
          ageMs:at-row.updated_at,lastError:redact(row.receiptError),
        });
      }
      result.push({topic,deadLetters:items});
    }
    return result;
  }

  async function taskDiagnostics(pageSize,at){
    const rows=await env.DB.prepare(`SELECT t.id,t.kind,t.state,t.source_id AS sourceId,t.article_id AS articleId,
        t.attempt_no AS attemptNo,t.due_at AS dueAt,t.last_error AS lastError,t.created_at AS createdAt,t.updated_at AS updatedAt,
        a.workflow_instance_id AS workflowInstanceId,a.handed_off_at AS handedOffAt,a.error_code AS errorCode,
        r.id AS revisionId,e.id AS eventId
      FROM tasks t
      LEFT JOIN task_attempts a ON a.task_id=t.id AND a.attempt_no=t.attempt_no
      LEFT JOIN article_revisions r ON r.capture_task_id=t.id
      LEFT JOIN content_events e ON e.revision_id=r.id
      WHERE t.kind IN ('discover','capture','ocr','match-event')
        AND (t.state IN ('failed','blocked','deferred')
          OR (t.state IN ('queued','starting','running') AND t.updated_at<=?))
      ORDER BY CASE t.state WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END,
        t.updated_at,t.id LIMIT ?`).bind(at-queueDeadLetterAfterMs,pageSize).all();
    return Promise.all(rows.results.map(async row=>({
      id:row.id,kind:taskKind(row),taskKind:row.taskKind??row.kind,state:row.state,
      taskId:row.id,
      sourceId:row.sourceId,articleId:row.articleId,revisionId:row.revisionId,eventId:row.eventId,
      ...(row.kind==='ocr'?await ocrLinks(row.id,pageSize):{}),
      attemptNo:row.attemptNo,dueAt:isoOrNull(row.dueAt),createdAt:isoOrNull(row.createdAt),
      updatedAt:isoOrNull(row.updatedAt),workflowInstanceId:row.workflowInstanceId,
      handedOffAt:isoOrNull(row.handedOffAt),errorCode:redact(row.errorCode),lastError:redact(row.lastError),
    })));
  }

  async function requirementDiagnostics(pageSize){
    const rows=await env.DB.prepare(`SELECT q.revision_id AS revisionId,q.slot_key AS slotKey,q.kind AS requirementKind,
        q.state,q.error_code AS errorCode,r.article_id AS articleId,r.capture_task_id AS captureTaskId,
        CASE WHEN q.kind='body_ocr' THEN ocr.id ELSE r.capture_task_id END AS taskId,
        a.source_id AS sourceId,e.id AS eventId
      FROM revision_requirements q
      JOIN article_revisions r ON r.id=q.revision_id
      JOIN articles a ON a.id=r.article_id
      JOIN tasks owner ON owner.id=r.capture_task_id AND owner.kind IN ('discover','capture','ocr')
      LEFT JOIN tasks ocr ON ocr.kind='ocr'
        AND ocr.business_key=json_array('ocr',q.input_hash,q.processor,q.processor_version,q.options_hash)
      LEFT JOIN content_events e ON e.revision_id=r.id
      WHERE q.required=1 AND q.state<>'fulfilled'
      ORDER BY CASE q.state WHEN 'failed' THEN 0 ELSE 1 END,r.observed_at,q.revision_id,q.slot_key LIMIT ?`)
      .bind(pageSize).all();
    return rows.results.map(row=>({
      kind:'missing_requirement',revisionId:row.revisionId,slotKey:row.slotKey,requirementKind:row.requirementKind,
      state:row.state,errorCode:redact(row.errorCode),articleId:row.articleId,
      sourceId:row.sourceId,taskId:row.taskId,captureTaskId:row.captureTaskId,eventId:row.eventId,
    }));
  }

  async function messageDiagnostics(pageSize){
    const rows=await env.DB.prepare(`SELECT m.id AS messageId,m.state,m.last_error AS lastError,
        m.attempts,m.submitted_at AS submittedAt,m.updated_at AS updatedAt,
        i.delivery_id AS deliveryId,i.event_id AS eventId,r.id AS revisionId,r.article_id AS articleId,
        a.source_id AS sourceId
      FROM mail_messages m
      LEFT JOIN mail_items i ON i.message_id=m.id
      LEFT JOIN content_events e ON e.id=i.event_id
      LEFT JOIN article_revisions r ON r.id=e.revision_id
      LEFT JOIN articles a ON a.id=r.article_id
      WHERE m.kind='immediate' AND (m.state='submission_unknown' OR m.last_error='auth_unavailable')
      ORDER BY CASE WHEN m.state='submission_unknown' THEN 0 ELSE 1 END,m.updated_at,m.id LIMIT ?`)
      .bind(pageSize).all();
    return rows.results.map(row=>({
      kind:row.state==='submission_unknown'?'mail_unknown':'auth_unavailable',
      messageId:row.messageId,deliveryId:row.deliveryId,eventId:row.eventId,revisionId:row.revisionId,
      articleId:row.articleId,sourceId:row.sourceId,state:row.state,attempts:row.attempts,
      submittedAt:isoOrNull(row.submittedAt),updatedAt:isoOrNull(row.updatedAt),lastError:redact(row.lastError),
    }));
  }

  async function metricsSnapshot(at){
    const ocrDay=new Date(at).toISOString().slice(0,10),ocrMonth=ocrDay.slice(0,7);
    const [oldest,readyLatency,counts,paid,artifacts]=await Promise.all([
      env.DB.prepare(`SELECT * FROM (
          SELECT id,'queued_outbox' AS scope,available_at AS oldest_at FROM outbox
          WHERE state='queued' AND json_extract(payload_json,'$.type') IN
            ('start-job','check-ready','event-ready','match-source','source-associated','send-mail')
          UNION ALL SELECT id,'active_task' AS scope,created_at AS oldest_at
            FROM tasks WHERE state IN ('queued','starting','running','deferred')
              AND kind IN ('discover','capture','ocr','match-event')
          UNION ALL SELECT id,'pending_delivery' AS scope,COALESCE(backlog_at,available_at,created_at) AS oldest_at
            FROM user_deliveries WHERE state='pending' AND delivery_kind='immediate'
        ) ORDER BY oldest_at,id LIMIT 1`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS count,MIN(latency_ms) AS minMs,MAX(latency_ms) AS maxMs FROM (
          SELECT e.ready_at-MIN(es.article_source_first_seen_at) AS latency_ms
          FROM content_events e JOIN event_sources es ON es.event_id=e.id
          WHERE e.history_only=0 AND es.discovery_class='live'
          GROUP BY e.id
        )`).first(),
      env.DB.prepare(`SELECT
          (SELECT COUNT(*) FROM revision_requirements q
            JOIN article_revisions r ON r.id=q.revision_id
            JOIN tasks owner ON owner.id=r.capture_task_id AND owner.kind IN ('discover','capture','ocr')
            WHERE q.required=1 AND q.state<>'fulfilled') AS missingRequirements,
          (SELECT COUNT(*) FROM mail_messages WHERE kind='immediate' AND state='submission_unknown') AS mailUnknown,
          (SELECT COUNT(*) FROM mail_messages WHERE kind='immediate' AND last_error='auth_unavailable') AS mailAuthUnavailable,
          (SELECT COUNT(*) FROM tasks WHERE last_error LIKE '%auth_unavailable%') AS taskAuthUnavailable`).first(),
      env.DB.prepare(`SELECT
          (SELECT COALESCE(SUM(used),0) FROM usage WHERE kind IN ('firecrawl','ocr')) AS paidVendorCalls,
          (SELECT COALESCE(SUM(processed_pages),0) FROM pdf_ocr_usage WHERE length(period)=7) AS paidOcrPages,
          (SELECT COALESCE(CASE WHEN day=? THEN day_pages ELSE 0 END,0)
            FROM pdf_ocr_budget WHERE id=1) AS ocrPagesToday,
          (SELECT COALESCE(CASE WHEN month=? THEN month_pages ELSE 0 END,0)
            FROM pdf_ocr_budget WHERE id=1) AS ocrPagesThisMonth`)
        .bind(ocrDay,ocrMonth).first(),
      env.DB.prepare(`SELECT COUNT(*) AS referenced FROM (
          SELECT object_hash AS artifact_hash FROM revision_requirements WHERE object_hash IS NOT NULL
          UNION SELECT result_hash FROM derived_outputs WHERE result_hash IS NOT NULL
        )`).first(),
    ]);
    return {
      oldestBacklog:oldest?{id:oldest.id,scope:oldest.scope,ageMs:at-oldest.oldest_at}:null,
      readyLatency:{count:number(readyLatency.count),minMs:numberOrNull(readyLatency.minMs),maxMs:numberOrNull(readyLatency.maxMs)},
      missingRequirements:number(counts.missingRequirements),mailUnknown:number(counts.mailUnknown),
      authUnavailable:number(counts.mailAuthUnavailable)+number(counts.taskAuthUnavailable),
      paidVendorCalls:number(paid.paidVendorCalls),paidOcrPages:number(paid.paidOcrPages),
      ocrPagesToday:number(paid.ocrPagesToday),ocrPagesThisMonth:number(paid.ocrPagesThisMonth),
      referencedImmutableArtifacts:number(artifacts.referenced),
    };
  }

  async function linksFor(payload,referenceLimit=limit){
    const links={};
    if(idPattern.test(payload?.taskId??''))Object.assign(links,await cached('task',payload.taskId,id=>taskLink(id,referenceLimit)));
    if(idPattern.test(payload?.discoveryTaskId??''))Object.assign(links,await cached('task',payload.discoveryTaskId,id=>taskLink(id,referenceLimit)));
    if(idPattern.test(payload?.eventId??''))Object.assign(links,await cached('event',payload.eventId,eventLink));
    if(idPattern.test(payload?.revisionId??''))Object.assign(links,await cached('revision',payload.revisionId,revisionLink));
    if(idPattern.test(payload?.articleId??''))Object.assign(links,await cached('article',payload.articleId,articleLink));
    if(idPattern.test(payload?.messageId??''))Object.assign(links,await cached('mail',payload.messageId,mailLink));
    return links;
  }

  async function cached(namespace,id,load){
    const key=`${namespace}:${id}`;
    if(!cache.has(key)){
      const value=await load(id);
      if(value)cache.set(key,value);else cache.set(key,{});
    }
    return cache.get(key);
  }

  async function taskLink(id,referenceLimit){
    const row=await env.DB.prepare(`SELECT t.id AS taskId,t.kind AS taskKind,COALESCE(t.source_id,a.source_id) AS sourceId,t.article_id AS articleId,
        r.id AS revisionId,e.id AS eventId
      FROM tasks t LEFT JOIN articles a ON a.id=t.article_id
      LEFT JOIN article_revisions r ON r.capture_task_id=t.id
      LEFT JOIN content_events e ON e.revision_id=r.id WHERE t.id=?`).bind(id).first();
    return row?.taskKind==='ocr'?{...row,...await ocrLinks(id,referenceLimit)}:row;
  }

  async function ocrLinks(id,referenceLimit){
    const rows=await env.DB.prepare(`SELECT q.revision_id AS revisionId,q.slot_key AS slotKey,
        q.state,r.article_id AS articleId,r.capture_task_id AS captureTaskId,a.source_id AS sourceId,e.id AS eventId
      FROM tasks t JOIN revision_requirements q ON q.kind='body_ocr'
        AND q.input_hash=json_extract(t.payload_json,'$.inputHash')
        AND q.processor=json_extract(t.payload_json,'$.processor')
        AND q.processor_version=json_extract(t.payload_json,'$.processorVersion')
        AND q.options_hash=json_extract(t.payload_json,'$.optionsHash')
      JOIN article_revisions r ON r.id=q.revision_id JOIN articles a ON a.id=r.article_id
      LEFT JOIN content_events e ON e.revision_id=r.id
      WHERE t.id=? AND t.kind='ocr' ORDER BY q.revision_id,q.slot_key LIMIT ?`)
      .bind(id,referenceLimit+1).all();
    const references=rows.results.slice(0,referenceLimit),first=references[0];
    return {
      ...(first?{sourceId:first.sourceId,articleId:first.articleId,revisionId:first.revisionId,eventId:first.eventId}:{}),
      references,referencesTruncated:rows.results.length>referenceLimit,
    };
  }

  async function eventLink(id){
    return env.DB.prepare(`SELECT e.id AS eventId,e.revision_id AS revisionId,e.article_id AS articleId,
        a.source_id AS sourceId,e.history_only AS historyOnly
      FROM content_events e JOIN articles a ON a.id=e.article_id WHERE e.id=?`)
      .bind(id).first();
  }

  async function revisionLink(id){
    return env.DB.prepare(`SELECT r.id AS revisionId,r.article_id AS articleId,a.source_id AS sourceId,
        r.capture_task_id AS taskId FROM article_revisions r JOIN articles a ON a.id=r.article_id WHERE r.id=?`)
      .bind(id).first();
  }

  async function articleLink(id){
    return env.DB.prepare(`SELECT a.id AS articleId,a.source_id AS sourceId FROM articles a WHERE a.id=?`)
      .bind(id).first();
  }

  async function mailLink(id){
    return env.DB.prepare(`SELECT m.id AS messageId,m.kind AS mailKind,i.delivery_id AS deliveryId,i.event_id AS eventId,
        e.revision_id AS revisionId,e.article_id AS articleId,a.source_id AS sourceId
      FROM mail_messages m LEFT JOIN mail_items i ON i.message_id=m.id
      LEFT JOIN content_events e ON e.id=i.event_id LEFT JOIN articles a ON a.id=e.article_id
      WHERE m.id=? ORDER BY i.ordinal LIMIT 1`).bind(id).first();
  }

  async function receiptReplayCount(id){
    return (await env.DB.prepare('SELECT replay_count AS replayCount FROM outbox_receipts WHERE outbox_id=?')
      .bind(id).first())?.replayCount??0;
  }

  function configuration(){
    return {
      maxTaskAttempts:boundedInteger(env.MAX_TASK_ATTEMPTS,3,1,10),
      maxLaunchAttempts:boundedInteger(env.TASK_MAX_LAUNCH_ATTEMPTS,5,1,20),
      queueDeadLetterAfterMs,
      taskRetryBaseDelayMs:boundedDuration(env.TASK_RETRY_BASE_DELAY_MS,15*60*1000,60*1000,24*60*60*1000),
      taskRetryMaxDelayMs:boundedDuration(env.TASK_RETRY_MAX_DELAY_MS,6*60*60*1000,60*1000,7*24*60*60*1000),
      maxMailAttempts:boundedInteger(env.MAX_MAIL_ATTEMPTS,20,1,100),
      maxFirecrawlPerDay:boundedInteger(env.MAX_FIRECRAWL_PER_DAY,120,0,100000),
      maxPdfOcrPagesPerDay:boundedInteger(env.MAX_PDF_OCR_PAGES_PER_DAY,50,0,100000),
      maxPdfOcrPagesPerMonth:boundedInteger(env.MAX_PDF_OCR_PAGES_PER_MONTH,1000,0,1000000),
    };
  }

  function inScope(payload,links){
    const taskKind=links.taskId?links.taskKind:null;
    if(taskKind&&!['discover','capture','ocr','match-event'].includes(taskKind))return false;
    if(links.messageId&&links.mailKind!=='immediate')return false;
    if(links.eventId&&links.historyOnly===1)return false;
    return scopedPayloadTypes.has(payload?.type);
  }
}

export class OperationsError extends Error{
  constructor(message,status=400){super(message);this.name='OperationsError';this.status=status;}
}

function taskKind(row){
  if(row.state==='failed'&&row.handedOffAt!==null)return 'workflow_failure';
  if(row.state==='deferred'&&row.handedOffAt!==null)return 'workflow_deferred';
  if(row.state==='blocked'&&row.handedOffAt!==null)return 'workflow_blocked';
  if(['queued','starting','running'].includes(row.state)&&workflowKinds.has(row.kind))
    return row.handedOffAt!==null?'workflow_stale':'queue_handoff';
  if(row.kind==='match-event')return 'matching_pending';
  return row.state;
}

function validateReplay(input){
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['outboxId','topic'].includes(key))
    ||!idPattern.test(input.outboxId??'')||!topics.includes(input.topic))
    throw operationsError('outboxId and a known topic are required');
}

function operationsError(message,status=400){
  return new OperationsError(message,status);
}

function parseIdentity(value){
  try{
    const payload=JSON.parse(value);
    return payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:null;
  }catch{return null;}
}

function redact(value){
  if(value===null||value===undefined)return null;
  return cleanError(value);
}

function isoOrNull(value){
  return Number.isFinite(value)?new Date(value).toISOString():null;
}

function number(value){
  return Number.isFinite(value)?value:0;
}

function numberOrNull(value){
  return Number.isFinite(value)?value:null;
}

function boundedInteger(value,fallback,min,max){
  const n=Number(value);
  return Number.isSafeInteger(n)?Math.min(max,Math.max(min,n)):fallback;
}

function boundedDuration(value,fallback,min,max){
  const n=Number(value);
  return Number.isSafeInteger(n)?Math.min(max,Math.max(min,n)):fallback;
}
