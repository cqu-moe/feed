import { test as base, expect, firefox, webkit, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { control } from './support';

// The fixed e2e engine cannot ignore local TLS errors in Firefox/WebKit.
// This supplemental engine check uses the same real runtime and archive fixtures.
const test = base.extend<{ archivePage: Page }>({
  archivePage: async ({}, use, info) => {
    const out = process.env.FEED_E2E_OUTPUT!;
    const browserName = process.env.FEED_E2E_BROWSER!;
    const profiles = join(out, '.profiles');
    await mkdir(profiles, { recursive: true });
    const profile = await mkdtemp(join(profiles, `${browserName}-`));
    const browserType = browserName === 'firefox' ? firefox : webkit;
    let context;
    try {
      context = await browserType.launchPersistentContext(profile, {
        headless: true,
        ignoreHTTPSErrors: true,
        viewport: process.env.FEED_E2E_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      });
      const unexpected: string[] = [];
      const origins = [new URL(process.env.FEED_E2E_APP_URL!).origin, new URL(process.env.FEED_E2E_AUTH_URL!).origin];
      await context.route('**/*', async route => {
        const origin = new URL(route.request().url()).origin;
        if (origins.includes(origin)) await route.continue();
        else { unexpected.push(origin); await route.abort(); }
      });
      const page = context.pages()[0] ?? await context.newPage();
      await use(page);
      expect(unexpected).toEqual([]);
    } finally {
      const errors: unknown[] = [];
      try { await context?.close(); } catch (error) { errors.push(error); }
      const disconnected = context !== undefined && context.browser()?.isConnected() === false;
      try {
        await rm(profile, { recursive: true, force: true });
        await stat(profile).then(() => { throw new Error('Disposable profile remains'); }, error => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) { errors.push(error); }
      if (!disconnected) errors.push(new Error('Browser did not disconnect during close'));
      if (errors.length) throw new AggregateError(errors, 'Supplemental browser cleanup failed');
      await writeFile(join(out, `browser-cleanup-${browserName}-${info.testId}.json`), JSON.stringify({ exited: true, profileRemoved: true, headless: true }));
    }
  },
});

const webId = 'e2e000000000000000000002';
const pdfId = 'e2e000000000000000000003';
const revision = 'e2e000000000000000000023';
const appUrl = (path: string) => new URL(path, process.env.FEED_E2E_APP_URL!).href;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('FEED02 supplemental engine: real OAuth, search, versions, PDF, snapshot and recovery', async ({ archivePage: page }) => {
  await page.goto(appUrl('/subscriptions'));
  await page.getByRole('link', { name: '使用 auth.cqu.moe 登录' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(process.env.FEED_E2E_OWNER_EMAIL!);
  await page.locator('#password').fill(process.env.FEED_E2E_OWNER_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(appUrl('/subscriptions'));
  await page.goto(appUrl('/'));
  await page.getByLabel('搜索通知').fill('FEED02 分页存档资料');
  await page.getByLabel('搜索通知').press('Enter');
  await expect(page.getByText('共 22 条通知 · 第 1 / 2 页')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByText('共 22 条通知 · 第 2 / 2 页')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('共 22 条通知 · 第 1 / 2 页')).toBeVisible();
  await expect(page.getByLabel('搜索通知')).toHaveValue('FEED02 分页存档资料');
  await page.goto(appUrl(`/articles/${webId}`));
  await expect(page.getByText('这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。')).toBeVisible();
  await expect(page.getByText('新版本暂未就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '历史版本', exact: true }).press('Enter');
  await page.getByRole('button', { name: '查看版本' }).last().click();
  await expect(page.getByText('这是历史完整网页正文，附件与快照均属于旧版本。')).toBeVisible();
  await page.getByRole('link', { name: '网页快照', exact: true }).press('Enter');
  await expect(page.getByText('旧版本快照')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('link', { name: '历史申请表.doc' })).toBeVisible();
  await page.goto(appUrl(`/articles/${pdfId}`));
  const frame = page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  await expect(frame.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible();
  await expect(frame.getByLabel('PDF 第 1 页').locator('canvas')).toBeVisible();
  await frame.getByRole('region', { name: 'PDF 连续阅读' }).hover();
  const distance = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!.contentDocument!;
    const region = doc.querySelector('[aria-label="PDF 连续阅读"]')!.getBoundingClientRect();
    const second = doc.querySelector('[aria-label="PDF 第 2 页"]')!.getBoundingClientRect();
    return second.top - region.top + Math.min(second.height, region.height) / 2 - region.height / 2;
  });
  for (let gesture = 0; gesture < 3; gesture += 1) {
    const region = frame.getByRole('region', { name: 'PDF 连续阅读' });
    const before = await region.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, distance / 3);
    await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
  }
  try { await expect(frame.getByText('2 / 3', { exact: true })).toBeVisible(); }
  finally {
    await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'wheel-diagnostic.json'), JSON.stringify(await page.evaluate(distance => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!;
      const doc = frame.contentDocument!;
      const region = doc.querySelector('[aria-label="PDF 连续阅读"]')!;
      return { distance, scrollTop: region.scrollTop, height: region.clientHeight, viewport: innerHeight,
        toolbar: doc.querySelector('[role="toolbar"]')!.textContent, frame: frame.getBoundingClientRect().toJSON(),
        pages: Array.from(doc.querySelectorAll('.feed-reader-page')).map(el => ({ offset: (el as HTMLElement).offsetTop, height: el.clientHeight })) };
    }, distance), null, 2));
  }
  await frame.getByRole('button', { name: '上一页' }).click();
  await expect(frame.getByText('1 / 3', { exact: true })).toBeVisible();
  await frame.getByLabel('PDF 第 1 页').getByRole('link').click();
  await expect(frame.getByText('3 / 3', { exact: true })).toBeVisible();
  const width = (await frame.getByLabel('PDF 第 3 页').boundingBox())!.width;
  await frame.getByRole('button', { name: '放大' }).click();
  await expect.poll(async () => (await frame.getByLabel('PDF 第 3 页').boundingBox())!.width).toBeGreaterThan(width);
  const downloadPending = page.waitForEvent('download');
  await frame.getByRole('link', { name: '下载', exact: true }).click();
  const download = await downloadPending;
  const manifest = await control('reading-manifest') as { currentPdfSha256: string };
  expect(hash(await readFile((await download.path())!))).toBe(manifest.currentPdfSha256);
  await page.getByRole('link', { name: '网页快照', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'FEED02 PDF 当前版本快照' })).toBeVisible();
  await expect(page.locator('script,form,[onclick]')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.frameLocator('iframe').getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible();
  await page.goBack();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => localStorage.setItem('cqu-moe-theme', value), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const reader = `/reader/${pdfId}/revisions/${revision}/attachment-1.pdf`;
  await control('remove-reading-object', { kind: 'current-pdf' });
  await page.goto(appUrl(reader));
  await expect(page.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible();
  await control('restore-reading-object', { kind: 'current-pdf' });
  await page.getByRole('button', { name: '重试预览' }).click();
  await expect(page.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible();
  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: false, limit: 3 });
  const statuses = await page.evaluate(async ({ webId, pdfId, revision }) => Promise.all([
    `/api/articles/${webId}`, `/api/articles/${pdfId}/revisions/${revision}/files/attachment-1.pdf`,
    `/api/articles/${pdfId}/revisions/${revision}/snapshot`,
  ].map(async path => (await fetch(path, { cache: 'no-store' })).status)), { webId, pdfId, revision });
  expect(statuses).toEqual([403, 403, 403]);
  await page.reload();
  await expect(page).toHaveURL(/\/access\?returnTo=/);
  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: true, limit: 3 });
  await page.reload();
  await expect(page.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible();
});
