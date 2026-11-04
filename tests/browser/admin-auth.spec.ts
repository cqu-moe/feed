import { expect, test } from '@playwright/test';

const diagnostics = {
  generatedAt: '2026-11-03T08:00:00Z',
  limit: 50,
  queues: [
    { topic: 'feed-jobs', deadLetters: [] },
    { topic: 'feed-events', deadLetters: [] },
    { topic: 'feed-mail', deadLetters: [] },
  ],
  tasks: [],
  requirements: [],
  messages: [],
  metrics: {
    oldestBacklog: null,
    readyLatency: { count: 0, minMs: null, maxMs: null },
    missingRequirements: 0,
    paidVendorCalls: 0,
    paidOcrPages: 0,
    authUnavailable: 0,
    mailUnknown: 0,
    referencedImmutableArtifacts: 0,
  },
};

test('logged-out admin routes preserve the requested target through login', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({
    json: { authenticated: false, entitled: false },
  }));

  await page.goto('/admin/tasks?scope=failed');

  await expect(page).toHaveURL(new RegExp('/login\\?next=%2Fadmin%2Ftasks%3Fscope%3Dfailed$'));
  await expect(page.getByRole('link', { name: '登录', exact: true })).toHaveAttribute(
    'href',
    '/auth/login?next=%2Fadmin%2Ftasks%3Fscope%3Dfailed',
  );
});

test('ordinary users get an admin-specific forbidden screen without management requests', async ({ page }) => {
  const internalRequests: string[] = [];
  await page.route('**/api/session', route => route.fulfill({
    json: {
      authenticated: true,
      entitled: true,
      admin: false,
      user: { id: 'ordinary', name: '普通用户' },
    },
  }));
  await page.route('**/internal/**', route => {
    internalRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 403, json: { error: 'forbidden' } });
  });

  await page.goto('/admin/tasks');

  await expect(page.getByRole('heading', { level: 1, name: '需要管理员权限' })).toBeVisible();
  await expect(page.getByText('当前账号没有 Feed 管理权限。')).toBeVisible();
  expect(internalRequests).toEqual([]);
});

test('legacy and malformed admin values do not grant management access', async ({ page }) => {
  for (const admin of [undefined, 'true', 1, null]) {
    await page.route('**/api/session', route => route.fulfill({
      json: {
        authenticated: true,
        entitled: true,
        ...(admin === undefined ? {} : { admin }),
        user: { id: 'ordinary', name: '普通用户' },
      },
    }));
    await page.goto('/admin/tasks');
    await expect(page.getByRole('heading', { level: 1, name: '需要管理员权限' })).toBeVisible();
  }
});

test('admins enter task management through the session and never send Bearer headers', async ({ page }) => {
  const authorizationHeaders: (string | null)[] = [];
  await page.route('**/api/session', route => route.fulfill({
    json: {
      authenticated: true,
      entitled: false,
      admin: true,
      user: { id: 'admin', name: '管理员' },
    },
  }));
  await page.route('**/internal/**', async route => {
    authorizationHeaders.push(route.request().headers()['authorization'] ?? null);
    const path = new URL(route.request().url()).pathname;
    if (path === '/internal/capture-tasks') return route.fulfill({ json: { tasks: [] } });
    if (path === '/internal/operations/diagnostics') return route.fulfill({ json: diagnostics });
    if (path === '/internal/notification-events') return route.fulfill({ json: { events: [] } });
    if (path === '/internal/mail') return route.fulfill({ json: { enabled: false, messages: [] } });
    return route.fulfill({ status: 404, json: { error: 'fixture route not found' } });
  });

  await page.goto('/admin/tasks');

  await expect(page.getByRole('heading', { level: 1, name: '采集任务管理' })).toBeVisible();
  await expect(page.getByText('还没有采集任务。')).toBeVisible();
  expect(authorizationHeaders).toHaveLength(1);
  await page.getByRole('button', { name: '手动采集' }).click();
  await expect(page.getByLabel('通知 ID')).toBeVisible();
  await page.getByRole('tab', { name: '运行诊断' }).click();
  await expect(page.getByText('三条业务队列没有超过重试窗口的未确认消息。')).toBeVisible();
  await page.getByRole('tab', { name: '订阅匹配' }).click();
  await expect(page.getByRole('heading', { name: '通知匹配' })).toBeVisible();
  await page.getByRole('tab', { name: '邮件投递' }).click();
  await expect(page.getByText('邮件发送未启用')).toBeVisible();
  await expect(page.getByText('管理员凭据')).toHaveCount(0);
  await expect(page.getByText('Bearer')).toHaveCount(0);
  expect(authorizationHeaders).toHaveLength(4);
  expect(authorizationHeaders.every(value => value === null)).toBe(true);
});

test('admins enter source management without a credential form or Bearer headers', async ({ page }) => {
  const authorizationHeaders: (string | null)[] = [];
  await page.route('**/api/session', route => route.fulfill({
    json: {
      authenticated: true,
      entitled: false,
      admin: true,
      user: { id: 'admin', name: '管理员' },
    },
  }));
  await page.route('**/internal/**', route => {
    authorizationHeaders.push(route.request().headers()['authorization'] ?? null);
    const path = new URL(route.request().url()).pathname;
    if (path === '/internal/sites') {
      return route.fulfill({ json: { sites: [{ id: 'university', name: '重庆大学', origin: 'https://example.edu', enabled: true }] } });
    }
    if (path === '/internal/sources') {
      return route.fulfill({
        json: {
          sources: [{
            id: 'academic', siteId: 'university', name: '教务处',
            listUrl: 'https://example.edu/notices.htm',
            config: { articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://example.edu/info/1/1.htm' },
            configVersion: 1, enabled: true, siteEnabled: true, refreshIntervalSec: 86400,
            nextDiscoveryAt: null, baselineCutoffAt: null, validationState: 'verified', validationJson: null,
            validatedAt: 0, validationTaskId: null, timezone: 'Asia/Shanghai', articleCount: 0,
            backfill: {
              state: 'idle', defaultWindowDays: 365, maxPages: 100, windowEnd: null, windowDays: null,
              windowStart: null, runId: null, nextAt: 0, startedAt: null, completedAt: null,
              seenPages: 0, processedArticles: 0, remainingUrls: null, lastError: null,
            },
            error: null,
          }],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'fixture route not found' } });
  });

  await page.goto('/admin/sources');

  await expect(page.getByRole('heading', { level: 1, name: '来源配置管理' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: '教务处' })).toBeVisible();
  await expect(page.getByText('管理员凭据')).toHaveCount(0);
  expect(authorizationHeaders).toHaveLength(2);
  expect(authorizationHeaders.every(value => value === null)).toBe(true);
});

test('admin navigation is conditional on the typed session value', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({
    json: {
      authenticated: true,
      entitled: true,
      admin: 'true',
      user: { id: 'ordinary', name: '普通用户' },
    },
  }));
  await page.route('**/api/articles', route => route.fulfill({
    json: { articles: [], total: 0, page: 1, pageSize: 20 },
  }));

  await page.goto('/');

  await expect(page.getByRole('link', { name: '管理' })).toHaveCount(0);
});
