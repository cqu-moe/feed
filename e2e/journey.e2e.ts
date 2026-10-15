import { beforeEach, afterEach, test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { credentials, expect, type JsonValue, type Screen } from 'e2e';
import {
  apiFetch,
  apiFetchMany,
  control,
  escapeOrigin,
  login,
} from './support';

let unexpected: string[];
let clientIpSequence = 10;
let createCommands: { requestId: string; name: string; siteIds: string[]; sourceIds: string[]; emailMode: string }[];

beforeEach(async ({ browser }) => {
  unexpected = [];
  const clientIp = `192.0.2.${++clientIpSequence}`;
  createCommands = [];
  const feed = new URL(process.env.FEED_E2E_APP_URL!);
  const auth = new URL(process.env.FEED_E2E_AUTH_URL!);
  await browser.route('**/*', async route => {
    const target = new URL(route.request.url);
    if (target.origin !== feed.origin && target.origin !== auth.origin) {
      unexpected.push(target.origin);
      await route.abort();
      return;
    }
    if (
      target.origin === feed.origin &&
      target.pathname === '/api/subscriptions' &&
      route.request.method === 'POST' &&
      route.request.postData
    ) createCommands.push(JSON.parse(route.request.postData));
    await route.continue(target.origin === auth.origin
      ? { headers: { ...route.request.headers, 'cf-connecting-ip': clientIp } }
      : {});
  });
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

test('FEED01 real OAuth subscription lifecycle', async ({ app, screen, browser }) => {
  for (const path of ['/subscriptions?view=saved', '/articles?source=jwc', '/access?returnTo=%2Fsubscriptions']) {
    await app.open(path);
    await expect(browser).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
  }
  await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();
  if (process.env.FEED_E2E_BREAK_ASSERTION === '1') {
    await expect(screen.getByRole('heading', '故意错误的成功断言')).toBeVisible();
  }
  await login(app, screen, browser, 'OWNER');
  await expect(screen.getByRole('heading', '我的订阅', { exact: true })).toBeVisible();
  await app.open('/login?next=%2Fsubscriptions%3Fview%3Dsaved');
  await expect(browser).toHaveURL('/subscriptions?view=saved');
  await app.open('/login?next=https%3A%2F%2Fredirect.example.test%2F');
  await expect(browser).toHaveURL('/');
  await app.open('/login?next=%2Flogin');
  await expect(browser).toHaveURL('/');
  await expect(screen.getByRole('heading', '重大通知存档', { exact: true })).toBeVisible();
  await app.open('/subscriptions');
  const archive = await apiFetch<string>(browser, '/api/snapshots/e2e000000000000000000001');
  expect(archive.status).toBe(200);
  expect(archive.body).toContain('这是本地 R2 中的源貌字节');

  await createSubscription(screen, '教务处快照', /教务处（整站快照）/);
  await createSubscription(screen, '国际处精确', '国际处');
  await createSubscription(screen, '土木学院精确', '土木学院');
  let list = await listSubscriptions(browser);
  expect(list.usage).toBe(3);
  const overQuota = await apiFetch<{ error: string }>(browser, '/api/subscriptions', {
    method: 'POST', body: { requestId: 'feed01-over-quota', name: '不应创建', siteIds: [], sourceIds: ['jwc'], emailMode: 'off' },
  });
  expect(overQuota.status).toBe(403);
  expect(overQuota.body.error).toContain('额度已用满');
  expect((await listSubscriptions(browser)).usage).toBe(3);
  expect(list.subscriptions.map(subscription => subscription.name)).toEqual(['教务处快照', '国际处精确', '土木学院精确']);

  const replay = await apiFetch<CreateResponse>(browser, '/api/subscriptions', {
    method: 'POST',
    body: createCommands.find(command => command.name === '教务处快照')!,
  });
  expect(replay.status).toBe(200);
  expect(replay.body.created).toBe(false);
  expect(replay.body.subscription.name).toBe('教务处快照');
  expect((await listSubscriptions(browser)).usage).toBe(3);

  await control('add-verified-source');
  await browser.reload();
  await expect(screen.getByRole('article', '订阅：教务处快照')).toBeVisible();
  await expect(screen.getByText('FEED 新栏目')).toBeVisible();
  let snapshot = await subscriptionByName(browser, '教务处快照');
  expect(snapshot.targetSourceIds).toEqual(['jwc']);

  const snapshotId = snapshot.id;
  await editSubscription(screen, browser, '教务处快照', {
    name: '固定范围快照',
    addSource: '国际处',
    emailMode: '不发送邮件',
    priority: 30,
  });
  snapshot = await subscriptionByName(browser, '固定范围快照');
  expect(snapshot).toMatchObject({
    emailMode: 'off',
    requestedEnabled: true,
    priority: 30,
    targetSourceIds: ['intex', 'jwc'],
  });
  await editSubscription(screen, browser, '固定范围快照', {
    removeSource: '国际处',
    emailMode: '及时提醒',
    priority: 10,
  });
  await editSubscription(screen, browser, '国际处精确', { priority: 20 });
  await browser.reload();
  list = await listSubscriptions(browser);
  expect(list.subscriptions.map(subscription => subscription.name)).toEqual(['固定范围快照', '国际处精确', '土木学院精确']);

  await pauseAndResume(screen, browser, '土木学院精确');
  const civil = await subscriptionByName(browser, '土木学院精确');
  const raced = await apiFetchMany<Record<string, unknown>>(browser, `/api/subscriptions/${civil.id}`, [{
    method: 'PATCH',
    body: {
      requestId: 'feed01-race-a',
      expectedVersion: civil.version,
      name: '并发方案甲',
      sourceIds: ['civil'],
      emailMode: 'off',
      requestedEnabled: true,
      priority: 40,
    },
  }, {
    method: 'PATCH',
    body: {
      requestId: 'feed01-race-b',
      expectedVersion: civil.version,
      name: '并发方案乙',
      sourceIds: ['civil'],
      emailMode: 'daily_digest',
      requestedEnabled: true,
      priority: 50,
    },
  }]);
  expect(raced.map(result => result.status).sort()).toEqual([200, 409]);
  const winnerIndex = raced.findIndex(result => result.status === 200);
  const winnerName = winnerIndex === 0 ? '并发方案甲' : '并发方案乙';
  const persisted = await subscriptionByName(browser, winnerName);
  expect(persisted.priority).toBe(winnerIndex === 0 ? 40 : 50);
  expect(persisted.version).toBe(civil.version + 1);

  const beforeQuotaReduction = await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID });
  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: true, limit: 2 });
  await browser.reload();
  await expect(screen.getByRole('article', `订阅：${winnerName}`)).toContainText('超出当前额度');
  list = await listSubscriptions(browser);
  expect(list.subscriptions.map(subscription => subscription.effectiveStatus)).toEqual(['active', 'active', 'quota_exceeded']);
  const excluded = list.subscriptions.find(s => s.effectiveStatus === 'quota_exceeded')!;
  expect((await readRss(browser, new URL(excluded.rssUrl!, process.env.FEED_E2E_APP_URL).href)).status).toBe(403);
  expect(await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID })).toEqual(beforeQuotaReduction);

  await deleteSubscription(screen, '固定范围快照');
  await browser.reload();
  const deleted = await subscriptionByName(browser, '固定范围快照');
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.rssUrl).toBeNull();

  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: true, limit: 3 });
  await restoreSubscription(screen, browser, '固定范围快照');
  await browser.reload();
  snapshot = await subscriptionByName(browser, '固定范围快照');
  expect(snapshot.deletedAt).toBeNull();
  expect(snapshot.targetSourceIds).toEqual(['jwc']);

  const forged = await csrfProbe(browser, `/api/subscriptions/${snapshotId}`, {
    requestId: 'feed01-forged-origin',
    expectedVersion: snapshot.version,
    name: 'CSRF 拒绝',
    sourceIds: ['jwc'],
    emailMode: 'off',
    requestedEnabled: true,
    priority: 0,
  });
  expect(forged.status).toBe(403);
  expect(forged.body).toContain('invalid_origin');
  expect((await subscriptionByName(browser, '固定范围快照')).version).toBe(snapshot.version);

  const beforeRefresh = await sessionState();
  await control('expire-access', { userId: process.env.FEED_E2E_OWNER_ID });
  expect((await sessionState()).readyForRefresh).toBe(true);
  const refreshed = await apiFetch<{ authenticated: boolean; user: { id: string } }>(browser, '/api/session');
  expect(refreshed.status).toBe(200);
  expect(refreshed.body.authenticated).toBe(true);
  expect(refreshed.body.user.id).toBe(process.env.FEED_E2E_OWNER_ID!);
  const afterRefresh = await sessionState();
  expect(afterRefresh.revision).toBeGreaterThan(beforeRefresh.revision);
  expect(afterRefresh.tokenFingerprint).not.toBe(beforeRefresh.tokenFingerprint);
  expect(afterRefresh.subject).toBe(beforeRefresh.subject);
  await browser.reload();
  await expect(screen.getByRole('heading', '我的订阅', { exact: true })).toBeVisible();

  const rssUrl = new URL(snapshot.rssUrl!, new URL(process.env.FEED_E2E_APP_URL!).origin);
  const firstRss = await readRss(browser, rssUrl.href);
  expect(firstRss.status).toBe(200);
  expect(firstRss.etag).toMatch(/^"[a-f0-9]{64}"$/);
  expect(firstRss.xml).toContain('FEED-01 合成通知');
  const guid = firstRss.xml.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1];
  expect(guid).toMatch(/^urn:cqu-feed:event:/);
  const conditional = await readRss(browser, rssUrl.href, firstRss.etag!);
  expect(conditional.status).toBe(304);
  expect(conditional.etag).toBe(firstRss.etag);
  const repeat = await readRss(browser, rssUrl.href);
  expect(repeat.xml.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]).toBe(guid);

  const preserved = await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID });
  await control('set-rpc-outage', { enabled: true });
  const outage = await apiFetch<ListResponse>(browser, '/api/subscriptions');
  expect(outage.status).toBe(200);
  expect(outage.body.policy.status).toBe('auth_unavailable');
  expect(outage.body.subscriptions.map(s => s.effectiveStatus)).toEqual(['auth_unavailable', 'auth_unavailable', 'auth_unavailable']);
  const rssOutage = await readRss(browser, rssUrl.href, firstRss.etag!);
  expect(rssOutage.status).toBe(503);
  expect(rssOutage.retryAfter).not.toBeNull();
  await control('set-rpc-outage', { enabled: false });
  await control('set-http-outage', { enabled: true });
  expect((await apiFetch(browser, '/api/session')).status).toBe(503);
  expect((await apiFetch(browser, '/api/subscriptions')).status).toBe(503);
  await control('set-http-outage', { enabled: false });
  expect(await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID })).toEqual(preserved);

  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: false, limit: 3 });
  const denied = await listSubscriptions(browser);
  expect(denied.subscriptions.map(s => s.effectiveStatus)).toEqual(['access_revoked', 'access_revoked', 'access_revoked']);
  expect((await readRss(browser, rssUrl.href, firstRss.etag!)).status).toBe(403);
  expect((await apiFetch(browser, '/api/articles')).status).toBe(403);
  expect((await apiFetch(browser, '/api/snapshots/e2e000000000000000000001')).status).toBe(403);
  expect(await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID })).toEqual(preserved);
  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: true, limit: 3 });
  expect((await readRss(browser, rssUrl.href)).status).toBe(200);
  await browser.reload();
  expect((await listSubscriptions(browser)).usage).toBe(3);
  await expect(screen.getByRole('article', '订阅：固定范围快照')).toBeVisible();

  await rotateRss(screen, browser, '固定范围快照', rssUrl.href, guid!);
  await revokeRss(screen, browser, '固定范围快照');

  await control('revoke-oauth', { userId: process.env.FEED_E2E_OWNER_ID });
  const revoked = await apiFetch<Record<string, unknown>>(browser, '/api/subscriptions');
  expect(revoked.status).toBe(401);
  await app.open('/subscriptions');
  await expect(browser).toHaveURL(/\/login/);

  const ownerBeforeOther = await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID });
  await app.clearState();
  await login(app, screen, browser, 'OTHER');
  await app.open('/subscriptions');
  const otherList = await listSubscriptions(browser);
  expect(otherList.usage).toBe(0);
  expect(otherList.subscriptions).toEqual([]);
  expect((await apiFetch(browser, `/api/subscriptions/${snapshotId}`)).status).toBe(404);
  const otherMutation = await apiFetch<Record<string, unknown>>(browser, `/api/subscriptions/${snapshotId}`, {
    method: 'DELETE',
    body: { requestId: 'feed01-other-delete', expectedVersion: snapshot.version },
  });
  expect(otherMutation.status).toBe(404);

  const ownerStored = await control('read-subscriptions', { userId: process.env.FEED_E2E_OWNER_ID });
  expect(ownerStored).toEqual(ownerBeforeOther);

  await screen.getByRole('button', '退出').click();
  await expect(browser).toHaveURL(/\/login/);
  const loggedOut = await apiFetch<Record<string, unknown>>(browser, '/api/subscriptions');
  expect(loggedOut.status).toBe(401);
  await app.open('/subscriptions');
  await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();
  // The central Auth session is separate; the BFF session is created again by real OAuth.
  await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
  await expect(browser).toHaveURL(/\/subscriptions$/);
  expect((await apiFetch(browser, '/api/session')).status).toBe(200);
  await control('expire-session', { userId: process.env.FEED_E2E_OTHER_ID });
  const expired = await apiFetch<{ authenticated: boolean; error: string }>(browser, '/api/session');
  expect(expired.body).toMatchObject({ authenticated: false, error: 'session_expired' });
  expect((await apiFetch(browser, '/api/subscriptions')).status).toBe(401);
  expect(await control('session-state', { userId: process.env.FEED_E2E_OTHER_ID })).toBeNull();
});

test('FEED01 malformed callback and OAuth rejection fail closed', async ({ app, screen, browser }) => {
  await control('set-consent-client', { enabled: true });
  try {
    await app.open('/subscriptions');
    await expect(browser).toHaveURL(/\/login\?next=/);
    const anonymous = await apiFetch<Record<string, unknown>>(browser, '/api/subscriptions');
    expect(anonymous.status).toBe(401);

    await browser.goto(`${new URL(process.env.FEED_E2E_APP_URL!).origin}/auth/callback?code=synthetic-code&state=synthetic-state`);
    await expect(browser).toHaveURL(/\/login\?auth=invalid/);
    await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();

    await screen.getByRole('link', '使用 auth.cqu.moe 登录').click();
    await expect(browser).toHaveURL(new RegExp(`^${escapeOrigin(new URL(process.env.FEED_E2E_AUTH_URL!).origin)}/login`));
    await screen.getByLabel('邮箱').fill(credentials.user('reject').username);
    await browser.locator('#password').fill(credentials.user('reject').password);
    await screen.getByRole('button', '登录', { exact: true }).click();
    await screen.getByRole('button', '拒绝', { exact: true }).click();
    await expect(browser).toHaveURL(/\/login\?auth=invalid/);
    await expect(screen.getByRole('heading', '登录重大通知存档', { exact: true })).toBeVisible();
    expect((await apiFetch(browser, '/api/subscriptions')).status).toBe(401);
  } finally {
    await control('set-consent-client', { enabled: false });
  }
});

type Subscription = {
  id: string;
  name: string;
  version: number;
  priority: number;
  emailMode: string;
  requestedEnabled: boolean;
  effectiveStatus: string;
  rssStatus: string;
  targetSourceIds: string[];
  deletedAt: string | null;
  rssUrl: string | null;
};

type ListResponse = {
  usage: number;
  policy: { status: string };
  subscriptions: Subscription[];
};

type CreateResponse = {
  created: boolean;
  subscription: Subscription;
};

async function listSubscriptions(browser: Browser): Promise<ListResponse> {
  const result = await apiFetch<ListResponse>(browser, '/api/subscriptions');
  expect(result.status).toBe(200);
  return result.body;
}

async function subscriptionByName(browser: Browser, name: string): Promise<Subscription> {
  const list = await listSubscriptions(browser);
  const subscription = list.subscriptions.find(item => item.name === name);
  expect(subscription).toBeDefined();
  return subscription!;
}

async function sessionState(): Promise<{ revision: number; subject: string; readyForRefresh: boolean; tokenFingerprint: string }> {
  return control('session-state', { userId: process.env.FEED_E2E_OWNER_ID });
}

async function csrfProbe(browser: Browser, path: string, body: JsonValue) {
  const cookies = (await browser.cookies())
    .filter(cookie => cookie.name === '__Host-feed_session')
    .map(cookie => `${cookie.name}=${cookie.value}`);
  const response = await fetch(`${process.env.FEED_E2E_CONTROL_URL}/control`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.FEED_E2E_CONTROL_SECRET}` },
    body: JSON.stringify({
      action: 'csrf-probe',
      cookie: cookies.join('; '),
      method: 'PATCH',
      path,
      origin: 'https://csrf.example.test',
      body,
    }),
  });
  const responseText = await response.text();
  if (response.status >= 500) throw new Error(`Runtime CSRF probe failed (${response.status}): ${responseText}`);
  return { status: response.status, body: responseText };
}

async function createSubscription(screen: Screen, name: string, target: string | RegExp) {
  await screen.getByLabel('订阅名称').fill(name);
  await screen.getByRole('checkbox', target).click();
  await screen.getByRole('button', '创建订阅').click();
  await expect(screen.getByRole('article', `订阅：${name}`)).toBeVisible();
}

async function editSubscription(
  screen: Screen,
  browser: Browser,
  name: string,
  changes: { name?: string; addSource?: string; removeSource?: string; emailMode?: string; priority?: number },
) {
  const card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '编辑订阅').click();
  if (changes.name) await card.getByLabel('订阅名称').fill(changes.name);
  if (changes.addSource) await card.getByRole('checkbox', changes.addSource).click();
  if (changes.removeSource) await card.getByRole('checkbox', changes.removeSource).click();
  if (changes.emailMode) {
    await card.getByRole('combobox', '编辑邮件模式').click();
    await screen.getByRole('option', changes.emailMode).click();
  }
  if (changes.priority !== undefined) await card.getByLabel(/运行优先级/).fill(String(changes.priority));
  await card.getByRole('button', '保存修改').click();
  const renamed = changes.name ?? name;
  await expect(screen.getByRole('article', `订阅：${renamed}`)).toBeVisible();
  expect(await listSubscriptions(browser)).toMatchObject({ usage: expect.any(Number) });
}

async function pauseAndResume(screen: Screen, browser: Browser, name: string) {
  let card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '暂停订阅').click();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('已暂停');
  const paused = await subscriptionByName(browser, name);
  expect(paused.requestedEnabled).toBe(false);
  await browser.reload();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('已暂停');
  card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '启用订阅').click();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('运行中');
  expect((await subscriptionByName(browser, name)).requestedEnabled).toBe(true);
}

async function deleteSubscription(screen: Screen, name: string) {
  const card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '删除订阅').click();
  await screen.getByRole('button', '确认操作').click();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('已删除');
}

async function restoreSubscription(screen: Screen, browser: Browser, name: string) {
  const card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '恢复订阅').click();
  await card.getByRole('button', '确认恢复订阅').click();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('运行中');
  expect((await subscriptionByName(browser, name)).deletedAt).toBeNull();
}

async function rotateRss(screen: Screen, browser: Browser, name: string, oldUrl: string, guid: string) {
  const card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '重置 RSS').click();
  await screen.getByRole('button', '确认操作').click();
  await expect(card.getByText('修改已保存。')).toBeVisible();
  const next = await subscriptionByName(browser, name);
  expect(next.rssUrl).not.toBeNull();
  const nextUrl = new URL(next.rssUrl!, new URL(process.env.FEED_E2E_APP_URL!).origin).href;
  expect(nextUrl).not.toBe(oldUrl);
  expect((await readRss(browser, oldUrl)).status).toBe(404);
  const rotated = await readRss(browser, nextUrl);
  expect(rotated.status).toBe(200);
  expect(rotated.xml.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]).toBe(guid);
}

async function revokeRss(screen: Screen, browser: Browser, name: string) {
  const oldUrl = (await subscriptionByName(browser, name)).rssUrl!;
  const card = screen.getByRole('article', `订阅：${name}`);
  await card.getByRole('button', '撤销 RSS').click();
  await screen.getByRole('button', '确认操作').click();
  await expect(card).toContainText('RSS 已撤销。');
  const current = await subscriptionByName(browser, name);
  expect(current.rssUrl).toBeNull();
  expect(current.rssStatus).toBe('rss_revoked');
  expect((await readRss(browser, new URL(oldUrl, process.env.FEED_E2E_APP_URL).href)).status).toBe(404);
  await browser.reload();
  await expect(screen.getByRole('article', `订阅：${name}`)).toContainText('RSS 已撤销。');
}

async function readRss(browser: Browser, url: string, ifNoneMatch?: string) {
  const payload = await browser.evaluate(async (input: { url: string; ifNoneMatch?: string }) => {
    const response = await fetch(input.url, {
      cache: 'no-store',
      credentials: 'omit',
      headers: input.ifNoneMatch ? { 'if-none-match': input.ifNoneMatch } : {},
    });
    return JSON.stringify({
      status: response.status,
      etag: response.headers.get('etag'),
      retryAfter: response.headers.get('retry-after'),
      xml: await response.text(),
    });
  }, ifNoneMatch === undefined ? { url } : { url, ifNoneMatch });
  return JSON.parse(payload) as { status: number; etag: string | null; retryAfter: string | null; xml: string };
}
