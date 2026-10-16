import { test } from '@e2e-dev/web';
import { credentials, expect, secrets, type JsonValue } from 'e2e';
import type { Subscription, SubscriptionList } from '../../../src/api';
import {
  AUTH, FEED, admissibleBaseline, baselineOnly, baselineUnchanged, cleanupCandidates,
  finalCleanupReadback, finishRun, journal, ownedRows, rssAddress, requireThat as check,
} from './state.mjs';

test('FEED05 isolated real OAuth and reversible subscription lifecycle', { trace: 'off', video: 'off' }, async ({ app, screen, browser }) => {
  check(process.env.FEED05_MODE === 'execute', 'LIVE_EXECUTION_NOT_ARMED');
  const run = process.env.FEED05_RUN_ID!;
  check(/^[a-z0-9-]{8,50}$/.test(run), 'RUN_ID_REQUIRED');
  const names = [`FEED05-${run}`, `FEED05-${run}-edited`];
  const owned = new Set<string>();
  let createDispatched = false, armed: string | null = null, actor: 'owner' | 'other' | null = null;
  let violations = 0;
  let baseline: SubscriptionList | undefined;
  let ownerBaseline: ReturnType<typeof admissibleBaseline> | undefined;
  let otherBaseline: ReturnType<typeof admissibleBaseline> | undefined;
  let primary: unknown;
  const cleanup: unknown[] = [];
  const completed: string[] = [];

  async function api<T>(path: string, method = 'GET', body?: JsonValue): Promise<{ status: number; body: T }> {
    check(new URL(await browser.url()).origin === FEED, 'FEED_PAGE_REQUIRED');
    const raw = await browser.evaluate(async input => {
      const r = await fetch(input.path, { method: input.method, credentials: 'same-origin',
        headers: input.body === null ? {} : { 'content-type': 'application/json' },
        body: input.body === null ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(20000) });
      return JSON.stringify({ status: r.status, body: await r.json() });
    }, { path, method, body: body ?? null });
    return JSON.parse(raw);
  }
  async function list() {
    const r = await api<SubscriptionList>('/api/subscriptions');
    check(r.status === 200 && Array.isArray(r.body.subscriptions), 'SUBSCRIPTIONS_READ');
    check(r.body.outputChannels.email.enabled === false, 'WORKER_MAIL_MUST_BE_OFF');
    return r.body;
  }
  const card = (name: string) => screen.getByRole('article', `订阅：${name}`);
  async function current() {
    const rows = ownedRows((await list()).subscriptions, ownerBaseline!.ids, names) as Subscription[];
    check(rows.length === 1 && owned.has(rows[0].id), 'ROUND_OWNERSHIP_REQUIRED');
    return rows[0];
  }
  async function change(step: string, action: () => Promise<unknown>, ready: (data: SubscriptionList) => boolean) {
    const before = await list();
    await journal({ phase: 'intent', step, actor, before, owned: [...owned] });
    armed = step;
    try {
      await action();
      const deadline = Date.now() + 15000;
      let after = await list();
      while (!ready(after) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250)); after = await list();
      }
      check(ready(after), 'MUTATION_READBACK');
      await journal({ phase: 'complete', step, after }); completed.push(step);
      return after;
    } finally { armed = null; }
  }
  async function rss(value: string | null) {
    return JSON.parse(await browser.evaluate(async url => {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
      const text = await r.text(); return JSON.stringify({ status: r.status, isRss: text.includes('<rss ') && text.includes('<channel>') });
    }, rssAddress(value))) as { status: number; isRss: boolean };
  }
  async function login(role: 'owner' | 'other') {
    await browser.goto(`${FEED}/login`);
    const prior = await api<{ authenticated: boolean }>('/api/session');
    await journal({ phase: 'intent', step: `login-${role}`, before: { actor, feedSessionStatus: prior.status, authenticated: prior.body.authenticated } });
    check(prior.status === 200 && prior.body.authenticated === false, 'FRESH_FEED_SESSION_REQUIRED');
    await app.open('/subscriptions');
    await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
    await expect(browser).toHaveURL(new RegExp(`^${AUTH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/login(?:[?#]|$)`));
    check(new URL(await browser.url()).origin === AUTH, 'AUTH_ORIGIN');
    await screen.getByLabel('邮箱', { exact: true }).fill(secrets.get(`${role}Email`));
    await browser.locator('#password').fill(credentials.user(role).password);
    await screen.getByRole('button', '登录', { exact: true }).click();
    await expect(browser).toHaveURL(`${FEED}/subscriptions`);
    actor = role; await journal({ phase: 'complete', step: `login-${role}` });
  }
  async function signout() {
    await journal({ phase: 'intent', step: 'signout', before: { actor } });
    const errors: unknown[] = [];
    try {
      await browser.goto(`${FEED}/login`);
      check((await api('/auth/logout', 'POST', {})).status === 200, 'FEED_SIGNOUT');
      check((await api('/api/subscriptions')).status === 401, 'FEED_SIGNOUT_READBACK');
    } catch (e) { errors.push(e); }
    try {
      await browser.goto(`${AUTH}/login`);
      const result = JSON.parse(await browser.evaluate(async () => {
        const out = await fetch('/api/v1/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
        const session = await fetch('/api/v1/auth/get-session', { signal: AbortSignal.timeout(20000) });
        return JSON.stringify({ status: out.status, empty: (await session.json()) === null });
      }));
      check(result.status === 200 && result.empty, 'AUTH_SIGNOUT_READBACK');
    } catch (e) { errors.push(e); }
    actor = null;
    try { await journal({ phase: 'complete', step: 'signout', errors: errors.length }); } catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors, 'SIGNOUT_FAILED');
  }
  await browser.route('**/*', async route => {
    const u = new URL(route.request.url);
    if (![FEED, AUTH].includes(u.origin)) { violations++; await route.abort(); return; }
    if (u.origin === FEED && u.pathname.startsWith('/api/subscriptions') && route.request.method !== 'GET') {
      const command = JSON.parse(route.request.postData || '{}');
      const id = /^\/api\/subscriptions\/([a-f0-9]{24})(?:\/|$)/.exec(u.pathname)?.[1];
      if (!armed || (command.emailMode !== undefined && command.emailMode !== 'off')
        || (id ? !owned.has(id) : u.pathname !== '/api/subscriptions' || command.name !== names[0] || command.emailMode !== 'off')) {
        violations++; await route.abort(); return;
      }
      await journal({ phase: 'dispatch-intent', step: armed, actor, path: u.pathname, method: route.request.method, command });
      if (!id) createDispatched = true;
    }
    await route.continue();
  });
  try {
    await login('owner');
    baseline = await list();
    ownerBaseline = admissibleBaseline(baseline);
    await journal({ phase: 'baseline', actor, before: baseline });
    check(ownerBaseline, 'OWNER_BASELINE_ADMISSIBLE');
    check(baseline.policy.status === 'available' && baseline.policy.access, 'FEED_ACCESS_REQUIRED');
    const source = baseline.sources.find(s => s.id === 'jwc');
    check(source, 'VERIFIED_JWC_SOURCE_REQUIRED');
    await change('create', async () => {
      await screen.getByLabel('订阅名称', { exact: true }).fill(names[0]);
      await screen.getByRole('checkbox', new RegExp(`^${source!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)).click();
      await screen.getByRole('combobox', '邮件模式', { exact: true }).click();
      await screen.getByRole('option', '不发送邮件', { exact: true }).click();
      await screen.getByRole('button', '创建订阅', { exact: true }).click();
    }, d => d.subscriptions.some(s => s.name === names[0] && s.emailMode === 'off'));
    const created = ownedRows((await list()).subscriptions, ownerBaseline.ids, names) as Subscription[];
    check(created.length === 1, 'SINGLE_ROUND_RESOURCE'); owned.add(created[0].id);
    await journal({ phase: 'owned', ids: [...owned] });
    await change('edit', async () => {
      const c = card(names[0]); await c.getByRole('button', '编辑订阅').click();
      await c.getByLabel('订阅名称').fill(names[1]); await c.getByRole('button', '保存修改').click();
    }, d => d.subscriptions.some(s => s.name === names[1]));
    await browser.reload(); await expect(card(names[1])).toBeVisible();
    check((await current()).name === names[1], 'RELOAD_READBACK');
    for (const [step, button, enabled] of [['pause', '暂停订阅', false], ['resume', '启用订阅', true]] as const) {
      await change(step, () => card(names[1]).getByRole('button', button).click(), d => d.subscriptions.find(s => owned.has(s.id))?.requestedEnabled === enabled);
    }
    const old = (await current()).rssUrl;
    const firstRss = await rss(old);
    check(firstRss.status === 200 && firstRss.isRss, 'RSS_READ');
    async function confirm(button: string) {
      await card(names[1]).getByRole('button', button).click();
      await card(names[1]).getByRole('button', '确认操作').click();
    }
    await change('rss-rotate', () => confirm('重置 RSS'), d => d.subscriptions.some(s => owned.has(s.id) && s.rssUrl !== old));
    const rotated = (await current()).rssUrl;
    check(rotated !== null && (await rss(old)).status === 404 && (await rss(rotated)).status === 200, 'ROTATION_READBACK');
    await change('rss-revoke', () => confirm('撤销 RSS'), d => d.subscriptions.some(s => owned.has(s.id) && s.rssStatus === 'rss_revoked' && s.rssUrl === null));
    check((await rss(rotated)).status === 404, 'REVOCATION_READBACK');
    const ownerBefore = await list();
    baselineUnchanged(ownerBefore, ownerBaseline);
    const ownerBeforeOther = await current();
    await signout(); await login('other');
    const other = await list(); await journal({ phase: 'baseline', actor, before: other });
    otherBaseline = admissibleBaseline(other);
    check(baselineOnly(other, otherBaseline), 'OTHER_BASELINE_ONLY');
    const id = ownerBeforeOther.id;
    check((await api(`/api/subscriptions/${id}`)).status === 404, 'CROSS_OWNER_READ');
    await change('cross-owner-delete', async () => {
      check((await api(`/api/subscriptions/${id}`, 'DELETE', { requestId: crypto.randomUUID(), expectedVersion: ownerBeforeOther.version })).status === 404, 'CROSS_OWNER_WRITE');
    }, d => baselineOnly(d, otherBaseline!));
    await signout(); await login('owner');
    check(JSON.stringify(await current()) === JSON.stringify(ownerBeforeOther), 'OWNER_UNCHANGED');
    await change('soft-delete', () => confirm('删除订阅'), d => d.subscriptions.some(s => owned.has(s.id) && s.deletedAt !== null));
    await change('restore', async () => {
      await card(names[1]).getByRole('button', '恢复订阅').click();
      await card(names[1]).getByRole('button', '确认恢复订阅').click();
    }, d => d.subscriptions.some(s => owned.has(s.id) && s.deletedAt === null && s.emailMode === 'off'));
    check((await rss((await current()).rssUrl)).status === 200, 'RESTORED_RSS');
  } catch (e) { primary = e; }
  finally {
    if (createDispatched && ownerBaseline) {
      try {
        if (actor !== 'owner') { await signout(); await login('owner'); }
        await browser.goto(`${FEED}/subscriptions`);
        const before = await list();
        // Claim an unknown create only by unique round name; first require every
        // exact baseline row unchanged and refuse every other concurrent row.
        for (const row of cleanupCandidates(before, ownerBaseline, names) as Subscription[]) owned.add(row.id);
        for (const row of ownedRows(before.subscriptions, ownerBaseline.ids, names) as Subscription[]) {
          if (row.deletedAt !== null) continue;
          await change('cleanup-soft-delete', async () => {
            const r = await api(`/api/subscriptions/${row.id}`, 'DELETE', { requestId: crypto.randomUUID(), expectedVersion: row.version });
            check(r.status === 200, 'CLEANUP_DELETE');
          }, d => baselineUnchanged(d, ownerBaseline!) && d.subscriptions.some(s =>
            s.id === row.id && s.deletedAt !== null && s.emailMode === 'off' && s.rssUrl === null));
        }
        const after = await list();
        check(finalCleanupReadback(after, ownerBaseline, [...owned]), 'BASELINE_READBACK');
        await journal({ phase: 'baseline-restored', activeUsage: after.usage,
          preservedBaselineTombstones: ownerBaseline.rows.length, newTombstones: [...owned], before: baseline, after });
      } catch (e) { cleanup.push(e); }
    }
    try { await signout(); } catch (e) { cleanup.push(e); }
    if (violations) cleanup.push(new Error('NETWORK_OR_MUTATION_GUARD'));
    await finishRun('FEED05_PRIMARY_AND_CLEANUP', { primary, cleanup, completed, articleReading: 'unsupported-empty-archive' });
  }
});
