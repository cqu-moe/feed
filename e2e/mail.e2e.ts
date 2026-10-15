import { beforeEach, afterEach, test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { request as httpsRequest } from 'node:https';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiFetch, control, login } from './support';

type Row = Record<string, any>;
let unexpected: string[];
const checkpoints: string[] = [];
const operations: Row[] = [];
let generation = 0;
beforeEach(async ({ browser }) => {
  unexpected = []; checkpoints.length = 0; operations.length = 0; generation = 0;
  const allowed = [process.env.FEED_E2E_APP_URL!, process.env.FEED_E2E_AUTH_URL!].map(url => new URL(url).origin);
  await browser.route('**/*', async route => {
    if (!allowed.includes(new URL(route.request.url).origin)) { unexpected.push(new URL(route.request.url).origin); await route.abort(); }
    else await route.continue();
  });
});
afterEach(async () => { await mark(); expect(unexpected).toEqual([]); });

test('FEED04 real mail Queue, signed callbacks, policy and unknown recovery', async ({ app, browser, screen }) => {
  await app.open('/subscriptions');
  await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();
  if (process.env.FEED_E2E_BREAK_ASSERTION === '1') await expect(screen.getByRole('heading', '故意错误的邮件成功断言')).toBeVisible();
  const empty = await ingestion();
  for (const table of ['articles', 'tasks', 'revisions', 'events', 'objects']) expect(empty[table]).toEqual([]);
  const noMail = await state();
  for (const table of ['mail_messages', 'mail_items', 'mail_webhook_receipts', 'user_deliveries', 'accepted']) expect(noMail[table]).toEqual([]);
  expect((await admin('/internal/mail', 'GET', undefined, '')).status).toBe(401);
  expect((await admin('/internal/mail/recover', 'POST', {}, 'invalid-token')).status).toBe(401);
  await mark('empty business state and actual administrator denial');

  const school = 'https://school.example.test';
  const site = (await ok('/internal/sites', 'POST', { name: '邮件验收学校', origin: school, requestId: 'feed04-site-create' }, 201)).site;
  const sources: string[] = [];
  for (const lane of ['a', 'b']) {
    const source = (await ok('/internal/sources', 'POST', { siteId: site.id, name: `邮件栏目${lane}`, listUrl: `${school}/lists/${lane}`,
      articlePattern: '^/info/2026/\\d+\\.htm$', sampleArticleUrl: `${school}/info/2026/1001.htm`, refreshIntervalSec: 86400, timezone: 'Asia/Shanghai' }, 201)).source;
    sources.push(source.id);
    const task = (await ok(`/internal/sources/${source.id}/verify`, 'POST', { requestId: `feed04-verify-${lane}` }, 202)).task;
    await until('real validation Workflow', async () => (await ok(`/internal/capture-tasks/${task.id}`)).task.state === 'succeeded');
    await ok(`/internal/sources/${source.id}`, 'PATCH', { enabled: true });
  }
  await login(app, screen, browser, 'OWNER');
  await screen.getByLabel('订阅名称').fill('邮件主订阅');
  await screen.getByRole('checkbox', '邮件栏目a', { exact: true }).click();
  await screen.getByRole('checkbox', '邮件栏目b', { exact: true }).click();
  await screen.getByRole('combobox', '邮件模式', { exact: true }).click();
  await screen.getByRole('option', '及时提醒', { exact: true }).click();
  await screen.getByRole('button', '创建订阅').click();
  await expect(screen.getByRole('article', '订阅：邮件主订阅')).toBeVisible();
  const second = await apiFetch<Row>(browser, '/api/subscriptions', { method: 'POST', body: {
    requestId: 'feed04-second-subscription', name: '重复命中订阅', sourceIds: sources, emailMode: 'immediate',
  } });
  expect(second.status).toBe(201);
  expect((await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID })).length).toBe(2);
  await control('mail-hold', { enabled: true });
  await ok('/internal/sources/schedule', 'POST', {}, 202);
  await until('two ready articles and prepared mail from native Workflows/matching', async () => {
    await pump(); const s = await state(); return s.mail_messages.length === 2 && s.mail_messages.every((r: Row) => r.state === 'prepared');
  });
  let s = await state(), ing = await ingestion();
  expect(s.calls).toHaveLength(0);
  expect(s.user_deliveries).toHaveLength(2);
  for (const event of ing.events) expect(s.user_deliveries.filter((r: Row) => r.event_id === event.id)).toHaveLength(1);
  expect(s.notification_matches.filter((r: Row) => ['new', 'update'].includes(r.eligibility_kind)).length).toBeGreaterThanOrEqual(4);
  expect(ing.attempts.every((r: Row) => r.workflow_instance_id === `task-${r.task_id}-a${r.attempt_no}` && r.handed_off_at !== null)).toBe(true);
  const mainId = ing.articles.find((r: Row) => r.url.endsWith('/1001.htm')).id;
  const initialRevision = ing.articles.find((r: Row) => r.id === mainId).latest_ready_revision_id;
  await control('mail-hold', { enabled: false });
  await until('native mail Queue provider acceptance', async () => { await pump(); return (await state()).mail_messages.every((r: Row) => r.state === 'accepted'); });
  s = await state();
  expect(s.accepted).toHaveLength(2);
  for (const message of s.mail_messages) {
    expect(message.delivered_at).toBeNull();
    const snapshot = s.snapshots.find((r: Row) => r.messageId === message.id);
    expect(snapshot.sha256).toBe(message.payload_hash);
    const item = s.mail_items.find((r: Row) => r.message_id === message.id);
    const event = ing.events.find((r: Row) => r.id === item.event_id);
    const link = `${process.env.FEED_E2E_APP_URL}/articles/${event.article_id}?revision=${event.revision_id}`;
    expect(snapshot.payload.text).toContain(link);
    expect(snapshot.payload.html).toContain(link);
    expect(snapshot.payload.subject).toContain('新通知');
    const read = await apiFetch<Row>(browser, `/api/articles/${event.article_id}/revisions/${event.revision_id}`);
    expect(read.status).toBe(200); expect(read.body.revision.id).toBe(event.revision_id);
    expect(read.body.article.bodyText.length).toBeGreaterThan(5);
  }
  if (process.env.FEED_E2E_MAIL_WRONG_ORACLE === '1') expect(s.mail_messages[0].state).toBe('delivered');
  const first = s.mail_messages[0], key = first.idempotency_key;
  const outbox = (await ingestion()).outbox.find((r: Row) => r.topic === 'feed-mail' && JSON.parse(r.payload_json).messageId === first.id);
  const count = posts(s).length;
  await control('mail-duplicate', { outboxId: outbox.id });
  await until('native duplicate receipt', async () => (await ingestion()).outbox.some((r: Row) => r.id === outbox.id && r.receipt_attempts >= 2));
  expect(posts(await state())).toHaveLength(count);
  for (const invalid of [{ invalid: true }, { stale: true }]) {
    expect((await control('mail-callback', { key, type: 'delivered', ...invalid })).status).toBe(401);
  }
  expect((await state()).mail_webhook_receipts).toHaveLength(0);
  expect((await control('mail-callback', { key, type: 'delivered', recipient: 'wrong@example.test', receiptId: 'wrong-recipient' })).status).toBe(200);
  expect((await state()).mail_webhook_receipts[0].state).toBe('ignored');
  expect((await message(first.id)).state).toBe('accepted');
  await receipt(key, 'delivered', 'first-delivered');
  const receipts = (await state()).mail_webhook_receipts.length;
  await receipt(key, 'delivered', 'first-delivered');
  expect((await state()).mail_webhook_receipts).toHaveLength(receipts);
  await receipt(key, 'sent', 'late-sent');
  expect((await message(first.id)).state).toBe('delivered');
  for (const item of s.mail_messages.filter((r: Row) => r.id !== first.id)) await receipt(item.idempotency_key, 'delivered');
  await mark('readable immutable R2 mail, real reader versions, owner/event dedup, native duplicate and authenticated callback ordering');

  // Historical backfill creates genuine archived events, never mail candidates.
  await ok(`/internal/sources/${sources[0]}/backfill`, 'POST', { requestId: 'feed04-history-run', windowDays: 30 }, 202);
  await until('history archived via Workflow', async () => { await pump(); return (await ingestion()).events.some((r: Row) => r.history_only === 1); });
  ing = await ingestion(); s = await state();
  for (const historical of ing.events.filter((r: Row) => r.history_only === 1)) expect(s.user_deliveries.some((r: Row) => r.event_id === historical.id)).toBe(false);
  expect(posts(s)).toHaveLength(count);
  await mark('real historical backfill is archived without a mail delivery');

  // Change facts after preparation, before the actual consumer calls the provider.
  const owner = process.env.FEED_E2E_OWNER_ID;
  for (const fault of ['access', 'quota', 'verification', 'address', 'rpc', 'pause']) {
    await control('mail-hold', { enabled: true });
    const prepared = await prepareUpdate(mainId);
    const before = posts(await state()).length;
    if (fault === 'access' || fault === 'quota') await control('set-entitlements', { userId: owner, access: fault !== 'access', limit: fault === 'quota' ? 0 : 3 });
    if (fault === 'verification') await control('mail-recipient', { userId: owner, verified: false });
    if (fault === 'address') await control('mail-recipient', { userId: owner, email: 'changed-recipient@example.test' });
    if (fault === 'rpc') await control('mail-rpc-credentials', { enabled: false });
    if (fault === 'pause') await updateSubscriptions(browser, { requestedEnabled: false });
    await control('mail-hold', { enabled: false });
    await until(`preflight ${fault} blocks submission`, async () => { await pump(); return ['cancelled', 'deferred'].includes((await message(prepared.id)).state); });
    const blocked = await message(prepared.id);
    expect(blocked.submitted_at).toBeNull(); expect(blocked.attempts).toBe(0);
    expect(posts(await state())).toHaveLength(before);
    const expected: Row = { access: 'access_revoked', quota: 'quota_exceeded', verification: 'email_unverified', address: 'recipient_changed', rpc: 'auth_unavailable', pause: 'paused' };
    expect(blocked.last_error).toBe(expected[fault]);
    if (fault === 'access' || fault === 'quota') await control('set-entitlements', { userId: owner, access: true, limit: 3 });
    if (fault === 'verification' || fault === 'address') await control('mail-recipient', { userId: owner, email: process.env.FEED_E2E_OWNER_EMAIL, verified: true });
    if (fault === 'rpc') await control('mail-rpc-credentials', { enabled: true });
    if (fault === 'pause') await updateSubscriptions(browser, { requestedEnabled: true });
    await mark(`fresh ${fault} preflight prevents external submission`);
  }
  // Actual Auth bundle remains the binding target; its outage deployment lacks DB.
  await control('set-rpc-outage', { enabled: true });
  const beforeOutage = posts(await state()).length;
  await captureUpdate(mainId); await recover();
  expect(posts(await state())).toHaveLength(beforeOutage);
  expect((await state()).user_deliveries.some((r: Row) => r.suppression_reason === 'auth_unavailable' && r.state === 'pending')).toBe(true);
  expect((await ok('/internal/operations/diagnostics')).metrics.authUnavailable).toBeGreaterThanOrEqual(1);
  await control('set-rpc-outage', { enabled: false });
  await mark('real Auth binding outage retains backlog without external mail');

  await control('mail-mode', { mode: 'lost-response' });
  await captureUpdate(mainId); await recover();
  const retryUnknown = await until('immediate request accepted but response stream lost', async () => {
    await pump(); return (await state()).mail_messages.find((r: Row) => r.kind === 'immediate' && r.state === 'submission_unknown');
  });
  expect(retryUnknown.provider_id).toBeNull();
  const diagnostic = await ok('/internal/operations/diagnostics');
  expect(diagnostic.metrics.mailUnknown).toBeGreaterThanOrEqual(1);
  const unknownAttempts = posts(await state(), retryUnknown.idempotency_key).length;
  await recover(); await pump(); expect(posts(await state(), retryUnknown.idempotency_key)).toHaveLength(unknownAttempts);
  await control('mail-mode', { mode: 'accepted' });
  await control('mail-clock', { advanceMs: 61000 }); await recover();
  await until('unknown retry retains provider identity/key', async () => { await pump(); return (await message(retryUnknown.id)).state === 'accepted'; });
  const retryState = await state();
  expect(posts(retryState, retryUnknown.idempotency_key)).toHaveLength(unknownAttempts + 1);
  expect(posts(retryState, retryUnknown.idempotency_key)[0].payload).toEqual(posts(retryState, retryUnknown.idempotency_key)[1].payload);
  expect(retryState.accepted.filter((r: Row) => r.key === retryUnknown.idempotency_key)).toHaveLength(1);
  await receipt(retryUnknown.idempotency_key, 'delivered');
  await mark('actual lost response stream creates diagnosable unknown; bounded retry reuses immutable key without another provider acceptance');

  // The browser sees actual delivery projections and subscription modes before clock travel.
  await updateSubscriptions(browser, { emailMode: 'daily_digest' });
  await app.open(`/articles/${mainId}?revision=${initialRevision}`);
  await expect(screen.getByRole('heading', '采集验收通知1001', { exact: true })).toBeVisible();
  const old = await apiFetch<Row>(browser, `/api/articles/${mainId}/revisions/${initialRevision}`);
  expect(old.body.revision.id).toBe(initialRevision);
  expect(old.body.article.bodyText).toContain('采集验收第一版完整正文');
  await mark('subscription changes and original email revision remain readable after newer captures');

  await control('mail-mode', { mode: 'rate-limit' });
  await control('mail-clock', { advanceMs: 86400000 });
  await recover();
  const digest = await until('controlled-clock digest gets 429 from real Queue submission', async () => {
    await pump(); return (await state()).mail_messages.find((r: Row) => r.kind === 'daily_digest' && r.state === 'deferred');
  });
  expect(digest.submitted_at).toBeNull(); expect(digest.attempts).toBe(1);
  expect(digest.last_error).toBe('rate_limit_exceeded');
  s = await state();
  const digestCalls = posts(s, digest.idempotency_key).length;
  const snapshot = s.snapshots.find((r: Row) => r.messageId === digest.id);
  expect(snapshot.payload.subject).toContain('每日摘要');
  const members = s.mail_items.filter((r: Row) => r.message_id === digest.id);
  expect(members.length).toBeGreaterThanOrEqual(3);
  for (const item of members) {
    const event = (await ingestion()).events.find((r: Row) => r.id === item.event_id);
    expect(event.history_only).toBe(0);
    expect(snapshot.payload.text).toContain(`?revision=${event.revision_id}`);
  }
  await recover(); await pump(); expect(posts(await state(), digest.idempotency_key)).toHaveLength(digestCalls);
  await control('mail-mode', { mode: 'accepted' });
  await control('mail-clock', { advanceMs: 61000 }); await recover();
  await until('429 retry uses same payload/key', async () => { await pump(); return (await message(digest.id)).state === 'accepted'; });
  s = await state();
  expect(posts(s, digest.idempotency_key)).toHaveLength(2);
  expect(posts(s, digest.idempotency_key)[0].payload).toEqual(posts(s, digest.idempotency_key)[1].payload);
  expect(s.accepted.filter((r: Row) => r.key === digest.idempotency_key)).toHaveLength(1);
  await receipt(digest.idempotency_key, 'delivered');
  await mark('controlled daily window, immutable digest membership and deadline-respecting idempotent 429 recovery');

  // New updates now match daily mode; build the next window without seeding state.
  await captureUpdate(mainId);
  await control('mail-clock', { advanceMs: 86400000 });
  await control('mail-mode', { mode: 'lost-response' }); await recover();
  const unknown = await until('accepted external request with lost reply stays unknown', async () => {
    await pump(); return (await state()).mail_messages.find((r: Row) => r.state === 'submission_unknown');
  });
  expect(unknown.provider_id).toBeNull(); expect(unknown.delivered_at).toBeNull();
  expect((await ok(`/internal/mail/${unknown.id}/reconcile`, 'POST', {})).reason).toBe('provider_identity_required');
  const unknownCount = posts(await state(), unknown.idempotency_key).length;
  await recover(); await pump(); expect(posts(await state(), unknown.idempotency_key)).toHaveLength(unknownCount);
  await control('set-entitlements', { userId: owner, access: false, limit: 3 });
  await control('mail-clock', { advanceMs: 26 * 3600000 }); await recover(); await pump();
  expect(posts(await state(), unknown.idempotency_key)).toHaveLength(unknownCount);
  expect((await message(unknown.id)).last_error).toBe('reconciliation_required');
  expect((await message(unknown.id)).next_attempt_at).toBeNull();
  expect((await ok('/internal/mail')).messages.find((r: Row) => r.id === unknown.id).state).toBe('submission_unknown');
  await control('set-entitlements', { userId: owner, access: true, limit: 3 });
  await receipt(unknown.idempotency_key, 'sent');
  await control('mail-provider-event', { key: unknown.idempotency_key, event: 'delivered' });
  expect((await ok(`/internal/mail/${unknown.id}/reconcile`, 'POST', {})).state).toBe('delivered');
  const recoveredProvider = (await message(unknown.id)).provider_id;
  expect((await state()).calls.some((r: Row) => r.method === 'GET' && r.path === `/emails/${recoveredProvider}`)).toBe(true);
  expect(posts(await state(), unknown.idempotency_key)).toHaveLength(unknownCount);
  await mark('unknown submission stops blind retries after policy/window change, signed identity plus actual provider lookup recovers');

  await captureUpdate(mainId); await control('mail-clock', { advanceMs: 86400000 });
  await control('mail-mode', { mode: 'callback-first' }); await recover();
  const early = await until('delivered callback arrives before send response', async () => {
    await pump(); return (await state()).mail_messages.find((r: Row) => r.id !== unknown.id && r.kind === 'daily_digest' && r.state === 'delivered' && r.created_at > unknown.created_at);
  });
  expect(early.delivered_at).not.toBeNull(); expect(early.attempts).toBe(1);
  await receipt(early.idempotency_key, 'sent', 'early-late-sent');
  expect((await message(early.id)).state).toBe('delivered');
  await receipt(early.idempotency_key, 'bounced', 'verified-bounce');
  await receipt(early.idempotency_key, 'delivered', 'late-delivered-after-bounce');
  expect((await message(early.id)).state).toBe('bounced');
  expect((await state()).mail_suppressions).toHaveLength(1);
  const bounceCount = posts(await state()).length;
  await captureUpdate(mainId); await control('mail-clock', { advanceMs: 86400000 }); await recover(); await pump();
  expect(posts(await state())).toHaveLength(bounceCount);
  expect((await state()).user_deliveries.some((r: Row) => r.state === 'pending')).toBe(true);
  expect((await ok('/internal/mail')).messages.find((r: Row) => r.id === early.id).state).toBe('bounced');
  const final = await state(), finalIngestion = await ingestion();
  for (const item of final.mail_items) expect(finalIngestion.events.find((r: Row) => r.id === item.event_id).history_only).toBe(0);
  expect(new Set(final.user_deliveries.map((r: Row) => `${r.owner_sub}:${r.event_id}`)).size).toBe(final.user_deliveries.length);
  for (const accepted of final.accepted) expect(new Set(posts(final, accepted.key).map((r: Row) => JSON.stringify(r.payload))).size).toBe(1);
  await mark('callback-before-response never regresses; verified bounce suppresses later mail and delayed receipts cannot undo it');
});

function posts(s: Row, key?: string): Row[] { return s.calls.filter((r: Row) => r.method === 'POST' && (!key || r.key === key)); }
async function state(): Promise<Row> { return control('mail-state'); }
async function ingestion(): Promise<Row> { return control('ingestion-state'); }
async function message(id: string): Promise<Row> { const result = (await state()).mail_messages.find((r: Row) => r.id === id); if (!result) throw new Error('Missing real message'); return result; }
async function mark(name?: string) { if (name) checkpoints.push(name); await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'mail-checkpoints.json'), JSON.stringify({ checkpoints, operations, unexpected }, null, 2)); }
async function until<T>(label: string, read: () => Promise<T>, timeout = 45000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 250)); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
async function admin(path: string, method = 'GET', body?: Row, token = process.env.FEED_E2E_ADMIN_TOKEN!): Promise<{ status: number; body: any }> {
  return new Promise((done, fail) => {
    const request = httpsRequest(new URL(path, process.env.FEED_E2E_APP_URL), { method, rejectUnauthorized: false, agent: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', fail);
      response.once('end', () => { try { if (method !== 'GET' || response.statusCode !== 200) operations.push({ method, path, status: response.statusCode }); done({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { fail(error); } });
    });
    request.setTimeout(15000, () => request.destroy(new Error(`Admin timeout ${path}`))); request.once('error', fail); request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function ok(path: string, method = 'GET', body?: Row, status = 200): Promise<any> {
  const r = await admin(path, method, body); if (r.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r.body;
}
async function pump() { await ok('/internal/capture-tasks/recover', 'POST', {}); }
async function recover() { await ok('/internal/mail/recover', 'POST', {}, 202); await pump(); }
async function receipt(key: string, type: string, receiptId?: string) { expect((await control('mail-callback', { key, type, ...(receiptId ? { receiptId } : {}) })).status).toBe(200); }
async function captureUpdate(articleId: string) {
  generation++; await control('ingestion-content', { generation });
  const task = (await ok('/internal/capture-tasks', 'POST', { articleId, requestId: `feed04-content-${generation}` }, 202)).task;
  await until('new content captured in native Workflow', async () => { await pump(); return (await ok(`/internal/capture-tasks/${task.id}`)).task.state === 'succeeded'; });
  await until('new revision content event and matching complete', async () => { await pump(); const s = await ingestion(); return s.events.length >= generation + 3 && !s.tasks.some((r: Row) => r.kind === 'match-event' && r.state !== 'succeeded'); });
}
async function prepareUpdate(articleId: string): Promise<Row> {
  const before = (await state()).mail_messages.map((r: Row) => r.id);
  await captureUpdate(articleId);
  return until('new prepared mail', async () => { await pump(); return (await state()).mail_messages.find((r: Row) => !before.includes(r.id) && r.state === 'prepared'); });
}
async function updateSubscriptions(browser: Browser, changes: Row) {
  const response = await apiFetch<Row>(browser, '/api/subscriptions'); expect(response.status).toBe(200);
  for (const sub of response.body.subscriptions) {
    const result = await apiFetch<Row>(browser, `/api/subscriptions/${sub.id}`, { method: 'PATCH', body: {
      requestId: `feed04-edit-${sub.id}-${sub.version}`, expectedVersion: sub.version, name: sub.name,
      sourceIds: sub.targetSourceIds, emailMode: sub.emailMode, requestedEnabled: sub.requestedEnabled, priority: sub.priority, ...changes,
    } }); expect(result.status).toBe(200);
  }
}
