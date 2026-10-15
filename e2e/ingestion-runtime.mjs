import { createHash, randomBytes } from 'node:crypto';
import { mixedPdf } from '../tests/helpers/mixed-pdf.mjs';

export const SCHOOL = 'https://school.example.test';
const hash = bytes => createHash('sha256').update(typeof bytes === 'string' ? bytes : Buffer.from(bytes)).digest('hex');
const title = n => `采集验收通知${n}`;
const body = mode => ['ocr', 'ocr-invalid'].includes(mode) ? '采集验收第二版完整正文' : '采集验收第一版完整正文';
const pdf = mode => Buffer.from(mixedPdf({ firstPageText: mode === 'ocr-invalid' ? 'Independent OCR failure document' : 'Independent second revision document' }));
const ordinaryPdf = Buffer.from('%PDF-1.7\nFEED03 ordinary attachment original bytes\n%%EOF\n');

// Only the external Firecrawl/school and TextIn boundaries are replaced. Their
// responses are evidence inputs, never ready revisions, task receipts or tokens.
export function createIngestionFixture() {
  let mode = 'baseline';
  let ocrRelease;
  let ocrGate;
  let bucket;
  let hidden;
  const calls = [];
  const faults = [];
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = offset => calendar.format(new Date(Date.now() + offset * 86400000));
  const bindings = {
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    BRIDGE_SECRET: 'synthetic-ingestion-bridge-secret',
    FIRECRAWL_API_KEY: 'synthetic-firecrawl',
    TEXTIN_APP_ID: 'synthetic-textin', TEXTIN_SECRET_CODE: 'synthetic-textin',
    CRAWL_ENABLED: 'true', TASK_RUNTIME_ENABLED: 'true',
    ARCHIVE_VERSIONS_ENABLED: 'true', ARCHIVE_READS_ENABLED: 'true',
    PDF_OCR_ENABLED: 'true', PDF_OCR_MODEL: 'textin-xparse-auto',
    QUEUE_DEAD_LETTER_AFTER_MS: '60000', MAX_TASK_ATTEMPTS: '3',
    MAX_DISCOVERY_PAGES_PER_RUN: '2', MAX_BACKFILL_PAGES_PER_RUN: '5',
  };
  const consumers = Object.fromEntries(['jobs', 'events'].map(lane => [
    `feed-e2e-${lane}`, { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0, deadLetterQueue: 'feed-e2e-dlq' },
  ]));
  const deadLetterObserver = {
    name: 'feed-dlq-observer',
    modules: [{ type: 'ESModule', path: 'ingestion-dlq-observer.mjs', contents: `export default {
      async queue(batch,env) { for(const message of batch.messages) {
        await env.DB.prepare('INSERT INTO ingestion_dlq_observations(queue,message_json,observed_at) VALUES (?,?,?)')
          .bind(batch.queue,JSON.stringify(message.body),Date.now()).run(); message.ack();
      }}
    };` }],
    compatibilityDate: '2026-10-11',
    d1Databases: { DB: 'feed-e2e-database' },
    queueConsumers: { 'feed-e2e-dlq': { maxBatchSize: 1, maxBatchTimeout: 0 } },
    outboundService: () => new Response('DLQ observer egress denied', { status: 502 }),
  };

  function capture(url) {
    const n = Number(new URL(url).pathname.match(/(\d+)\.htm$/)?.[1]);
    const primary = n === 1001;
    const activeMode = primary ? mode : 'baseline';
    const file = ['ocr', 'ocr-invalid'].includes(activeMode) ? pdf(activeMode) : ordinaryPdf;
    const missing = activeMode === 'missing';
    const text = primary ? body(activeMode) : `${title(n)}独立分页正文`;
    const html = `<!doctype html><html><head><title>${title(n)}</title></head><body><main class="${activeMode}"><h1>${title(n)}</h1><p>${text}</p></main></body></html>`;
    const fileUrl = `${SCHOOL}/files/${n}.pdf`;
    const attached = primary;
    return {
      markdown: text, rawHtml: html, metadata: { statusCode: 200, creditsUsed: 1 },
      actions: { javascriptReturns: [{ value: JSON.stringify({
        bodyRecognized: true, page: { url, title: title(n) }, heading: title(n),
        bodyText: text, bodyHtml: `<p class="${activeMode}">${text}</p>`, bodyCapturedAt: new Date().toISOString(), errors: [],
        artifacts: [
          { name: 'offline.html', base64: Buffer.from(html).toString('base64'), contentType: 'text/html; charset=utf-8' },
          ...(attached && !missing ? [{ name: 'attachment-1.pdf', base64: file.toString('base64'), contentType: 'application/pdf' }] : []),
        ],
        attachmentCandidates: attached ? [{ url: fileUrl, name: '验收原件.pdf', role: ['ocr', 'ocr-invalid'].includes(activeMode) ? 'body-pdf' : 'attachment' }] : [],
        downloads: attached ? [{ url: fileUrl, originalFile: !missing, kind: 'pdf',
          role: ['ocr', 'ocr-invalid'].includes(activeMode) ? 'body-pdf' : 'attachment',
          ...(missing ? { error: 'Synthetic school attachment unavailable' } : { saved: { name: 'attachment-1.pdf' }, fetchedAt: new Date().toISOString() }),
        }] : [],
      }) }] },
    };
  }

  return {
    bindings, consumers, deadLetterObserver,
    release() { ocrRelease?.(); ocrRelease = null; },
    async initialize(db, archive) {
      bucket = archive;
      // Migrations include the production source catalogue. Disable it before
      // scheduling; synthetic sources are created through /internal below.
      await db.prepare('UPDATE sources SET enabled=0').run();
      await db.prepare('CREATE TABLE ingestion_dlq_observations(queue TEXT,message_json TEXT,observed_at INTEGER)').run();
      for (const table of ['articles', 'tasks', 'article_revisions', 'content_events', 'derived_outputs']) {
        if ((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n !== 0) throw new Error(`Ingestion requires empty ${table}`);
      }
      if ((await bucket.list()).objects.length) throw new Error('Ingestion requires empty R2');
    },
    async outbound(request) {
      const target = new URL(request.url);
      if (target.href === 'https://api.firecrawl.dev/v2/scrape' && request.method === 'POST') {
        const input = await request.json();
        const url = new URL(input.url);
        if (url.origin !== SCHOOL) throw new Error('Fixture refuses non-synthetic school');
        const list = input.formats?.includes('links');
        calls.push({ provider: 'firecrawl', url: url.href, kind: list ? 'list' : 'article', mode });
        if (mode === 'failure' && !list && url.pathname.endsWith('/1001.htm')) return Response.json({ success: false, error: 'Synthetic upstream outage' }, { status: 500 });
        if (!list) return Response.json({ success: true, data: capture(url.href) });
        const page2 = url.pathname.endsWith('page2');
        const articles = page2 ? [{ url: `${SCHOOL}/info/2026/1002.htm`, title: title(1002), publishedAt: day(0) + ' 09:02' }]
          : [{ url: `${SCHOOL}/info/2026/1001.htm?utm_source=duplicate`, title: title(1001), publishedAt: day(0) + ' 09:01' },
            { url: `${SCHOOL}/info/2026/1003.htm`, title: title(1003), publishedAt: day(-10) + ' 09:03' }];
        return Response.json({ success: true, data: { metadata: { statusCode: 200, creditsUsed: 1 },
          actions: { javascriptReturns: [{ value: JSON.stringify({ articles, next: page2 ? [] : [new URL('page2', url.href + '/').href] }) }] } } });
      }
      if (target.href === 'https://api.textin.com/api/v1/xparse/parse/sync' && request.method === 'POST') {
        const form = await request.formData();
        const file = Buffer.from(await form.get('file').arrayBuffer());
        const config = JSON.parse(form.get('config'));
        const invalid = mode === 'ocr-invalid';
        calls.push({ provider: 'textin', inputHash: hash(file), bytes: file.length, config, mode });
        if (ocrGate) await ocrGate;
        if (invalid) return Response.json({ code: 200, data: { schema_version: '1.4.0', success_count: 1, metadata: { page_count: 2 }, pages: [], elements: [] } });
        return Response.json({ code: 200, data: { schema_version: '1.4.0', success_count: 1, metadata: { page_count: 2 },
          pages: [{ page_number: 2, status: 'Success', element_ids: ['scan'] }],
          elements: [{ element_id: 'scan', page_number: 2, type: 'NarrativeText', text: '独立扫描正文可检索', metadata: {} }],
        } });
      }
      return null;
    },
    async control(input, { mf, db }) {
      if (input.action === 'ingestion-mode') {
        if (!['baseline', 'layout', 'missing', 'ocr', 'ocr-invalid', 'failure'].includes(input.mode)) throw new Error('Invalid provider mode');
        mode = input.mode;
        if (input.holdOcr) ocrGate = new Promise(done => { ocrRelease = done; });
        return { mode };
      }
      if (input.action === 'ingestion-release-ocr') { ocrRelease?.(); ocrRelease = null; ocrGate = null; return { released: true }; }
      if (input.action === 'ingestion-hide-snapshot') {
        if (hidden) throw new Error('Snapshot already hidden');
        const row = await db.prepare(`SELECT o.r2_key FROM revision_requirements q JOIN artifact_objects o ON o.sha256=q.object_hash
          WHERE q.revision_id=? AND q.kind='snapshot'`).bind(input.revisionId).first();
        const object = await bucket.get(row.r2_key);
        hidden = { key: row.r2_key, bytes: await object.arrayBuffer(), httpMetadata: object.httpMetadata };
        await bucket.delete(hidden.key);
        if (await bucket.head(hidden.key)) throw new Error('R2 deletion was not observed');
        faults.push({ type: 'r2-snapshot-removed', revisionId: input.revisionId, key: hidden.key });
        return { removed: true };
      }
      if (input.action === 'ingestion-restore-snapshot') {
        if (!hidden) throw new Error('No missing snapshot');
        await bucket.put(hidden.key, hidden.bytes, { httpMetadata: hidden.httpMetadata, sha256: hash(hidden.bytes) });
        if (hash(await (await bucket.get(hidden.key)).arrayBuffer()) !== hash(hidden.bytes)) throw new Error('Snapshot restore mismatch');
        faults.push({ type: 'r2-snapshot-restored', key: hidden.key }); hidden = null;
        return { restored: true };
      }
      if (input.action === 'ingestion-duplicate') {
        const outbox = await db.prepare('SELECT topic,payload_json FROM outbox WHERE id=?').bind(input.outboxId).first();
        if (!outbox) throw new Error('Cannot redeliver an absent outbox');
        const producer = await mf.getQueueProducer(outbox.topic === 'feed-jobs' ? 'FEED_JOBS' : 'FEED_EVENTS', 'feed');
        await producer.send(JSON.parse(outbox.payload_json));
        return { redelivered: input.outboxId };
      }
      if (input.action === 'ingestion-recheck-due') {
        // Move only an existing schedule deadline. The real admin entry point
        // must select, create, dispatch and process every recheck itself.
        const result = await db.prepare('UPDATE articles SET next_recheck_at=? WHERE id=? AND latest_ready_revision_id IS NOT NULL')
          .bind(Date.now() - 1, input.articleId).run();
        if (result.meta.changes !== 1) throw new Error('Recheck requires a real ready article');
        faults.push({ type: 'recheck-deadline-due', articleId: input.articleId });
        return { due: true };
      }
      if (input.action !== 'ingestion-state') throw new Error('Unknown ingestion control');
      const state = { calls: [...calls], faults: [...faults], mode, expected: {
        ordinaryPdfHash: hash(ordinaryPdf), ocrPdfHash: hash(pdf('ocr')), invalidOcrPdfHash: hash(pdf('ocr-invalid')),
      } };
      for (const [name, sql] of Object.entries({
        articles: 'SELECT id,url,latest_ready_revision_id,latest_observed_revision_id FROM articles ORDER BY url',
        sources: 'SELECT article_id,source_id,discovery_class FROM article_sources ORDER BY article_id,source_id',
        tasks: 'SELECT id,kind,article_id,source_id,state,attempt_no,last_error FROM tasks ORDER BY created_at,id',
        attempts: 'SELECT task_id,attempt_no,workflow_instance_id,state,handed_off_at,result_json FROM task_attempts ORDER BY task_id,attempt_no',
        revisions: 'SELECT id,article_id,revision_no,state,change_kind FROM article_revisions ORDER BY article_id,revision_no',
        requirements: 'SELECT revision_id,slot_key,kind,state,object_hash,input_hash FROM revision_requirements ORDER BY revision_id,slot_key',
        events: 'SELECT id,article_id,revision_id,kind,history_only FROM content_events ORDER BY created_at,id',
        outbox: 'SELECT o.id,o.topic,o.dedupe_key,o.payload_json,o.state,r.state AS receipt_state,r.attempts AS receipt_attempts,r.replay_count FROM outbox o LEFT JOIN outbox_receipts r ON r.outbox_id=o.id ORDER BY o.created_at,o.id',
        dlq: 'SELECT * FROM ingestion_dlq_observations ORDER BY observed_at',
        ocrCalls: 'SELECT id,attempts,result_key,error FROM pdf_ocr_calls ORDER BY id',
      })) state[name] = (await db.prepare(sql).all()).results;
      state.objects = [];
      let cursor;
      do {
        const page = await bucket.list({ cursor });
        for (const object of page.objects) {
          const bytes = await (await bucket.get(object.key)).arrayBuffer();
          state.objects.push({ key: object.key, bytes: bytes.byteLength, sha256: hash(bytes) });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return state;
    },
  };
}
