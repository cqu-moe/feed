import { beforeEach, afterEach, test, type Browser } from './test-api';
import { credentials, expect } from './test-api';
import { request as httpsRequest } from 'node:https';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// FEED-03 owns production of archived facts. FEED-02 owns detailed reader/PDF
// controls. This suite reads only the files and versions its own ingestion made.
type Row = Record<string, any>;
type State = Record<'articles' | 'sources' | 'tasks' | 'attempts' | 'revisions' | 'requirements' | 'events' | 'outbox' | 'dlq' | 'ocrCalls' | 'calls' | 'objects', Row[]> & { expected: Record<string, string> };
const school = 'https://school.example.test';
let unexpected: string[];
const checkpoints: string[] = [];
const operations: { method: string; path: string; status: number }[] = [];

beforeEach(async ({ browser }) => {
  unexpected = [];
  checkpoints.length = 0;
  operations.length = 0;
  const allowed = [process.env.FEED_E2E_APP_URL!, process.env.FEED_E2E_AUTH_URL!].map(url => new URL(url).origin);
  await browser.route('**/*', async route => {
    if (!allowed.includes(new URL(route.request.url).origin)) {
      unexpected.push(new URL(route.request.url).origin);
      await route.abort();
    } else await route.continue();
  });
});
afterEach(async () => {
  await saveCheckpoints();
  expect(unexpected).toEqual([]);
});

test('FEED03 native Queue Workflow ingestion, completeness, replay and recovery', async ({ app, browser, screen }) => {
  await app.open('/subscriptions');
  await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();
  if (process.env.FEED_E2E_BREAK_ASSERTION === '1') await expect(screen.getByRole('heading', '故意错误的采集成功断言')).toBeVisible();
  const empty = await state();
  for (const table of ['articles', 'tasks', 'revisions', 'events', 'objects'] as const) expect(empty[table]).toEqual([]);
  expect((await admin('/internal/sources', 'GET', undefined, '')).status).toBe(401);
  expect((await admin('/internal/sources/schedule', 'POST', {}, 'wrong-admin-token')).status).toBe(401);
  expect((await admin('/internal/operations/diagnostics', 'GET', undefined, '')).status).toBe(401);
  expect((await state()).tasks).toEqual([]);
  await mark('empty D1/R2 and actual administrator denial');

  const site = (await ok('/internal/sites', 'POST', { name: '合成学校', origin: school, requestId: 'feed03-site-create' }, 201)).site;
  const sourceIds: string[] = [];
  for (const lane of ['a', 'b']) {
    const result = await ok('/internal/sources', 'POST', {
      siteId: site.id, name: `验收栏目${lane}`, listUrl: `${school}/lists/${lane}`,
      articlePattern: '^/info/2026/\\d+\\.htm$', sampleArticleUrl: `${school}/info/2026/1001.htm`,
      refreshIntervalSec: 86400, timezone: 'Asia/Shanghai',
    }, 201);
    const id = result.source.id;
    sourceIds.push(id);
    expect((await admin(`/internal/sources/${id}`, 'PATCH', { enabled: true })).status).toBe(409);
    const validation = await ok(`/internal/sources/${id}/verify`, 'POST', { requestId: `feed03-validate-${lane}` }, 202);
    await until(`source ${lane} validated through Workflow`, async () => {
      const source = (await ok(`/internal/sources/${id}`)).source;
      return source.validationState === 'verified' ? source : null;
    });
    const task = await waitTask(validation.task.id, 'succeeded');
    expect(task.attempt.workflowInstanceId).toBe(`task-${validation.task.id}-a1`);
    const verified = (await ok(`/internal/sources/${id}`)).source;
    expect(verified.validationJson).toMatchObject({ listPages: 2, paginationVerified: true, attachmentSample: true, snapshotSample: true, articleBody: true });
    await ok(`/internal/sources/${id}`, 'PATCH', { enabled: true });
  }
  expect((await state()).articles).toEqual([]);
  await mark('source validation uses native discovery workflows and does not seed articles');

  await ok('/internal/sources/schedule', 'POST', {}, 202);
  let observed = await until('two live ready articles and four associations', async () => {
    const s = await state();
    return s.articles.length === 2 && s.sources.length === 4 && s.revisions.filter(r => r.state === 'ready').length === 2 ? s : null;
  });
  const mainId = observed.articles.find(row => row.url.endsWith('/1001.htm'))!.id;
  const firstRevision = observed.articles.find(row => row.id === mainId)!.latest_ready_revision_id;
  expect(observed.articles.some(row => row.url.includes('utm_'))).toBe(false);
  expect(observed.tasks.filter(row => row.kind === 'capture')).toHaveLength(2);
  expect(observed.tasks.filter(row => row.kind === 'discover')).toHaveLength(6); // two validation + two pages per source
  expect(observed.events.filter(row => row.history_only === 0)).toHaveLength(2);
  const captureTask = observed.tasks.find(row => row.kind === 'capture' && row.article_id === mainId)!;
  const initialOutbox = observed.outbox.find(row => row.dedupe_key === `start:${captureTask.id}:a1`)!;
  await until('capture Queue receipt', async () => (await state()).outbox.find(row => row.id === initialOutbox.id && row.receipt_state === 'processed'));
  const callsBeforeDuplicate = (await state()).calls.length;
  await control('ingestion-duplicate', { outboxId: initialOutbox.id });
  observed = await until('duplicate delivered to actual consumer', async () => {
    const s = await state();
    return s.outbox.find(row => row.id === initialOutbox.id && row.receipt_attempts >= 2) ? s : null;
  });
  expect(observed.calls).toHaveLength(callsBeforeDuplicate);
  expect(observed.tasks.filter(row => row.kind === 'capture')).toHaveLength(2);
  expect(observed.attempts.filter(row => row.task_id === captureTask.id)).toHaveLength(1);
  expect(observed.events).toHaveLength(2);
  await mark('live pagination, canonical URL across columns and duplicate delivery without recollection');

  await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
  await screen.getByLabel('邮箱').fill(credentials.user('owner').username);
  await browser.locator('#password').fill(credentials.user('owner').password);
  await screen.getByRole('button', '登录', { exact: true }).click();
  await expect(browser).toHaveURL(/\/subscriptions$/);
  const first = await reader(browser, `/api/articles/${mainId}`);
  expect(first.revision.id).toBe(firstRevision);
  expect(first.article.bodyText).toBe('采集验收第一版完整正文');
  expect((await download(browser, first.attachments[0].downloadUrl)).sha256).toBe(observed.expected.ordinaryPdfHash);
  await app.open('/?q=第一版完整正文');
  await expect(screen.getByRole('link', '采集验收通知1001', { exact: true })).toBeVisible();
  await screen.getByRole('link', '采集验收通知1001', { exact: true }).click();
  await expect(screen.getByRole('heading', '采集验收通知1001', { exact: true })).toBeVisible();
  await expect(screen.getByText('采集验收第一版完整正文', { exact: true })).toBeVisible();
  await mark('actual Auth reader finds ingestion output and downloads original R2 bytes');

  // Same saved request identity must reuse a task, rather than making another paid request.
  await control('ingestion-mode', { mode: 'failure' });
  const failed = await ok('/internal/capture-tasks', 'POST', { articleId: mainId, requestId: 'feed03-upstream-recovery' }, 202);
  await waitTask(failed.task.id, 'failed');
  let diagnostics = await ok('/internal/operations/diagnostics');
  expect(diagnostics.tasks.some((row: Row) => row.taskId === failed.task.id && row.kind === 'workflow_failure')).toBe(true);
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(firstRevision);
  const failedCalls = (await state()).calls.length;
  const replayTask = await ok('/internal/capture-tasks', 'POST', { articleId: mainId, requestId: 'feed03-upstream-recovery' }, 202);
  expect(replayTask.duplicate).toBe(true);
  expect(replayTask.task.id).toBe(failed.task.id);
  expect((await state()).calls).toHaveLength(failedCalls);
  await control('ingestion-mode', { mode: 'baseline' });
  await until('failed native Workflow is terminal and recoverable', async () => {
    const result = await ok(`/internal/operations/tasks/${failed.task.id}/recover`, 'POST', {}, 202);
    return result.recovered === 1 ? result : null;
  });
  const recovered = await waitTask(failed.task.id, 'succeeded');
  expect(recovered.task.attemptNo).toBe(2);
  expect(recovered.attempt.workflowInstanceId).toBe(`task-${failed.task.id}-a2`);
  expect((await state()).events).toHaveLength(2);
  await mark('upstream failure, task idempotency, visible error and native terminal-attempt recovery');

  await control('ingestion-mode', { mode: 'missing' });
  const missing = await capture(mainId, 'feed03-missing-file');
  observed = await state();
  const missingRevision = observed.revisions.find(row => row.id === resultFor(observed, missing).revisionId)!;
  expect(missingRevision.state).toBe('blocked');
  expect(observed.events).toHaveLength(2);
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(firstRevision);
  const incomplete = await reader(browser, `/api/articles/${mainId}/revisions/${missingRevision.id}`);
  expect(incomplete.article.bodyText).toBe('');
  expect(incomplete.attachments[0].downloadUrl).toBeNull();
  expect(incomplete.article.snapshotUrl).toBeNull();
  diagnostics = await ok('/internal/operations/diagnostics');
  expect(diagnostics.requirements.some((row: Row) => row.revisionId === missingRevision.id && row.requirementKind === 'attachment' && row.state === 'failed')).toBe(true);
  await mark('missing attachment prevents publication and leaves old revision readable');

  await control('ingestion-mode', { mode: 'ocr', holdOcr: true });
  const ocrCapture = await capture(mainId, 'feed03-ocr-pending');
  observed = await until('real OCR vendor request waiting', async () => {
    const s = await state(); return s.calls.some(row => row.provider === 'textin') ? s : null;
  });
  const secondRevision = resultFor(observed, ocrCapture).revisionId;
  expect(observed.revisions.find(row => row.id === secondRevision)!.state).toBe('assembling');
  expect(observed.requirements.find(row => row.revision_id === secondRevision && row.kind === 'body_ocr')!.state).toBe('pending');
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(firstRevision);
  expect(observed.events).toHaveLength(2);
  await until('initial readiness Queue delivery acknowledged while OCR is pending', async () => (await state()).outbox.find(row => row.dedupe_key === `ready:${secondRevision}:1` && row.receipt_state === 'processed'));
  await control('ingestion-hide-snapshot', { revisionId: secondRevision });
  await control('ingestion-release-ocr');
  observed = await until('native Queue forwards failed readiness message to DLQ', async () => {
    const s = await state(); return s.dlq.length ? s : null;
  });
  const dead = JSON.parse(observed.dlq[0].message_json);
  expect(dead.type).toBe('check-ready');
  expect(dead.revisionId).toBe(secondRevision);
  expect(observed.outbox.find(row => row.id === dead.outboxId)!.receipt_state).toBe('failed');
  expect(observed.revisions.find(row => row.id === secondRevision)!.state).toBe('assembling');
  expect(observed.events).toHaveLength(2);
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(firstRevision);
  const tooSoon = await admin('/internal/operations/replay', 'POST', { outboxId: dead.outboxId, topic: 'feed-events' });
  expect(tooSoon.status).toBe(409);
  expect(tooSoon.body.error).toContain('retry window');
  await control('ingestion-restore-snapshot');
  await until('actual product dead-letter wait window', async () => {
    const result = await ok('/internal/operations/diagnostics');
    return result.queues.find((row: Row) => row.topic === 'feed-events').deadLetters.some((row: Row) => row.outboxId === dead.outboxId) ? result : null;
  }, 90000);
  await ok('/internal/operations/replay', 'POST', { outboxId: dead.outboxId, topic: 'feed-events' }, 202);
  observed = await until('replayed readiness publishes complete second revision', async () => {
    const s = await state(); return s.articles.find(row => row.id === mainId)!.latest_ready_revision_id === secondRevision ? s : null;
  });
  await until('replayed event processed receipt', async () => (await state()).outbox.find(row => row.id === dead.outboxId && row.receipt_state === 'processed'));
  expect((await admin('/internal/operations/replay', 'POST', { outboxId: dead.outboxId, topic: 'feed-events' })).status).toBe(409);
  expect(observed.events.filter(row => row.article_id === mainId && row.kind === 'update')).toHaveLength(1);
  const complete = await reader(browser, `/api/articles/${mainId}`);
  expect(complete.revision.id).toBe(secondRevision);
  expect(complete.article.bodyText).toContain('采集验收第二版完整正文');
  expect(complete.article.bodyText).toContain('独立扫描正文可检索');
  expect((await download(browser, complete.attachments[0].downloadUrl)).sha256).toBe(observed.expected.ocrPdfHash);
  expect((await reader(browser, complete.article.snapshotUrl, false))).toContain('采集验收第二版完整正文');
  expect((await reader(browser, first.article.snapshotUrl, false))).toContain('采集验收第一版完整正文');
  expect((await download(browser, first.attachments[0].downloadUrl)).sha256).toBe(observed.expected.ordinaryPdfHash);
  await app.open('/?q=独立扫描正文可检索');
  await expect(screen.getByRole('link', '采集验收通知1001', { exact: true })).toBeVisible();
  await screen.getByRole('link', '采集验收通知1001', { exact: true }).click();
  await screen.getByRole('button', '正文', { exact: true }).click();
  await expect(screen.getByText(/独立扫描正文可检索/)).toBeVisible();
  await mark('OCR pending gate, native DLQ, real wait window, authenticated same-version bytes and replay');

  const ocrCount = observed.calls.filter(row => row.provider === 'textin').length;
  const ocrTask = observed.tasks.find(row => row.kind === 'ocr')!;
  const ocrOutbox = observed.outbox.find(row => row.dedupe_key === `start:${ocrTask.id}:a1`)!;
  await control('ingestion-duplicate', { outboxId: ocrOutbox.id });
  await until('duplicate OCR launch consumed', async () => (await state()).outbox.find(row => row.id === ocrOutbox.id && row.receipt_attempts >= 2));
  const beforeRepeat = await state();
  await capture(mainId, 'feed03-repeat-complete');
  observed = await state();
  expect(observed.calls.filter(row => row.provider === 'textin')).toHaveLength(ocrCount);
  expect(observed.revisions).toHaveLength(beforeRepeat.revisions.length);
  expect(observed.events).toHaveLength(beforeRepeat.events.length);
  const redo = await ok(`/internal/articles/${mainId}/pdf-ocr`, 'POST', { model: 'textin-xparse-auto', publish: true }, 202);
  expect(redo.projectionUpdates).toBe(1);
  expect((await state()).calls.filter(row => row.provider === 'textin')).toHaveLength(ocrCount);
  expect(observed.ocrCalls).toHaveLength(1);
  expect(observed.ocrCalls[0].attempts).toBe(1);
  expect(observed.objects.some(row => row.key.endsWith('.request.json'))).toBe(true);
  expect(observed.objects.some(row => row.key.endsWith('.raw.json'))).toBe(true);
  await mark('OCR duplicate/capture replay reuse immutable provider receipts without repeated billing');

  // A new capture with the same semantic content and changed markup is retained
  // as presentation-only. Recheck's only injected fact is an elapsed deadline.
  await control('ingestion-mode', { mode: 'layout' });
  // Establish baseline content, then change only its markup for the recheck.
  const layoutBaseline = await capture(mainId, 'feed03-baseline-before-layout');
  const beforeLayout = await until('baseline before markup-only recheck ready', async () => {
    const s = await state(); return s.revisions.find(row => row.id === resultFor(s, layoutBaseline).revisionId)?.state === 'ready' ? s : null;
  });
  await control('ingestion-mode', { mode: 'baseline' });
  await control('ingestion-recheck-due', { articleId: mainId });
  const rechecked = await ok('/internal/rechecks', 'POST', { limit: 20 }, 202);
  expect(rechecked.scheduled).toHaveLength(1);
  await waitTask(rechecked.scheduled[0], 'succeeded');
  observed = await until('presentation-only recheck ready', async () => {
    const s = await state(); const r = s.revisions.find(row => row.id === resultFor(s, rechecked.scheduled[0]).revisionId);
    return r?.state === 'ready' ? s : null;
  });
  expect(resultFor(observed, rechecked.scheduled[0]).revisionId).not.toBe(beforeLayout.articles.find(row => row.id === mainId)!.latest_ready_revision_id);
  expect(observed.revisions.find(row => row.id === resultFor(observed, rechecked.scheduled[0]).revisionId)!.change_kind).toBe('presentation_only');
  expect(observed.events).toHaveLength(beforeLayout.events.length);
  await mark('existing recheck entry point retains presentation-only revision without content event');

  const beforeHistoryEvents = observed.events.filter(row => row.history_only === 0).length;
  const backfill = await ok(`/internal/sources/${sourceIds[0]}/backfill`, 'POST', { requestId: 'feed03-history-backfill', windowDays: 30 }, 202);
  expect(backfill.task.id).toBeDefined();
  await until('backfill pagination completed', async () => (await ok(`/internal/sources/${sourceIds[0]}`)).source.backfill.state === 'completed');
  observed = await until('historical notification ready', async () => {
    const s = await state(); const article = s.articles.find(row => row.url.endsWith('/1003.htm'));
    return article?.latest_ready_revision_id ? s : null;
  });
  const history = observed.articles.find(row => row.url.endsWith('/1003.htm'))!;
  expect(observed.events.find(row => row.article_id === history.id)!.history_only).toBe(1);
  expect(observed.events.filter(row => row.history_only === 0)).toHaveLength(beforeHistoryEvents);
  expect((await reader(browser, `/api/articles/${history.id}`)).article.bodyText).toBe('采集验收通知1003独立分页正文');
  await mark('backfill uses native discovery/capture and creates history-only event');

  const beforeInvalid = await reader(browser, `/api/articles/${mainId}`);
  const eventsBeforeInvalid = observed.events.length;
  await control('ingestion-mode', { mode: 'ocr-invalid' });
  const invalidCapture = await capture(mainId, 'feed03-paid-unknown-response');
  observed = await until('malformed OCR response blocks automatic recharge', async () => {
    const s = await state(); return s.tasks.find(row => row.kind === 'ocr' && row.state === 'blocked') ? s : null;
  });
  const blockedOcr = observed.tasks.find(row => row.kind === 'ocr' && row.state === 'blocked')!;
  expect(blockedOcr.last_error).toContain('review required');
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(beforeInvalid.revision.id);
  const paidAttempts = observed.calls.filter(row => row.provider === 'textin').length;
  await capture(mainId, 'feed03-repeat-uncertain-ocr');
  await control('ingestion-duplicate', { outboxId: observed.outbox.find(row => row.dedupe_key === `start:${blockedOcr.id}:a1`)!.id });
  await until('blocked OCR duplicate processed', async () => (await state()).outbox.find(row => row.dedupe_key === `start:${blockedOcr.id}:a1` && row.receipt_attempts >= 2));
  observed = await state();
  expect(observed.calls.filter(row => row.provider === 'textin')).toHaveLength(paidAttempts);
  expect(observed.events.some(row => row.revision_id === resultFor(observed, invalidCapture).revisionId)).toBe(false);
  expect(observed.events).toHaveLength(eventsBeforeInvalid);
  expect((await reader(browser, `/api/articles/${mainId}`)).revision.id).toBe(beforeInvalid.revision.id);
  expect(observed.tasks.filter(row => row.id === blockedOcr.id)).toHaveLength(1);
  expect(observed.attempts.every(row => row.workflow_instance_id === `task-${row.task_id}-a${row.attempt_no}` && row.handed_off_at !== null)).toBe(true);
  await mark('uncertain paid OCR response retains receipt, blocks recharge and never publishes incomplete observation');
});

async function saveCheckpoints() { await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'ingestion-checkpoints.json'), JSON.stringify({ checkpoints, operations, unexpected }, null, 2)); }
async function mark(name: string) { checkpoints.push(name); await saveCheckpoints(); }
async function control(action: string, input: Row = {}): Promise<any> {
  const r = await fetch(`${process.env.FEED_E2E_CONTROL_URL}/control`, { method: 'POST', headers: { authorization: `Bearer ${process.env.FEED_E2E_CONTROL_SECRET}` }, body: JSON.stringify({ action, ...input }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Control ${action}: ${r.status} ${text}`);
  return JSON.parse(text);
}
async function state(): Promise<State> { return control('ingestion-state'); }
async function until<T>(label: string, read: () => Promise<T>, timeout = 45000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do { const result = await read(); if (result) return result as NonNullable<T>; await new Promise(done => setTimeout(done, 300)); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
async function admin(path: string, method = 'GET', body?: Row, token = process.env.FEED_E2E_ADMIN_TOKEN!): Promise<{ status: number; body: any }> {
  return new Promise((done, fail) => {
    const request = httpsRequest(new URL(path, process.env.FEED_E2E_APP_URL), { method, rejectUnauthorized: false, agent: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        try {
          if (method !== 'GET' || response.statusCode !== 200) operations.push({ method, path, status: response.statusCode! });
          done({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { fail(error); }
      }); response.once('error', fail);
    });
    request.setTimeout(15000, () => request.destroy(new Error(`Admin timeout ${path}`)));
    request.once('error', fail); request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function ok(path: string, method = 'GET', body?: Row, status = 200): Promise<any> {
  const r = await admin(path, method, body); if (r.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r.body;
}
async function waitTask(id: string, expected: string) {
  return until(`task ${id} ${expected}`, async () => { const r = await ok(`/internal/capture-tasks/${id}`); return r.task.state === expected ? r : null; });
}
async function capture(articleId: string, requestId: string): Promise<string> {
  const r = await ok('/internal/capture-tasks', 'POST', { articleId, requestId }, 202); await waitTask(r.task.id, 'succeeded'); return r.task.id;
}
function resultFor(s: State, taskId: string): Row { return JSON.parse(s.attempts.filter(row => row.task_id === taskId).at(-1)!.result_json); }
async function reader(browser: Browser, path: string, json = true): Promise<any> {
  const value = await browser.evaluate(async (input: { path: string }) => {
    const r = await fetch(input.path); return JSON.stringify({ status: r.status, body: await r.text() });
  }, { path });
  const r = JSON.parse(value); expect(r.status).toBe(200); return json ? JSON.parse(r.body) : r.body;
}
async function download(browser: Browser, path: string): Promise<{ status: number; sha256: string }> {
  const value = await browser.evaluate(async (input: { path: string }) => {
    const r = await fetch(input.path); const digest = await crypto.subtle.digest('SHA-256', await r.arrayBuffer());
    return JSON.stringify({ status: r.status, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') });
  }, { path });
  const r = JSON.parse(value); expect(r.status).toBe(200); return r;
}
