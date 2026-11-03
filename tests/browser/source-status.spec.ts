import { expect, installReadingRoutes, test } from './fixtures';

test('source status distinguishes paused sources from active collection health', async ({ page }) => {
  await installReadingRoutes(page, {
    sources: [{
      id: 'civil',
      siteId: 'civil-site',
      name: '土木学院',
      url: 'https://civil.example.edu/',
      listUrl: 'https://civil.example.edu/notices.htm',
      enabled: false,
      siteEnabled: true,
      validationState: 'verified',
      refreshIntervalSec: 86400,
      nextDiscoveryAt: 0,
      lastRunAt: '2026-10-13T08:00:00.000Z',
      articleCount: 12,
      error: '上次采集失败：列表页暂时不可访问',
    }],
  });
  await page.goto('/sources');

  const paused = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '土木学院' }) });
  await expect(paused).toBeVisible();
  await expect(paused.locator('..')).toContainText('采集已暂停');
  await expect(paused.locator('..')).toContainText('最近检查');
  await expect(paused.locator('..')).toContainText('上次采集失败：列表页暂时不可访问');
  await expect(paused.locator('..')).not.toContainText('运行正常');
  await expect(page.getByRole('link', { name: /栏目列表/ })).toHaveAttribute(
    'href',
    'https://civil.example.edu/notices.htm',
  );
});

test('source status reflects overdue, validation and legacy API states', async ({ page }) => {
  await installReadingRoutes(page, {
    sources: [
      {
        id: 'news', siteId: 'news-site', name: '新闻网', url: 'https://news.example.edu/',
        listUrl: 'https://news.example.edu/list.htm', enabled: true, siteEnabled: true,
        validationState: 'verified', refreshIntervalSec: 86400, nextDiscoveryAt: Date.now() - 600000,
        lastRunAt: new Date(Date.now() - 864012000).toISOString(), articleCount: 8, error: null,
      },
      {
        id: 'waiting', siteId: 'news-site', name: '待整点扫描', url: 'https://news.example.edu/',
        listUrl: 'https://news.example.edu/list.htm', enabled: true, siteEnabled: true,
        validationState: 'verified', refreshIntervalSec: 86400, nextDiscoveryAt: Date.now() - 65 * 60_000,
        lastRunAt: new Date(Date.now() - 86400_000 - 65 * 60_000).toISOString(), articleCount: 8, error: null,
      },
      {
        id: 'new', siteId: 'news-site', name: '新栏目', url: 'https://news.example.edu/',
        listUrl: 'https://news.example.edu/new.htm', enabled: true, siteEnabled: true,
        validationState: 'draft', refreshIntervalSec: 3600, nextDiscoveryAt: 0,
        lastRunAt: null, articleCount: 0, error: null,
      },
      {
        id: 'legacy', siteId: 'legacy-site', name: '旧接口', url: 'https://legacy.example.edu/',
        lastRunAt: '2026-10-13T08:00:00.000Z', articleCount: 2, error: null,
      },
    ],
  });
  await page.goto('/sources');

  const news = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '新闻网' }) });
  await expect(news).toContainText('检查已超期');
  await expect(news).toContainText('最近成功检查');
  await expect(page.locator('article', { has: page.getByRole('heading', { level: 2, name: '待整点扫描' }) })).toContainText('运行正常');
  const draft = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '新栏目' }) });
  await expect(draft).toContainText('配置待验证');
  const legacy = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '旧接口' }) });
  await expect(legacy).toContainText('运行正常');
  await expect(legacy).toContainText('最近检查');
});

test('invalid source timestamps and four-item metadata remain readable across layouts and themes', async ({ page }) => {
  await installReadingRoutes(page, {
    sources: [{
      id: 'invalid', siteId: 'invalid-site', name: '时间异常', url: 'https://invalid.example.edu/',
      listUrl: 'https://invalid.example.edu/list.htm', enabled: true, siteEnabled: true,
      validationState: 'verified', refreshIntervalSec: 3600, nextDiscoveryAt: Date.now() + 600000,
      lastRunAt: 'not-a-time', articleCount: 0, error: null,
    }],
  });

  for (const layout of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(layout);
    await page.goto('/sources');
    const card = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '时间异常' }) });
    await expect(card).toContainText('状态未知');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.setItem('cqu-moe-theme', 'dark'));
  await page.reload();
  const status = page.locator('article', { has: page.getByRole('heading', { level: 2, name: '时间异常' }) }).locator('.feed-source-state');
  await expect(status).toBeVisible();
  expect(await status.evaluate(node => {
    const style = getComputedStyle(node);
    return style.color !== style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  })).toBe(true);
});
