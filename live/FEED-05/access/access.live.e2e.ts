import { test } from '@e2e-dev/web';
import { credentials, expect, secrets } from 'e2e';
import { AUTH, FEED, account, finishRun, journal, requireThat as check } from '../browser/state.mjs';
import { createAdmin, withRevokedAccess } from './admin.mjs';

test('FEED05 isolated owner access revocation and exact restoration', { trace: 'off', video: 'off' }, async ({ app, browser, screen }) => {
  check(process.env.FEED05_MODE === 'execute', 'LIVE_EXECUTION_NOT_ARMED');
  let violations = 0, primary: unknown, admin: Awaited<ReturnType<typeof createAdmin>> | undefined;
  const cleanup: unknown[] = [];
  let ownerLoginAttempted = false;
  const completed: string[] = [];
  async function api(path: string, method = 'GET') {
    check(new URL(await browser.url()).origin === FEED, 'FEED_PAGE_REQUIRED');
    return JSON.parse(await browser.evaluate(async input => {
      const r = await fetch(input.path, { method: input.method, credentials: 'same-origin',
        ...(input.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
        signal: AbortSignal.timeout(20000) });
      return JSON.stringify({ status: r.status, body: await r.json() });
    }, { path, method }));
  }
  await browser.route('**/*', async route => {
    const u = new URL(route.request.url);
    if (![FEED, AUTH].includes(u.origin) ||
      (u.origin === FEED && route.request.method !== 'GET' && u.pathname !== '/auth/logout')) {
      violations++; await route.abort(); return;
    }
    await route.continue();
  });
  try {
    await journal({ phase: 'intent', step: 'owner-ui-oauth' });
    await browser.goto(`${FEED}/login`);
    const fresh = await api('/api/session');
    check(fresh.status === 200 && fresh.body.authenticated === false, 'FRESH_OWNER_REQUIRED');
    ownerLoginAttempted = true;
    await app.open('/subscriptions');
    await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
    await expect(browser).toHaveURL(new RegExp(`^${AUTH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/login(?:[?#]|$)`));
    check(new URL(await browser.url()).origin === AUTH, 'AUTH_ORIGIN_REQUIRED');
    await screen.getByLabel('邮箱', { exact: true }).fill(secrets.get('ownerEmail'));
    await browser.locator('#password').fill(credentials.user('owner').password);
    await screen.getByRole('button', '登录', { exact: true }).click();
    await expect(browser).toHaveURL(`${FEED}/subscriptions`);
    await expect(screen.getByLabel('订阅名称', { exact: true })).toBeVisible();
    const initial = await api('/api/session');
    check(initial.status === 200 && initial.body.authenticated && initial.body.entitled, 'BASELINE_OWNER_ACCESS');
    const baselineReading = await api('/api/articles');
    check(baselineReading.status === 200, 'BASELINE_ARTICLES_200');
    await journal({ phase: 'baseline-reading', status: baselineReading.status });
    const baseline = await api('/api/subscriptions');
    check(baseline.status === 200 && baseline.body.outputChannels.email.enabled === false, 'BASELINE_SUBSCRIPTIONS');
    await journal({ phase: 'baseline-subscriptions', before: baseline.body });
    await browser.goto(`${AUTH}/login`);
    const ownerSession = JSON.parse(await browser.evaluate(async () => {
      const r = await fetch('/api/v1/auth/get-session', { signal: AbortSignal.timeout(20000) });
      return JSON.stringify({ status: r.status, body: await r.json() });
    }));
    check(ownerSession.status === 200 && ownerSession.body?.user?.email === (await account('owner')).email, 'OWNER_IDENTITY_REQUIRED');
    admin = await createAdmin(ownerSession.body.user.id);
    await admin.login();
    await browser.goto(`${FEED}/subscriptions`);
    await withRevokedAccess({ admin, owner: ownerSession.body.user.id, verify: async () => {
      const session = await api('/api/session');
      const denied = await api('/api/articles');
      const management = await api('/api/subscriptions');
      await journal({ phase: 'revoked-management-read', status: management.status,
        policyAccess: management.body?.policy?.access ?? null });
      check(session.status === 200 && session.body.authenticated === true && session.body.entitled === false,
        'ACCESS_DENIAL_NOT_SIGNOUT');
      check(denied.status === 403 && denied.body.error === '需要 feed.access 权益', 'EXACT_ACCESS_403_REQUIRED');
      await app.open('/');
      await expect(screen.getByRole('heading', '缺少 feed.access 权益', { exact: true })).toBeVisible();
      await expect(screen.getByLabel('订阅名称', { exact: true })).toHaveCount(0);
      await journal({ phase: 'complete', step: 'access-denied', status: 403, authenticated: true, entitled: false });
      completed.push('access-denied');
    } });
    await browser.goto(`${FEED}/subscriptions`);
    await expect(screen.getByLabel('订阅名称', { exact: true })).toBeVisible();
    const recovered = await api('/api/session'), articles = await api('/api/articles'), after = await api('/api/subscriptions');
    check(recovered.status === 200 && recovered.body.authenticated && recovered.body.entitled
      && articles.status === 200 && after.status === 200, 'OWNER_ACCESS_RECOVERY');
    check(JSON.stringify(after.body.subscriptions) === JSON.stringify(baseline.body.subscriptions)
      && after.body.usage === baseline.body.usage, 'SUBSCRIPTIONS_UNCHANGED_INCLUDING_TOMBSTONES');
    await journal({ phase: 'complete', step: 'owner-access-recovered', before: baseline.body, after: after.body });
    completed.push('owner-access-recovered');
  } catch (error) { primary = error; }
  finally {
    // Every signout is attempted separately; restore happens inside the
    // transaction's finally before either session may be destroyed.
    try {
      if (ownerLoginAttempted) {
        await browser.goto(`${FEED}/login`);
        check((await api('/auth/logout', 'POST')).status === 200, 'FEED_SIGNOUT');
        check((await api('/api/articles')).status === 401, 'FEED_SIGNOUT_READBACK');
      }
    } catch (error) { cleanup.push(error); }
    try {
      await browser.goto(`${AUTH}/login`);
      const value = JSON.parse(await browser.evaluate(async () => {
        const r = await fetch('/api/v1/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
        const s = await fetch('/api/v1/auth/get-session', { signal: AbortSignal.timeout(20000) });
        return JSON.stringify({ status: r.status, sessionStatus: s.status, empty: await s.json() === null });
      }));
      check(value.status === 200 && value.sessionStatus === 200 && value.empty, 'OWNER_AUTH_SIGNOUT');
    } catch (error) { cleanup.push(error); }
    try { if (admin) await admin.signout(); } catch (error) { cleanup.push(error); }
    if (violations) cleanup.push(new Error('UNEXPECTED_NETWORK_OR_FEED_WRITE'));
    await finishRun('ACCESS_PRIMARY_AND_CLEANUP', { primary, cleanup, completed });
  }
});
