import {createHash} from 'node:crypto';

export async function seedReadyEvent(mf, {
  id,
  sourceId,
  firstSeenAt,
  observedAt,
  readyAt,
  publishedAt,
  publishedDay = null,
  datePrecision,
  kind = 'initial',
  historyOnly = 0,
  discoveryClass = 'live',
  additionalSourceIds = [],
  title = '及时匹配通知',
}) {
  const db = await mf.getD1Database('DB', 'feed');
  const articleId = id;
  const revisionId = id;
  const taskId = id;
  const objectHash = createHash('sha256').update(`${id}:manifest`).digest('hex');
  await db.batch([
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status)
      VALUES (?,?,?,?,?,?, 'archived')`)
      .bind(articleId, sourceId, `https://jwc.cqu.edu.cn/info/2026/${id}.htm`, title,
        publishedDay ?? publishedAt?.slice(0, 10) ?? 'unknown', new Date(firstSeenAt).toISOString()),
    db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,? ,?,?,?,?,?,?,'Asia/Shanghai')`)
      .bind(articleId, sourceId, firstSeenAt, firstSeenAt, discoveryClass, datePrecision === 'minute' ? publishedAt : null,
        datePrecision === 'unknown' ? null : publishedDay ?? publishedAt?.slice(0, 10), datePrecision),
    ...additionalSourceIds.map(sourceId=>db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,?,?,?,?, 'Asia/Shanghai')`)
      .bind(articleId,sourceId,firstSeenAt,firstSeenAt,discoveryClass,datePrecision==='minute'?publishedAt:null,
        datePrecision==='unknown'?null:publishedDay??publishedAt?.slice(0,10),datePrecision)),
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'capture',?,? ,?,'{}','succeeded',?,?,?)`)
      .bind(taskId, `capture:${id}`, sourceId, articleId, readyAt, firstSeenAt, readyAt),
    db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,1,'application/json',?)`)
      .bind(objectHash, `notifications/${id}/manifest.json`, firstSeenAt),
    db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,capture_task_id,observed_at,state,
      requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,change_kind,
      title,published_at,source_metadata_json,ready_at)
      VALUES (?, ?,1,?,?,'ready',1,1,?,?,? ,? ,?,?,'{}',?)`)
      .bind(revisionId, articleId, taskId, observedAt, objectHash,
        createHash('sha256').update(`${id}:raw`).digest('hex'),
        createHash('sha256').update(`${id}:semantic`).digest('hex'),
        kind === 'update' ? 'substantive' : 'baseline', title, publishedAt ?? publishedDay ?? null, readyAt),
    db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,history_only,
      date_state,payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, revisionId, articleId, kind, observedAt, readyAt, historyOnly,
        datePrecision === 'unknown' ? 'date_unknown' : 'verified',
        createHash('sha256').update(`${id}:payload`).digest('hex'), readyAt),
    db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,?,?, ?,?,?,?,'Asia/Shanghai')`)
      .bind(id, sourceId, firstSeenAt, discoveryClass, datePrecision === 'minute' ? publishedAt : null,
        datePrecision === 'unknown' ? null : publishedDay ?? publishedAt?.slice(0, 10), datePrecision),
    ...additionalSourceIds.map(sourceId=>db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
        published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,?,?,?, 'Asia/Shanghai')`)
      .bind(id,sourceId,firstSeenAt,discoveryClass,datePrecision==='minute'?publishedAt:null,
        datePrecision==='unknown'?null:publishedDay??publishedAt?.slice(0,10),datePrecision)),
  ]);
  return id;
}
