import { expect, test, type Page } from '@playwright/test';

const first = {
  id: '1'.repeat(24), kind: 'discover', state: 'failed', sourceId: 'news', siteId: 'cs',
  siteName: '计算机学院', sourceName: '计算机学院 · 学院新闻', listUrl: 'https://example.edu/news',
  lastError: '栏目页面返回 503', articleId: null, attemptNo: 1, updatedAt: 1700000000000,
  workflowInstanceId: null, attemptState: 'failed', articleStatus: null, dueAt: 1700000000000,
};
async function session(page: Page) {
  await page.route('**/api/session', route => route.fulfill({ json: {
    authenticated: true, admin: true, entitled: false, user: { id: 'admin', name: '管理员' },
  } }));
}
test('a failed task is retried by its own ID; a declined retry stays visible and a successful one leaves the failed filter', async ({ page }) => {
  await session(page);
  let recovered = false;
  const commands: string[] = [];
  await page.route('**/internal/capture-tasks', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: { tasks: [recovered ? { ...first, state: 'queued', attemptNo: 2, lastError: null } : first,
      { ...first, id: '2'.repeat(24), state: 'cancelled', sourceName: '计算机学院 · 通知公告', lastError: null }] } });
  });
  await page.route('**/internal/operations/tasks/*/recover', route => {
    commands.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    recovered = commands.length === 2;
    return route.fulfill({ json: { recovered: Number(recovered), state: recovered ? 'queued' : 'failed' } });
  });
  await page.goto('/admin/tasks');
  await expect(page.getByRole('button', { name: '执行失败 1' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('计算机学院', { exact: true }).click();
  await page.getByText('学院新闻', { exact: true }).click();
  await expect(page.getByText('栏目页面返回 503')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开原栏目' })).toHaveAttribute('href', first.listUrl);
  const retry = page.getByRole('button', { name: '重试此任务' });
  await retry.click();
  await expect(page.getByRole('status')).toContainText('没有启动新执行');
  await retry.click();
  await expect(page.getByRole('button', { name: '执行失败 0' })).toBeVisible();
  expect(commands).toEqual(Array(2).fill('POST /internal/operations/tasks/' + first.id + '/recover'));
  await page.getByRole('button', { name: '排队中 1' }).click();
  await page.getByText('计算机学院', { exact: true }).click();
  await page.getByText('学院新闻', { exact: true }).click();
  await expect(page.getByText('2 次', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
});
test('cancelled task details are keyboard accessible on a narrow screen and cannot be restarted', async ({ page }) => {
  await session(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route('**/internal/capture-tasks', route => route.fulfill({ json: { tasks: [
    { ...first, state: 'cancelled', lastError: null },
    { ...first, state: 'blocked', id: '2'.repeat(24), sourceId: null, siteId: null, siteName: null, sourceName: null },
  ] } }));
  await page.goto('/admin/tasks');
  await page.getByRole('button', { name: '已取消 1' }).click();
  await page.locator('summary').filter({ hasText: '计算机学院' }).press('Enter');
  await page.locator('summary').filter({ hasText: '学院新闻' }).press('Enter');
  await expect(page.getByText('任务已取消，不会继续执行。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试此任务' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '等待处理 1' }).click();
  await expect(page.getByText('未关联网站')).toBeVisible();
});

test('a manual capture opens its queued task even when the page started on an empty failed filter', async ({ page }) => {
  await session(page);
  const articleId = '3'.repeat(24);
  await page.route('**/internal/capture-tasks', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { tasks: [] } });
    expect(route.request().postDataJSON()).toEqual({ articleId, requestId: expect.any(String) });
    return route.fulfill({ status: 202, json: { task: { ...first, articleId, articleTitle: '考试安排', kind: 'capture',
      lastError: null, state: 'queued', attemptState: null } } });
  });
  await page.goto('/admin/tasks');
  await page.getByRole('button', { name: '手动采集' }).click();
  await page.getByLabel('通知 ID').fill(articleId);
  await page.getByRole('button', { name: '发起一次采集' }).click();
  await expect(page.getByRole('button', { name: '排队中 1' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: '查看通知' })).toHaveAttribute('href', '/articles/' + articleId);
  await expect(page.getByText('考试安排')).toBeVisible();
});
