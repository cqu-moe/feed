import {sha} from './utils.mjs';
import {readingExcerpt} from './reading.mjs';
import {storeTextObject,verifyObject} from './archive-objects.mjs';
import {aggregateOcrProjection,applyOcrEntries} from './archive-ocr-view.mjs';

export async function reconcileRevision(env,revisionId){
  if(!/^[a-f0-9]{24}$/.test(revisionId??''))throw new Error('Invalid revision id');
  const revision=await env.DB.prepare(`SELECT r.*,a.source_id AS primary_source_id
    FROM article_revisions r JOIN articles a ON a.id=r.article_id WHERE r.id=?`).bind(revisionId).first();
  if(!revision)return {notFound:true};
  if(revision.state==='ready')return {state:'ready',eventCreated:false};

  const requirements=await env.DB.prepare(`SELECT q.slot_key,q.kind,q.required,q.state,q.object_hash,q.filename,
      q.input_hash,o.r2_key,o.byte_size,o.media_type
    FROM revision_requirements q LEFT JOIN artifact_objects o ON o.sha256=q.object_hash
    WHERE q.revision_id=? ORDER BY q.slot_key`).bind(revisionId).all();
  const missing=requirements.results.filter(row=>row.required&&row.state!=='fulfilled');
  if(missing.some(row=>row.state==='failed')){
    await env.DB.prepare(`UPDATE article_revisions SET state='blocked'
      WHERE id=? AND state='assembling' AND NOT EXISTS(
        SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id AND q.required=1 AND q.state='fulfilled')`)
      .bind(revisionId).run();
    return {state:'blocked',missing:missing.length};
  }
  if(missing.length)return {state:'assembling',missing:missing.length};

  for(const requirement of requirements.results.filter(row=>row.required)){
    if(!requirement.object_hash||!requirement.r2_key)throw new Error('Complete revision is missing an immutable object');
    await verifyObject(env,{sha256:requirement.object_hash,r2Key:requirement.r2_key,
      byteSize:requirement.byte_size,mediaType:requirement.media_type});
  }

  const body=requirements.results.find(row=>row.kind==='body');
  if(!body?.r2_key)throw new Error('Complete revision is missing its body object');
  await verifyObject(env,{sha256:body.object_hash,r2Key:body.r2_key,byteSize:body.byte_size,mediaType:body.media_type});
  const reading=await assembleBodyText(env,requirements.results);
  const sources=await revisionSources(env,revision);
  const timestamp=Date.now();
  const eventId=(await sha(`event:${revisionId}`)).slice(0,24);
  const outboxId=(await sha(`outbox:event:${eventId}`)).slice(0,24);
  const payloadHash=await sha(JSON.stringify({
    revisionId,
    rawFingerprint:revision.raw_fingerprint,
    semanticFingerprint:revision.semantic_fingerprint,
    sources:sources.map(source=>[source.source_id,source.published_at,source.date_precision]),
  }));
  const priorObservation=await env.DB.prepare(`SELECT 1 FROM article_revisions
    WHERE article_id=? AND revision_no<? LIMIT 1`).bind(revision.article_id,revision.revision_no).first();
  const hasEvent=revision.change_kind!=='presentation_only';
  const captureIntent=parseCaptureIntent(revision.source_metadata_json);
  const historyOnly=captureIntent==='live'?false:captureIntent?true:!sources.some(source=>source.discovery_class==='live');
  const dateUnknown=sources.length>0&&sources.every(source=>source.date_precision==='unknown');

  const statements=[];
  if(reading.ocrProjection){
    statements.push(env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`)
      .bind(reading.ocrProjection.sha256,reading.ocrProjection.r2Key,reading.ocrProjection.byteSize,
        reading.ocrProjection.mediaType,reading.ocrProjection.verifiedAt));
  }
  statements.push(env.DB.prepare(`UPDATE article_revisions SET state='ready',ready_at=?
    WHERE id=? AND state='assembling' AND requirement_count=(
      SELECT COUNT(*) FROM revision_requirements q WHERE q.revision_id=article_revisions.id)
    AND requirement_generation=? AND NOT EXISTS(SELECT 1 FROM revision_requirements q WHERE q.revision_id=article_revisions.id
      AND q.required=1 AND q.state<>'fulfilled') RETURNING id`)
    .bind(timestamp,revisionId,revision.requirement_generation));
  if(hasEvent){
    statements.push(env.DB.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,
        history_only,date_state,payload_hash,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND article_id=? AND state='ready' AND requirement_generation=?)
      ON CONFLICT(revision_id) DO NOTHING`)
      .bind(eventId,revisionId,revision.article_id,priorObservation?'update':'initial',revision.observed_at,timestamp,
        historyOnly?1:0,dateUnknown?'date_unknown':'verified',payloadHash,timestamp,revisionId,revision.article_id,
        revision.requirement_generation));
    for(const source of sources){
      statements.push(env.DB.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,
          discovery_class,published_at,published_day,date_precision,source_timezone)
        SELECT ?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM content_events e JOIN article_revisions current ON current.id=e.revision_id
          WHERE e.id=? AND e.revision_id=? AND e.article_id=? AND current.requirement_generation=?)
        ON CONFLICT(event_id,source_id) DO NOTHING`)
        .bind(eventId,source.source_id,source.first_seen_at,source.discovery_class,source.published_at,
          source.published_day,source.date_precision,source.source_timezone,eventId,revisionId,revision.article_id,
          revision.requirement_generation));
    }
    statements.push(env.DB.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,created_at,updated_at)
      SELECT ?,'feed-events',?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM content_events e JOIN article_revisions current ON current.id=e.revision_id
          WHERE e.id=? AND e.revision_id=? AND e.article_id=? AND current.requirement_generation=?)
      ON CONFLICT(topic,dedupe_key) DO NOTHING`)
      .bind(outboxId,`event:${eventId}`,JSON.stringify({v:1,type:'event-ready',outboxId,eventId,revisionId}),
        timestamp,timestamp,timestamp,eventId,revisionId,revision.article_id,revision.requirement_generation));
  }
    statements.push(env.DB.prepare(`INSERT INTO article_read_models(article_id,revision_id,title,summary,readable_text,
      ocr_result_hash,ocr_model,ocr_updated_at)
    SELECT article_id,id,title,?,?,?,?,?
    FROM article_revisions r
    WHERE id=? AND article_id=? AND state='ready' AND requirement_generation=? AND NOT EXISTS(
      SELECT 1 FROM article_read_models m JOIN article_revisions current ON current.id=m.revision_id
      WHERE m.article_id=r.article_id AND current.revision_no>=r.revision_no)
    ON CONFLICT(article_id) DO UPDATE SET revision_id=excluded.revision_id,title=excluded.title,
      summary=excluded.summary,readable_text=excluded.readable_text,ocr_result_hash=excluded.ocr_result_hash,
      ocr_model=excluded.ocr_model,ocr_updated_at=excluded.ocr_updated_at
    WHERE (SELECT revision_no FROM article_revisions WHERE id=excluded.revision_id)>
      (SELECT revision_no FROM article_revisions WHERE id=article_read_models.revision_id)`)
    .bind(readingExcerpt(reading.text),reading.text,reading.ocr?.resultHash??null,reading.ocr?.model??null,
      reading.ocr?.updatedAt??null,revisionId,revision.article_id,revision.requirement_generation));
  statements.push(env.DB.prepare(`UPDATE articles SET latest_ready_revision_id=?
    WHERE id=? AND EXISTS(SELECT 1 FROM article_revisions ready WHERE ready.id=? AND ready.article_id=articles.id
      AND ready.state='ready' AND ready.requirement_generation=? AND ready.revision_no>COALESCE((
        SELECT current.revision_no FROM article_revisions current
        WHERE current.id=articles.latest_ready_revision_id),0))
    RETURNING id`).bind(revisionId,revision.article_id,revisionId,revision.requirement_generation));
  const committed=await env.DB.batch(statements);
  if(!committed[0].results?.length){
    const current=await env.DB.prepare('SELECT state FROM article_revisions WHERE id=?').bind(revisionId).first();
    if(current?.state==='ready'){
      const event=await env.DB.prepare('SELECT id FROM content_events WHERE revision_id=?').bind(revisionId).first();
      return {state:'ready',eventCreated:Boolean(event)};
    }
    throw new Error('Revision requirements changed before readiness commit');
  }
  const event=await env.DB.prepare('SELECT id FROM content_events WHERE revision_id=?').bind(revisionId).first();
  return {state:'ready',eventCreated:Boolean(event)};
}

async function assembleBodyText(env,requirements){
  const body=requirements.find(row=>row.kind==='body');
  if(!body?.r2_key)throw new Error('Complete revision is missing its body object');
  let text=await(await env.ARCHIVE.get(body.r2_key)).text();
  const entries=[];
  for(const requirement of requirements.filter(row=>row.kind==='body_ocr')){
    if(!requirement.r2_key)throw new Error('Adopted OCR result is missing');
    const object=await env.ARCHIVE.get(requirement.r2_key);
    if(!object)throw new Error('Adopted OCR result is unavailable');
    const output=await object.json();
    if(output?.inputHash!==requirement.input_hash||!Array.isArray(output.pages))throw new Error('Adopted OCR identity is invalid');
    entries.push({slotKey:requirement.slot_key,inputHash:requirement.input_hash,resultHash:requirement.object_hash,
      filename:requirement.filename,model:output.model??null,updatedAt:output.createdAt??null,pages:output.pages});
  }
  if(!entries.length)return {text,ocr:null};
  const projection=aggregateOcrProjection(entries),object=await storeTextObject(env,JSON.stringify(projection),'application/json');
  return {text:applyOcrEntries(text,entries),ocr:{resultHash:object.sha256,model:projection.model,updatedAt:projection.updatedAt},
    ocrProjection:object};
}

function parseCaptureIntent(value){
  try{
    const intent=JSON.parse(value).captureIntent;
    return ['live','backfill','migrated'].includes(intent)?intent:null;
  }catch{return null;}
}

async function revisionSources(env,revision){
  const table=await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='article_sources'").first();
  if(table){
    const rows=await env.DB.prepare(`SELECT source_id,first_seen_at,last_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone
      FROM article_sources WHERE article_id=? ORDER BY source_id`).bind(revision.article_id).all();
    if(rows.results.length)return rows.results;
  }
  const source=await env.DB.prepare(`SELECT s.id,s.url,a.discovered_at,a.published_at
    FROM sources s JOIN articles a ON a.source_id=s.id WHERE a.id=?`).bind(revision.article_id).first();
  if(!source)throw new Error('Revision has no source evidence');
  return [{
    source_id:source.id,
    first_seen_at:Date.parse(source.discovered_at),
    discovery_class:'live',
    published_at:source.published_at,
    published_day:source.published_at,
    date_precision:source.published_at?'day':'unknown',
    source_timezone:'Asia/Shanghai',
  }];
}
