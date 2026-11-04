import { expect, installReadingRoutes, test } from './fixtures';

test('source status distinguishes paused sources from active collection health', async ({ page }) => {
  await installReadingRoutes(page, {
    sources: [{
      id: 'civil',
      siteId: 'civil-site',
      siteName: '土木学院',
      name: '土木学院 · 公告',
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

  const site = page.locator('.directory-site > summary');
  const column = page.locator('.directory-column > summary');
  await expect(site).toContainText('土木学院');
  await expect(site).toContainText('暂停 1');
  await expect(column).not.toBeVisible();
  await site.focus();
  await site.press('Enter');
  await expect(column).toContainText('公告');
  await expect(column).not.toContainText('土木学院');
  await expect(column).toContainText('采集已暂停');
  await expect(page.getByRole('link', { name: '打开原栏目' })).not.toBeVisible();
  await column.press('Space');
  await expect(page.locator('.directory-detail dt')).toHaveText(['最近检查', '已存档']);
  await expect(page.getByText('12 条')).toBeVisible();
  await expect(page.getByText('上次采集失败：列表页暂时不可访问')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开原栏目' })).toHaveAttribute('href', 'https://civil.example.edu/notices.htm');
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

  const sites = page.locator('.directory-site');
  await expect(sites).toHaveCount(2);
  const news = sites.filter({ hasText: 'news.example.edu' });
  await expect(news.locator('.directory-totals')).toHaveText('待检查 2正常 1');
  await news.locator(':scope > summary').click();
  await expect(news.locator('.directory-badge')).toHaveText(['检查已超期', '运行正常', '配置待验证']);
  await news.locator('.directory-column > summary').first().click();
  await expect(news.getByText('最近成功检查', {exact:true}).first()).toBeVisible();
  const legacy = sites.filter({ hasText: 'legacy.example.edu' });
  await legacy.locator(':scope > summary').click();
  await expect(legacy.locator('.directory-badge')).toHaveText('运行正常');
  await legacy.locator('.directory-column > summary').click();
  await expect(legacy.getByText('最近检查', {exact:true})).toBeVisible();
});

test('invalid source timestamps and four-item metadata remain readable across layouts and themes', async ({ page }) => {
  await installReadingRoutes(page, {
    admin: true,
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
    await page.locator('.directory-site > summary').click();
    await page.locator('.directory-column > summary').click();
    await expect(page.locator('.directory-badge')).toHaveText('状态未知');
    await expect(page.locator('.directory-detail dt')).toHaveText(['最近检查', '刷新间隔', '已存档', '下次检查']);
    await expect(page.getByText('时间无效')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.setItem('cqu-moe-theme', 'dark'));
  await page.reload();
  await page.locator('.directory-site > summary').click();
  const status = page.locator('.directory-badge');
  await expect(status).toBeVisible();
  expect(await status.evaluate(node => {
    const style = getComputedStyle(node);
    return style.color !== style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  })).toBe(true);
});

test('scheduled checks stay visibly pending until their own processing grace expires', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-03T10:12:00Z') });
  const base = {
    siteId: 'planned-site', siteName: '计划站点', url: 'https://planned.example.edu/',
    enabled: true, siteEnabled: true, validationState: 'verified', refreshIntervalSec: 86400,
    nextDiscoveryAt: Date.parse('2026-11-04T10:00:00Z'),
    lastRunAt: '2026-11-02T09:01:00.000Z', articleCount: 8, error: null,
  };
  await installReadingRoutes(page, { admin: true, sources: [
    { ...base, id: 'planned', name: '本轮等待', scheduledDiscoveryAt: Date.parse('2026-11-03T10:48:00Z') },
    { ...base, id: 'missing', name: '没有排班', scheduledDiscoveryAt: null },
    { ...base, id: 'old', name: '上一轮漏检', lastRunAt: '2026-11-01T09:01:00Z', scheduledDiscoveryAt: null },
    { ...base, id: 'error', name: '已有错误', error: '源站连接失败', scheduledDiscoveryAt: null },
    { ...base, id: 'fresh', name: '已经成功', lastRunAt: '2026-11-03T10:05:00Z', scheduledDiscoveryAt: null },
  ] });
  await page.goto('/sources');
  await page.locator('.directory-site > summary').click();
  await expect(page.locator('.directory-badge')).toHaveText(['等待计划检查', '检查已超期', '检查已超期', '最近有错误', '运行正常']);
  const planned = page.locator('.directory-column').filter({ hasText: '本轮等待' });
  await planned.locator(':scope > summary').click();
  await expect(planned.locator('dt')).toHaveText(['最近成功检查', '刷新间隔', '已存档', '本轮最早检查']);
  const successfulTime = await planned.locator('dd').first().textContent();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { localStorage.setItem('cqu-moe-theme', value); document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(planned.getByText('本轮最早检查', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`planned-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.clock.fastForward(40 * 60_000);
  await page.reload();
  await page.locator('.directory-site > summary').click();
  await expect(planned.locator('.directory-badge')).toHaveText('检查处理中');
  await page.clock.fastForward(7 * 60_000);
  await page.reload();
  await page.locator('.directory-site > summary').click();
  await expect(planned.locator('.directory-badge')).toHaveText('检查已超期');
  await planned.locator(':scope > summary').click();
  await expect(planned.locator('dd').first()).toHaveText(successfulTime!);
});
