import type { Page } from '@playwright/test';
import { test, expect, installReadingRoutes } from './fixtures';

const existing = {
  id: 'aaaaaaaaaaaaaaaaaaaa0001', version: 1, name: '教务提醒',
  requestedEnabled: true, priority: 100, emailMode: 'daily_digest',
  activatedAt: '2026-10-20T08:00:00Z', createdAt: '2026-10-20T08:00:00Z', deletedAt: null,
  targetSourceIds: ['academic'], savedSourceIds: ['academic'],
  targets: [{ sourceId: 'academic', sourceName: '教务处', effectiveFrom: '2026-10-20T08:00:00Z' }],
  effectiveStatus: 'active', rssStatus: 'active', emailStatus: 'active', rssUrl: null,
};
const subscriptionList = {
  subscriptions: [existing], usage: 1,
  policy: { status: 'available', access: true, subscriptionLimit: { kind: 'limited', value: 3 } },
  sites: [{ id: 'university', name: '重庆大学' }],
  sources: [{ id: 'academic', siteId: 'university', name: '教务处' }],
  outputChannels: { rss: { enabled: true }, email: { enabled: true } },
};

async function openSubscriptions(page: Page) {
  await page.goto('/subscriptions');
  await expect(page.getByRole('article', { name: '订阅：教务提醒' })).toBeVisible();
}

test('an uncertain creation can retry the same command after the list refresh also fails', async ({ page }) => {
  await installReadingRoutes(page);
  const commands: Record<string, unknown>[] = [];
  const created = { ...existing, id: 'aaaaaaaaaaaaaaaaaaaa0002', name: '课程提醒' };
  await page.route('**/api/subscriptions', async route => {
    if (route.request().method() === 'POST') {
      commands.push(route.request().postDataJSON());
      return commands.length === 1
        ? route.fulfill({ status: 503, json: { error: '暂时无法确认创建结果' } })
        : route.fulfill({ json: { created: true, subscription: created } });
    }
    if (commands.length === 1) return route.fulfill({ status: 503, json: { error: '订阅列表暂不可用' } });
    return route.fulfill({ json: commands.length === 2
      ? { ...subscriptionList, usage: 2, subscriptions: [existing, created] }
      : subscriptionList });
  });
  await openSubscriptions(page);
  await page.getByRole('button', { name: '新建订阅', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '新建订阅' });
  await sheet.getByLabel('订阅名称').fill('课程提醒');
  await sheet.getByRole('checkbox', { name: '教务处', exact: true }).check();
  const refreshedFailure = page.waitForResponse(response =>
    response.url().endsWith('/api/subscriptions') && response.request().method() === 'GET' && response.status() === 503);
  await sheet.getByRole('button', { name: '创建订阅', exact: true }).click();
  await refreshedFailure;
  await expect(page.getByText('订阅列表暂不可用', { exact: false })).toBeAttached();
  await expect(sheet.getByText('暂时无法确认创建结果', { exact: false })).toBeVisible();
  await expect(sheet.getByLabel('订阅名称')).toHaveValue('课程提醒');
  await expect(sheet.getByLabel('订阅名称')).toBeDisabled();
  await expect(sheet.getByRole('button', { name: '重试保存' })).toBeEnabled();
  await sheet.getByRole('button', { name: '重试保存' }).click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByRole('article', { name: '订阅：课程提醒' })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0].requestId).toEqual(expect.any(String));
  expect(commands[1]).toEqual(commands[0]);
});

test('compact subscriptions keep identity first and restore focus from their sheets', async ({ page }, testInfo) => {
  await installReadingRoutes(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: subscriptionList }));
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await openSubscriptions(page);
    const row = page.getByRole('article', { name: '订阅：教务提醒' });
    const heading = row.getByRole('heading', { name: '教务提醒' });
    const titleBox = await heading.boundingBox();
    const deliveryBox = await row.getByText('每日摘要', { exact: true }).boundingBox();
    expect(titleBox).not.toBeNull();
    expect(deliveryBox).not.toBeNull();
    expect(titleBox!.y).toBeLessThan(deliveryBox!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`subscriptions-${width}.png`), fullPage: true });

    const newButton = page.getByRole('button', { name: '新建订阅', exact: true });
    await newButton.click();
    let sheet = page.getByRole('dialog', { name: '新建订阅' });
    await expect(sheet.getByRole('heading', { name: '新建订阅' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(newButton).toBeFocused();

    const editButton = row.getByRole('button', { name: '编辑订阅：教务提醒', exact: true });
    await editButton.click();
    sheet = page.getByRole('dialog', { name: '编辑订阅' });
    await expect(sheet.getByRole('heading', { name: '编辑订阅' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editButton).toBeFocused();
  }
});
