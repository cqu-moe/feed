import { createHash } from 'node:crypto';

// Historical reading data only; capture, OCR and readiness production belong to FEED-03.
function immutableObjectKey(hash) {
  return `objects/sha256/${hash.slice(0, 2)}/${hash}`;
}

async function putImmutableObject(bucket, value, mediaType, controlKind, objects) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = immutableObjectKey(sha256);
  await bucket.put(key, bytes, { httpMetadata: { contentType: mediaType } });
  const object = { sha256, key, byteSize: bytes.byteLength, mediaType, bytes, controlKind };
  if (controlKind) objects.set(controlKind, object);
  return object;
}

function syntheticId(number) {
  return `e2e${String(number).padStart(21, '0')}`;
}

function syntheticPdf(pages) {
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const annotationId = 4 + pages.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((label, index) => {
    const stream = `BT /F1 24 Tf 40 732 Td (${label}) Tj ET\nBT /F1 14 Tf 40 692 Td (Read this original document. Go to last page.) Tj ET\n`;
    const annotation = index === 0 && pages.length > 1 ? ` /Annots [${annotationId} 0 R]` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R${annotation} >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
  if (pages.length > 1) {
    objects.push(`<< /Type /Annot /Subtype /Link /Rect [40 687 400 707] /Border [0 0 0] /Dest [${pageIds.at(-1)} 0 R /Fit] >>`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function seedArticle(db, { id, sourceId, url, title, publishedAt, discoveredAt, status = 'archived' }) {
  await db.batch([
    db.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,discovered_at,status,body_text,excerpt)
      VALUES (?,?,?,?,?,?,?,'','')`).bind(id, sourceId, url, title, publishedAt, new Date(discoveredAt).toISOString(), status),
    db.prepare(`INSERT INTO article_sources(article_id,source_id,first_seen_at,last_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,?,'migrated',?,?,'minute','Asia/Shanghai')`)
      .bind(id, sourceId, discoveredAt, discoveredAt, new Date(discoveredAt).toISOString(), publishedAt),
  ]);
}

async function seedRevision(db, bucket, spec, objects) {
  const requirementRows = [];
  for (const requirement of spec.requirements) {
    const object = requirement.value === undefined
      ? null
      : await putImmutableObject(bucket, requirement.value, requirement.mediaType, requirement.controlKind, objects);
    requirementRows.push({ ...requirement, object });
  }
  const manifest = {
    version: 1,
    requirements: spec.requirements.map(requirement => requirement.slotKey),
    synthetic: true,
    ticket: 'FEED-02',
  };
  const manifestObject = await putImmutableObject(bucket, JSON.stringify(manifest), 'application/json', null, objects);
  const statements = [
    db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,article_id,payload_json,state,due_at,created_at,updated_at)
      VALUES (?,'capture',?, ?,?,'{}','succeeded',?,?,?)`)
      .bind(spec.id, `capture:${spec.id}`, spec.sourceId, spec.articleId, spec.observedAt, spec.observedAt, spec.observedAt),
  ];
  for (const object of [manifestObject, ...requirementRows.map(row => row.object).filter(Boolean)]) {
    statements.push(db.prepare(`INSERT INTO artifact_objects(sha256,r2_key,byte_size,media_type,verified_at)
      VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING`).bind(object.sha256, object.key, object.byteSize, object.mediaType, spec.observedAt));
  }
  statements.push(db.prepare(`INSERT INTO article_revisions(id,article_id,revision_no,previous_revision_id,capture_task_id,
    observed_at,state,requirement_generation,requirement_count,manifest_object_hash,raw_fingerprint,semantic_fingerprint,
    change_kind,title,published_at,source_metadata_json,diagnostics_json,ready_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      spec.id, spec.articleId, spec.revisionNo, spec.previousRevisionId ?? null, spec.id, spec.observedAt,
      spec.state === 'ready' ? 'assembling' : spec.state, 1, requirementRows.length + 1, manifestObject.sha256,
      createHash('sha256').update(`${spec.id}:raw`).digest('hex'),
      createHash('sha256').update(`${spec.id}:semantic`).digest('hex'),
      spec.changeKind, spec.title, spec.publishedAt, JSON.stringify({ synthetic: true }),
      '[]', null,
    ));
  for (const row of requirementRows) {
    statements.push(db.prepare(`INSERT INTO revision_requirements(revision_id,slot_key,kind,original_url,filename,name,required,state,
      object_hash,input_hash,derived_output_id,fetched_at,error_code,processor,processor_version,options_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL)`)
      .bind(
        spec.id, row.slotKey, row.kind, row.originalUrl ?? null, row.filename ?? null, row.name ?? null,
        row.required ? 1 : 0, row.state, row.object?.sha256 ?? null, row.object?.sha256 ?? null,
        row.state === 'fulfilled' ? spec.observedAt : null, row.errorCode ?? null, row.processor ?? null, row.processorVersion ?? null,
      ));
  }
  if (spec.state === 'ready') {
    statements.push(db.prepare('UPDATE article_revisions SET state=?,ready_at=? WHERE id=? AND state=?')
      .bind('ready', spec.readyAt, spec.id, 'assembling'));
  }
  statements.push(db.prepare(`INSERT INTO capture_observations(task_id,article_id,revision_id,observed_at,outcome)
    VALUES (?,?,?,?, 'new')`).bind(spec.id, spec.articleId, spec.id, spec.observedAt));
  if (spec.state === 'ready') {
    statements.push(db.prepare(`INSERT INTO content_events(id,revision_id,article_id,kind,observed_at,ready_at,history_only,
      date_state,payload_hash,created_at) VALUES (?,?,?,?,?,?,0,'verified',?,?)`)
      .bind(spec.eventId, spec.id, spec.articleId, spec.revisionNo === 1 ? 'initial' : 'update', spec.observedAt, spec.readyAt,
        createHash('sha256').update(`${spec.id}:payload`).digest('hex'), spec.readyAt));
    statements.push(db.prepare(`INSERT INTO event_sources(event_id,source_id,article_source_first_seen_at,discovery_class,
      published_at,published_day,date_precision,source_timezone) VALUES (?,?,?,'migrated',?,?,'minute','Asia/Shanghai')`)
      .bind(spec.eventId, spec.sourceId, spec.discoveredAt, spec.publishedAt, spec.publishedDay));
  }
  if (spec.current) {
    statements.push(db.prepare(`INSERT INTO article_read_models(article_id,revision_id,title,summary,readable_text)
      VALUES (?,?,?,?,?)`).bind(spec.articleId, spec.id, spec.title, spec.summary, spec.readableText));
  }
  await db.batch(statements);
  return { manifestObject };
}

export async function seedSyntheticReadingArchive(db, bucket) {
  const objects = new Map();
  const webArticleId = 'e2e000000000000000000002';
  const pdfArticleId = 'e2e000000000000000000003';
  const webOld = 'e2e000000000000000000012';
  const webCurrent = 'e2e000000000000000000022';
  const webUnready = 'e2e000000000000000000032';
  const pdfOld = 'e2e000000000000000000013';
  const pdfCurrent = 'e2e000000000000000000023';
  const currentPdf = syntheticPdf(['REAL PDF PAGE ONE', 'REAL PDF PAGE TWO', 'REAL PDF PAGE THREE']);
  const oldPdf = syntheticPdf(['OLD PDF PAGE ONE', 'OLD PDF PAGE TWO', 'OLD PDF PAGE THREE']);
  const ordinaryPdf = syntheticPdf(['ORDINARY ATTACHMENT PAGE ONE', 'ORDINARY ATTACHMENT PAGE TWO']);
  const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const oldScreenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==', 'base64');
  const currentWebBody = '这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。\n\n当前附件和原貌存档均来自同一版本。';
  const oldWebBody = '这是历史完整网页正文，附件与快照均属于旧版本。';

  await seedArticle(db, {
    id: webArticleId, sourceId: 'jwc', url: 'https://jwc.cqu.edu.cn/info/1082/feed02-web.htm',
    title: 'FEED02 网页通知（当前完整版本）', publishedAt: '2026-10-13', discoveredAt: Date.parse('2026-10-13T09:00:00Z'),
  });
  await seedRevision(db, bucket, {
    id: webOld, articleId: webArticleId, sourceId: 'jwc', eventId: syntheticId(101), revisionNo: 1,
    previousRevisionId: null, state: 'ready', changeKind: 'baseline', title: 'FEED02 网页通知（历史完整版本）',
    publishedAt: '2026-10-13', publishedDay: '2026-10-13', observedAt: Date.parse('2026-10-13T09:00:00Z'),
    readyAt: Date.parse('2026-10-13T09:00:02Z'), discoveredAt: Date.parse('2026-10-13T09:00:00Z'),
    summary: '历史批次材料', readableText: oldWebBody, current: false,
    requirements: [
      { slotKey: 'body', kind: 'body', required: true, state: 'fulfilled', name: '统一正文', value: oldWebBody, mediaType: 'text/plain; charset=utf-8' },
      { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'fulfilled', name: '原貌存档', value: '<!doctype html><meta charset="utf-8"><title>旧快照</title><main>旧版本快照</main>', mediaType: 'text/html; charset=utf-8' },
      { slotKey: 'screenshot', kind: 'screenshot', required: false, state: 'fulfilled', name: '网页截图', value: oldScreenshot, mediaType: 'image/png', controlKind: 'old-screenshot' },
      { slotKey: 'attachment-1', kind: 'attachment', required: true, state: 'fulfilled', filename: 'attachment-4.doc', name: '历史申请表.doc', originalUrl: 'https://jwc.cqu.edu.cn/files/feed02-old.doc', value: 'FEED02 old ordinary attachment', mediaType: 'application/msword' },
    ],
  }, objects);
  await seedRevision(db, bucket, {
    id: webCurrent, articleId: webArticleId, sourceId: 'jwc', eventId: syntheticId(102), revisionNo: 2,
    previousRevisionId: webOld, state: 'ready', changeKind: 'substantive', title: 'FEED02 网页通知（当前完整版本）',
    publishedAt: '2026-10-13', publishedDay: '2026-10-13', observedAt: Date.parse('2026-10-14T09:00:00Z'),
    readyAt: Date.parse('2026-10-14T09:00:02Z'), discoveredAt: Date.parse('2026-10-13T09:00:00Z'),
    summary: '当前批次材料', readableText: currentWebBody, current: true,
    requirements: [
      { slotKey: 'body', kind: 'body', required: true, state: 'fulfilled', name: '统一正文', value: currentWebBody, mediaType: 'text/plain; charset=utf-8', controlKind: 'web-body' },
      { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'fulfilled', name: '原貌存档', value: '<!doctype html><meta charset="utf-8"><title>当前网页快照</title><main>当前版本快照</main>', mediaType: 'text/html; charset=utf-8' },
      { slotKey: 'screenshot', kind: 'screenshot', required: false, state: 'fulfilled', name: '网页截图', value: screenshot, mediaType: 'image/png', controlKind: 'current-screenshot' },
      { slotKey: 'attachment-1', kind: 'attachment', required: true, state: 'fulfilled', filename: 'attachment-3.doc', name: '当前申请表.doc', originalUrl: 'https://jwc.cqu.edu.cn/files/feed02-current.doc', value: 'FEED02 current ordinary attachment', mediaType: 'application/msword' },
    ],
  }, objects);
  await seedRevision(db, bucket, {
    id: webUnready, articleId: webArticleId, sourceId: 'jwc', eventId: syntheticId(103), revisionNo: 3,
    previousRevisionId: webCurrent, state: 'blocked', changeKind: 'substantive', title: 'FEED02 网页通知（未完成版本）',
    publishedAt: '2026-10-13', publishedDay: '2026-10-13', observedAt: Date.parse('2026-10-15T09:00:00Z'),
    readyAt: null, discoveredAt: Date.parse('2026-10-13T09:00:00Z'), summary: '', readableText: '', current: false,
    requirements: [
      { slotKey: 'body', kind: 'body', required: true, state: 'failed', name: '统一正文', errorCode: 'artifact_missing' },
      { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'pending', name: '原貌存档', errorCode: 'artifact_missing' },
      { slotKey: 'attachment-1', kind: 'attachment', required: true, state: 'pending', filename: 'attachment-5.doc', name: '未完成申请表.doc', originalUrl: 'https://jwc.cqu.edu.cn/files/feed02-unready.doc', errorCode: 'attachment_missing' },
    ],
  }, objects);
  await db.prepare(`UPDATE articles SET latest_observed_revision_id=?,latest_ready_revision_id=?,next_revision_no=4 WHERE id=?`)
    .bind(webUnready, webCurrent, webArticleId).run();

  const pdfSnapshot = `<!doctype html><meta charset="utf-8"><title>FEED02 PDF 当前版本快照</title>
<main><h1>FEED02 PDF 当前版本快照</h1><script>alert('must be removed')</script>
<form action="https://jwc.cqu.edu.cn/submit"><input name="must-not-submit"></form>
<a href="/api/files/${pdfArticleId}/attachment-2.pdf?download=1">快照内普通附件</a>
<iframe data-feed-pdf="attachment-1.pdf" src="https://jwc.cqu.edu.cn/source.pdf" title="源站 PDF"></iframe>
<iframe src="https://evil.example.test/frame" title="必须删除的外站框架"></iframe>
<button type="button" onclick="alert('handler must be removed')">危险按钮</button></main>`;
  await seedArticle(db, {
    id: pdfArticleId, sourceId: 'intex', url: 'https://intex.cqu.edu.cn/info/1082/feed02-pdf.htm',
    title: 'FEED02 PDF 正文通知', publishedAt: '2026-10-14', discoveredAt: Date.parse('2026-10-14T10:00:00Z'),
  });
  await seedRevision(db, bucket, {
    id: pdfOld, articleId: pdfArticleId, sourceId: 'intex', eventId: syntheticId(104), revisionNo: 1,
    state: 'ready', changeKind: 'baseline', title: 'FEED02 PDF 正文通知', publishedAt: '2026-10-14',
    publishedDay: '2026-10-14', observedAt: Date.parse('2026-10-14T10:00:00Z'), readyAt: Date.parse('2026-10-14T10:00:02Z'),
    discoveredAt: Date.parse('2026-10-14T10:00:00Z'), summary: '历史 PDF 正文', readableText: '这是历史 PDF 版本的统一正文。', current: false,
    requirements: [
      { slotKey: 'body', kind: 'body', required: true, state: 'fulfilled', name: '统一正文', value: '这是历史 PDF 版本的统一正文。', mediaType: 'text/plain; charset=utf-8' },
      { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'fulfilled', name: '原貌存档', value: '<!doctype html><meta charset="utf-8"><title>旧 PDF 快照</title><main>旧 PDF 快照</main>', mediaType: 'text/html; charset=utf-8' },
      { slotKey: 'screenshot', kind: 'screenshot', required: false, state: 'fulfilled', name: '网页截图', value: screenshot, mediaType: 'image/png' },
      { slotKey: 'body-pdf', kind: 'body_pdf', required: true, state: 'fulfilled', filename: 'attachment-1.pdf', name: '历史通知原件.pdf', originalUrl: 'https://intex.cqu.edu.cn/files/feed02-old.pdf', value: oldPdf, mediaType: 'application/pdf', controlKind: 'old-pdf' },
    ],
  }, objects);
  await seedRevision(db, bucket, {
    id: pdfCurrent, articleId: pdfArticleId, sourceId: 'intex', eventId: syntheticId(105), revisionNo: 2,
    previousRevisionId: pdfOld, state: 'ready', changeKind: 'substantive', title: 'FEED02 PDF 正文通知',
    publishedAt: '2026-10-14', publishedDay: '2026-10-14', observedAt: Date.parse('2026-10-15T10:00:00Z'),
    readyAt: Date.parse('2026-10-15T10:00:02Z'), discoveredAt: Date.parse('2026-10-14T10:00:00Z'),
    summary: '当前 PDF 正文', readableText: '这是可搜索的正文文字，但默认阅读仍应打开原件。', current: true,
    requirements: [
      { slotKey: 'body', kind: 'body', required: true, state: 'fulfilled', name: '统一正文', value: '这是可搜索的正文文字，但默认阅读仍应打开原件。', mediaType: 'text/plain; charset=utf-8' },
      { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'fulfilled', name: '原貌存档', value: pdfSnapshot, mediaType: 'text/html; charset=utf-8' },
      { slotKey: 'screenshot', kind: 'screenshot', required: false, state: 'fulfilled', name: '网页截图', value: screenshot, mediaType: 'image/png' },
      { slotKey: 'body-pdf', kind: 'body_pdf', required: true, state: 'fulfilled', filename: 'attachment-1.pdf', name: '通知原件.pdf', originalUrl: 'https://intex.cqu.edu.cn/files/feed02-current.pdf', value: currentPdf, mediaType: 'application/pdf', controlKind: 'current-pdf' },
      { slotKey: 'attachment-1', kind: 'attachment', required: true, state: 'fulfilled', filename: 'attachment-2.pdf', name: '普通附件.pdf', originalUrl: 'https://intex.cqu.edu.cn/files/feed02-ordinary.pdf', value: ordinaryPdf, mediaType: 'application/pdf', controlKind: 'ordinary-pdf' },
    ],
  }, objects);
  await db.prepare(`UPDATE articles SET latest_observed_revision_id=?,latest_ready_revision_id=?,next_revision_no=3 WHERE id=?`)
    .bind(pdfCurrent, pdfCurrent, pdfArticleId).run();

  for (let index = 0; index < 22; index += 1) {
    const articleId = syntheticId(200 + index);
    const revisionId = syntheticId(300 + index);
    const body = `FEED02 分页存档资料 ${index + 1}：这是只用于分页和检索的固定合成正文。`;
    await seedArticle(db, {
      id: articleId, sourceId: 'jwc', url: `https://jwc.cqu.edu.cn/info/1082/feed02-filler-${index}.htm`,
      title: `FEED02 分页通知 ${index + 1}`, publishedAt: `2026-09-${String(30 - index).padStart(2, '0')}`,
      discoveredAt: Date.parse(`2026-09-${String(30 - index).padStart(2, '0')}T08:00:00Z`),
    });
    await seedRevision(db, bucket, {
      id: revisionId, articleId, sourceId: 'jwc', eventId: syntheticId(400 + index), revisionNo: 1,
      state: 'ready', changeKind: 'baseline', title: `FEED02 分页通知 ${index + 1}`,
      publishedAt: `2026-09-${String(30 - index).padStart(2, '0')}`, publishedDay: `2026-09-${String(30 - index).padStart(2, '0')}`,
      observedAt: Date.parse(`2026-09-${String(30 - index).padStart(2, '0')}T08:00:00Z`),
      readyAt: Date.parse(`2026-09-${String(30 - index).padStart(2, '0')}T08:00:02Z`),
      discoveredAt: Date.parse(`2026-09-${String(30 - index).padStart(2, '0')}T08:00:00Z`),
      summary: `分页资料 ${index + 1}`, readableText: body, current: true,
      requirements: [
        { slotKey: 'body', kind: 'body', required: true, state: 'fulfilled', name: '统一正文', value: body, mediaType: 'text/plain; charset=utf-8' },
        { slotKey: 'snapshot', kind: 'snapshot', required: true, state: 'fulfilled', name: '原貌存档', value: `<!doctype html><meta charset="utf-8"><title>分页资料 ${index + 1}</title><main>${body}</main>`, mediaType: 'text/html; charset=utf-8' },
      ],
    }, objects);
    await db.prepare('UPDATE articles SET latest_observed_revision_id=?,latest_ready_revision_id=?,next_revision_no=2 WHERE id=?')
      .bind(revisionId, revisionId, articleId).run();
  }

  const descriptor = controlKind => {
    const object = objects.get(controlKind);
    if (!object) throw new Error(`Synthetic reading object ${controlKind} is missing`);
    return { sha256: object.sha256, byteSize: object.byteSize };
  };
  return {
    objects,
    manifest: {
      webArticleId, webCurrentRevisionId: webCurrent, webOldRevisionId: webOld, webUnreadyRevisionId: webUnready,
      pdfArticleId, pdfCurrentRevisionId: pdfCurrent, pdfOldRevisionId: pdfOld,
      currentPdf: descriptor('current-pdf'), oldPdf: descriptor('old-pdf'), ordinaryPdf: descriptor('ordinary-pdf'),
      currentScreenshotSha256: descriptor('current-screenshot').sha256, oldScreenshotSha256: descriptor('old-screenshot').sha256,
    },
  };
}
