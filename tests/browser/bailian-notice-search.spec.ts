import type { Page } from '@playwright/test';
import { expect, installReadingRoutes, test } from './fixtures';

async function selectComboboxValue(page: Page, name: string, value: string) {
  await page.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

test('related search commits combined filters once and separates failure from recovery', async ({ page }) => {
  await installReadingRoutes(page, {
    sources: [
      { id: 'academic', siteId: 'university', siteName: '重庆大学', name: '教务处通知', url: 'https://example.edu/', lastRunAt: null, articleCount: 1 },
      { id: 'youth', siteId: 'university', siteName: '重庆大学', name: '团委通知', url: 'https://youth.example.edu/', lastRunAt: null, articleCount: 1 },
      { id: 'library', siteId: 'library', siteName: '图书馆', name: '馆务公告', url: 'https://library.example.edu/', lastRunAt: null, articleCount: 1 },
    ],
  });
  let articlesStatus = 200;
  const articleRequests: string[] = [];
  await page.route('**/api/articles?*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/articles') return route.fallback();
    articleRequests.push(url.pathname + url.search);
    if (articlesStatus !== 200) {
      return route.fulfill({ status: articlesStatus, json: { error: '检索服务暂时不可用' } });
    }
    return route.fulfill({
      json: {
        articles: [{
          id: 'related-notice',
          title: '关于补考安排的通知',
          sourceId: 'academic',
          sourceName: '教务处通知',
          url: 'https://example.edu/make-up-exam',
          publishedAt: '2026-10-28',
          capturedAt: null,
          status: 'complete',
          attachmentCount: 1,
          excerpt: '符合条件的同学可在下一学期初申请补考。',
          match: { label: '附件：补考安排.pdf', href: '/reader/related-notice/attachment-1.pdf?page=2' },
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        searchKind: 'related',
      },
    });
  });

  await page.goto('/');
  const searchBox = page.getByRole('searchbox', { name: '搜索通知' });
  await searchBox.fill('挂科以后还能怎么参加考试');
  await selectComboboxValue(page, '按发布站点筛选', '重庆大学');
  await selectComboboxValue(page, '按来源筛选', '教务处通知');
  await page.getByLabel('发布开始日期').fill('2026-10-01');
  await page.getByLabel('发布结束日期').fill('2026-10-31');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('相关通知 1 条')).toBeVisible();

  expect(articleRequests).toEqual([
    '/api/articles?q=%E6%8C%82%E7%A7%91%E4%BB%A5%E5%90%8E%E8%BF%98%E8%83%BD%E6%80%8E%E4%B9%88%E5%8F%82%E5%8A%A0%E8%80%83%E8%AF%95&site=university&source=academic&from=2026-10-01&to=2026-10-31',
  ]);
  await expect(page.getByText('符合条件的同学可在下一学期初申请补考。')).toBeVisible();
  await expect(page.getByRole('link', { name: '附件：补考安排.pdf' })).toHaveAttribute(
    'href',
    '/reader/related-notice/attachment-1.pdf?page=2',
  );
  expect(page.locator('.notice-pagination')).toHaveCount(0);

  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await searchBox.pressSequentially('不会触发请求', { delay: 20 });
  await expect(page.getByText('相关通知 1 条')).toBeVisible();
  expect(articleRequests).toHaveLength(1);

  articlesStatus = 503;
  await searchBox.fill('缓考');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '关于补考安排的通知', exact: true })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: '搜索通知' })).toHaveValue('缓考');

  articlesStatus = 200;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByText('相关通知 1 条')).toBeVisible();
});

test('a source-only notice URL keeps its committed source', async ({ page }) => {
  const requests: string[] = [];
  await installReadingRoutes(page);
  await page.route('**/api/articles?*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/articles') return route.fallback();
    requests.push(url.pathname + url.search);
    return route.fulfill({ json: { articles: [], total: 0, page: 1, pageSize: 20 } });
  });

  await page.goto('/?source=academic');
  await expect(page.getByRole('combobox', { name: '按来源筛选' })).toContainText('教务处');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  expect(requests).toEqual(['/api/articles?source=academic']);
});

test('related-card links only accept safe same-origin reader destinations', async ({ page }) => {
  await installReadingRoutes(page);
  await page.route('**/api/articles?*', route => route.fulfill({
    json: {
      articles: [
        {
          id: 'safe-link',
          title: '安全匹配通知',
          sourceId: 'academic',
          sourceName: '教务处',
          url: 'https://example.edu/safe',
          publishedAt: null,
          capturedAt: null,
          status: 'complete',
          attachmentCount: 0,
          excerpt: '安全命中片段',
          match: { label: '安全附件', href: '/reader/safe-link/attachment.pdf?page=3' },
        },
        {
          id: 'unsafe-link',
          title: '外部链接通知',
          sourceId: 'academic',
          sourceName: '教务处',
          url: 'https://example.edu/unsafe',
          publishedAt: null,
          capturedAt: null,
          status: 'complete',
          attachmentCount: 0,
          excerpt: '外部命中片段',
          match: { label: '外部附件', href: 'https://evil.example/reader/attachment.pdf' },
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      searchKind: 'related',
    },
  }));

  await page.goto('/?q=命中');
  await expect(page.getByText('安全命中片段')).toBeVisible();
  await expect(page.getByText('外部命中片段')).toBeVisible();
  await expect(page.getByRole('link', { name: '安全附件' })).toHaveAttribute(
    'href',
    '/reader/safe-link/attachment.pdf?page=3',
  );
  await expect(page.getByRole('link', { name: '外部附件' })).toHaveCount(0);
  await expect(page.getByText('外部附件')).toBeVisible();
});
