import {sha} from './utils.mjs';
import {readingExcerpt} from './reading.mjs';

export async function commitCaptureRevision(env,capture,context){
  const {taskId,attemptNo,fence}=context,timestamp=Date.now();
  if(!Number.isSafeInteger(capture.revisionNo)||capture.revisionNo<1
    ||new Set(capture.requirements.map(row=>row.slotKey)).size!==capture.requirements.length)throw new Error('Invalid capture inventory');
  const guard=`EXISTS(SELECT 1 FROM articles a JOIN tasks t ON t.article_id=a.id
    JOIN task_attempts attempt ON attempt.task_id=t.id AND attempt.attempt_no=t.attempt_no AND attempt.state='running'
    WHERE a.id=? AND a.capture_fence=? AND a.lease_until>? AND t.id=? AND t.attempt_no=? AND t.state='running')`;
  const args=[capture.articleId,fence,timestamp,taskId,attemptNo];
  const priorResult=await env.DB.prepare(`SELECT o.outcome,r.id,r.state FROM capture_observations o
    JOIN article_revisions r ON r.id=o.revision_id WHERE o.task_id=?`).bind(taskId).first();
  if(priorResult){
    const result=captureResult(capture,priorResult.id,priorResult.state,priorResult.outcome);
    const committed=await env.DB.batch([
      env.DB.prepare(`UPDATE task_attempts SET result_json=COALESCE(result_json,?)
        WHERE task_id=? AND attempt_no=? AND ${guard}`).bind(JSON.stringify(result),taskId,attemptNo,...args),
      env.DB.prepare(`UPDATE articles SET lease_until=0 WHERE id=? AND ${guard} RETURNING id`).bind(capture.articleId,...args),
    ]);
    if(!committed[1].results?.length)throw new Error('Capture fence expired before observation replay');
    return result;
  }
  const previous=await env.DB.prepare(`SELECT id,state,raw_fingerprint,semantic_fingerprint FROM article_revisions
    WHERE article_id=? AND revision_no<? ORDER BY revision_no DESC LIMIT 1`).bind(capture.articleId,capture.revisionNo).first();
  const previousReady=await env.DB.prepare(`SELECT semantic_fingerprint FROM article_revisions
    WHERE article_id=? AND revision_no<? AND state='ready' ORDER BY revision_no DESC LIMIT 1`).bind(capture.articleId,capture.revisionNo).first();
  // An incomplete observation keeps its original inventory. A fresh capture may
  // form a complete candidate, but may not fill unknown old bytes with new files.
  const unchanged=previous?.state==='ready'&&previous.raw_fingerprint===capture.rawFingerprint;
  const revisionId=unchanged?previous.id:(await sha(`revision:${taskId}`)).slice(0,24);
  const changeKind=!previousReady?'baseline':previousReady.semantic_fingerprint===capture.semanticFingerprint?'presentation_only':'substantive';
  const blocked=capture.requirements.some(row=>row.required&&row.state==='failed');
  const statements=capture.objects.map(object=>env.DB.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
    SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(sha256) DO NOTHING`)
    .bind(object.sha256,object.r2Key,object.byteSize,object.mediaType,object.verifiedAt,...args));
  if(!unchanged){
    statements.push(env.DB.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,previous_revision_id,capture_task_id,
      observed_at,state,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,title,published_at,source_metadata_json,diagnostics_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(capture_task_id) DO NOTHING`)
      .bind(revisionId,capture.articleId,capture.revisionNo,previous?.id??null,taskId,capture.observedAt,blocked?'blocked':'assembling',
        capture.requirements.length,capture.manifestHash,capture.rawFingerprint,capture.semanticFingerprint,changeKind,capture.title,
        capture.publishedAt,JSON.stringify(capture.sourceMetadata),JSON.stringify(capture.diagnostics),...args));
    for(const row of capture.requirements){
      statements.push(env.DB.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,original_url,filename,name,required,state,
        object_hash,input_hash,derived_output_id,fetched_at,error_code)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
        AND EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND capture_task_id=? AND state<>'ready')
        ON CONFLICT(revision_id,slot_key) DO NOTHING`)
        .bind(revisionId,row.slotKey,row.kind,row.originalUrl??null,row.filename??null,row.name??null,row.required?1:0,row.state,
          row.objectHash,row.inputHash,row.derivedOutputId,row.fetchedAt,row.errorCode,...args,revisionId,taskId));
    }
    statements.push(env.DB.prepare(`UPDATE article_revisions SET state='ready',ready_at=?
      WHERE id=? AND state='assembling' AND ${guard}
      AND requirement_count=(SELECT COUNT(*) FROM revision_requirements WHERE revision_id=article_revisions.id)
      AND NOT EXISTS(SELECT 1 FROM revision_requirements WHERE revision_id=article_revisions.id AND required=1 AND state<>'fulfilled')`)
      .bind(timestamp,revisionId,...args));
    // Publish the newest complete reading model only. Original MVP fields remain
    // unchanged, so disabling version reads restores the intact legacy archive.
    statements.push(env.DB.prepare(`INSERT INTO article_read_models(article_id,revision_id,title,summary,readable_text)
      SELECT article_id,id,title,?,? FROM article_revisions r WHERE id=? AND state='ready' AND ${guard}
      AND NOT EXISTS(SELECT 1 FROM article_read_models m JOIN article_revisions current ON current.id=m.revision_id
        WHERE m.article_id=r.article_id AND current.revision_no>=r.revision_no)
      ON CONFLICT(article_id) DO UPDATE SET revision_id=excluded.revision_id,title=excluded.title,
        summary=excluded.summary,readable_text=excluded.readable_text,extraction_generation=1`)
      .bind(readingExcerpt(capture.body),capture.body,revisionId,...args));
  }
  statements.push(env.DB.prepare(`INSERT INTO capture_observations(task_id,article_id,revision_id,observed_at,outcome)
    SELECT ?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM article_revisions WHERE id=? AND article_id=?)
    ON CONFLICT(task_id) DO NOTHING`)
    .bind(taskId,capture.articleId,revisionId,capture.observedAt,unchanged?'unchanged':'new',...args,revisionId,capture.articleId));
  const resultState=unchanged?'ready':blocked?'blocked':capture.requirements.some(row=>row.required&&row.state!=='fulfilled')?'assembling':'ready';
  const result=captureResult(capture,revisionId,resultState,unchanged?'unchanged':'new');
  const receiptIndex=statements.length;
  statements.push(env.DB.prepare(`UPDATE task_attempts SET result_json=COALESCE(result_json,
      (SELECT json_set(?,'$.revisionState',state,'$.status',CASE WHEN state='ready' THEN 'complete' ELSE 'partial' END)
       FROM article_revisions WHERE id=?)) WHERE task_id=? AND attempt_no=?
    AND ${guard} AND EXISTS(SELECT 1 FROM capture_observations WHERE task_id=? AND revision_id=?) RETURNING result_json`)
    .bind(JSON.stringify(result),revisionId,taskId,attemptNo,...args,taskId,revisionId));
  statements.push(env.DB.prepare(`UPDATE articles SET
      latest_observed_revision_id=CASE WHEN NOT EXISTS(SELECT 1 FROM article_revisions current
        WHERE current.id=articles.latest_observed_revision_id AND current.revision_no>=?) THEN ? ELSE latest_observed_revision_id END,
      latest_ready_revision_id=COALESCE((SELECT revision_id FROM article_read_models WHERE article_id=articles.id),latest_ready_revision_id),lease_until=0
    WHERE id=? AND ${guard} AND EXISTS(SELECT 1 FROM capture_observations WHERE task_id=? AND revision_id=?) RETURNING id`)
    .bind(unchanged?(await env.DB.prepare('SELECT revision_no FROM article_revisions WHERE id=?').bind(revisionId).first()).revision_no:capture.revisionNo,
      revisionId,capture.articleId,...args,taskId,revisionId));
  const committed=await env.DB.batch(statements);
  if(!committed.at(-1).results?.length)throw new Error('Capture fence expired before revision commit');
  const receipt=committed[receiptIndex].results?.[0]?.result_json;
  if(!receipt)throw new Error('Capture task result was not saved');
  return JSON.parse(receipt);
}
function captureResult(capture,revisionId,state,outcome){
  return {id:capture.articleId,revisionId,revisionState:state,status:state==='ready'?'complete':'partial',outcome,
    attachments:capture.requirements.filter(row=>row.kind==='attachment'||row.kind==='body_pdf').length,
    creditsUsed:capture.creditsUsed};
}

const revisionColumns=`r.id,r.article_id AS articleId,r.revision_no AS revisionNo,r.title,r.state,r.observed_at AS observedAt,
  r.ready_at AS readyAt,r.change_kind AS changeKind,
  (SELECT COUNT(*) FROM revision_requirements q WHERE q.revision_id=r.id AND q.required=1 AND q.state<>'fulfilled') AS missingCount`;
const iso=value=>value===null?null:new Date(value).toISOString();
const presentRevision=row=>({...row,observedAt:iso(row.observedAt),readyAt:iso(row.readyAt)});

export async function listRevisions(env,articleId){
  const rows=await env.DB.prepare(`SELECT ${revisionColumns} FROM article_revisions r WHERE r.article_id=? ORDER BY r.revision_no DESC`).bind(articleId).all();
  return rows.results.map(presentRevision);
}
export async function readRevision(env,articleId,revisionId,{current=false}={}){
  const row=await env.DB.prepare(`SELECT ${revisionColumns},r.published_at AS publishedAt,r.diagnostics_json AS diagnostics,
      a.source_id AS sourceId,s.name AS sourceName,a.url
    FROM article_revisions r JOIN articles a ON a.id=r.article_id JOIN sources s ON s.id=a.source_id
    WHERE r.id=? AND r.article_id=?`).bind(revisionId,articleId).first();
  if(!row)return null;
  const rows=await env.DB.prepare(`SELECT q.slot_key AS slotKey,q.kind,q.required,q.state,q.filename,q.name,q.original_url AS originalUrl,
      q.fetched_at AS fetchedAt,q.error_code AS error,q.object_hash AS objectHash,o.r2_key AS objectKey,o.byte_size AS bytes,o.media_type AS contentType
    FROM revision_requirements q LEFT JOIN artifact_objects o ON o.sha256=q.object_hash WHERE q.revision_id=? ORDER BY q.slot_key`)
    .bind(revisionId).all();
  const ready=row.state==='ready',base=`/api/articles/${articleId}/revisions/${revisionId}`;
  const bodyRequirement=rows.results.find(item=>item.kind==='body');
  let bodyText='';
  if(ready&&bodyRequirement?.objectKey){
    const object=await env.ARCHIVE.get(bodyRequirement.objectKey);
    if(!object)throw new Error('Ready revision body is missing');
    bodyText=await object.text();
  }
  const model=current?await env.DB.prepare('SELECT readable_text FROM article_read_models WHERE article_id=? AND revision_id=?').bind(articleId,revisionId).first():null;
  if(ready&&model)bodyText=model.readable_text;
  const files=rows.results.filter(item=>item.kind==='attachment'||item.kind==='body_pdf');
  const attachments=files.map(item=>({id:`${revisionId}:${item.slotKey}`,name:item.name,filename:item.filename,
    bytes:item.bytes??null,contentType:item.contentType??null,status:item.state==='fulfilled'?'complete':item.state,
    error:item.error,role:item.kind==='body_pdf'?'body-pdf':'attachment',originalUrl:item.originalUrl,
    url:ready&&item.objectKey?`${base}/files/${item.filename}`:null,downloadUrl:ready&&item.objectKey?`${base}/files/${item.filename}?download=1`:null}));
  const revision=presentRevision(Object.fromEntries(Object.keys({id:1,articleId:1,revisionNo:1,title:1,state:1,observedAt:1,readyAt:1,changeKind:1,missingCount:1}).map(key=>[key,row[key]])));
  return {revision,requirements:rows.results.map(({objectHash,objectKey,...item})=>({...item,fetchedAt:iso(item.fetchedAt)})),
    article:{id:articleId,title:row.title,sourceId:row.sourceId,sourceName:row.sourceName,url:row.url,publishedAt:row.publishedAt,
      capturedAt:revision.observedAt,status:ready?'complete':'partial',attachmentCount:attachments.length,excerpt:readingExcerpt(bodyText),bodyText,bodyHtml:null,
      error:ready?null:`${row.missingCount} 项必要内容尚未完成`,
      snapshotUrl:ready?`${base}/snapshot`:null,screenshotUrl:ready&&rows.results.some(item=>item.kind==='screenshot')?`${base}/screenshot`:null},attachments};
}
export async function revisionArtifact(env,articleId,revisionId,{filename,kind}){
  return env.DB.prepare(`SELECT q.filename,q.name,q.kind,o.r2_key AS objectKey,o.media_type AS contentType,r.state
    FROM article_revisions r JOIN revision_requirements q ON q.revision_id=r.id JOIN artifact_objects o ON o.sha256=q.object_hash
    WHERE r.article_id=? AND r.id=? AND ${filename?"q.filename=? AND q.kind IN ('attachment','body_pdf')":'q.kind=?'}`)
    .bind(articleId,revisionId,filename||kind).first();
}
