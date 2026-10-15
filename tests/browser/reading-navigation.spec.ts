import { test, expect, articleId, installReadingRoutes } from './fixtures';

test('Chinese search opens the reading route and browser Back restores the search', async ({ page }) => {
  const { detail } = await installReadingRoutes(page);
  await page.goto('/');
  await page.getByRole('searchbox', { name: '搜索通知' }).fill('优异生');
  const response = page.waitForResponse(value => {
    const url = new URL(value.url());
    return url.pathname === '/api/articles' && url.searchParams.get('q') === '优异生';
  });
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await response;
  await page.getByRole('link', { name: detail.article.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/articles/${articleId}$`));
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('searchbox', { name: '搜索通知' })).toHaveValue('优异生');
  await expect(page.getByRole('link', { name: detail.article.title, exact: true })).toBeVisible();
});

for (const [status, title] of [
  [401, '登录已过期'],
  [403, '这篇通知暂时无法访问'],
  [404, '未找到这篇通知'],
] as const) {
  test(`a detail response of ${status} exposes no notice content or files`, async ({ page }) => {
    const { detail } = await installReadingRoutes(page, { kind: 'pdf', detailStatus: status });
    const fileRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.includes('/files/')) fileRequests.push(request.url());
    });
    await page.goto(`/articles/${articleId}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: detail.article.title, exact: true })).toHaveCount(0);
    await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /通知原件|网页快照|优异生申请表/ })).toHaveCount(0);
    expect(fileRequests).toEqual([]);
  });
}

test('a failed detail request can recover without treating the error as notice content', async ({ page }) => {
  const { detail } = await installReadingRoutes(page, { detailStatus: 500 });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByRole('heading', { name: '暂时无法加载通知' })).toBeVisible();
  await expect(page.getByRole('heading', { name: detail.article.title })).toHaveCount(0);
  await page.route(`**/api/articles/${articleId}`, route => route.fulfill({ json: detail }));
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
});
