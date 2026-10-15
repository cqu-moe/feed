import {
  articleId,
  expect,
  installReadingRoutes,
  makePdf,
  oldRevisionId,
  readingDetail,
  revisionId,
  test,
} from './fixtures';
import type { FrameLocator, Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });

function mixedLongPdf() {
  return makePdf(Array.from({ length: 120 }, (_, index) => ({
    width: index % 2 === 0 ? 612 : 792,
    height: index % 2 === 0 ? 792 : 612,
    text: `LONG PAGE ${index + 1}`,
  })));
}

function selfLinkPdf() {
  const pdf = makePdf([
    { text: 'SELF LINK PAGE ONE' },
    { text: 'SELF LINK PAGE TWO' },
  ]);
  return Buffer.from(pdf.toString('latin1').replace('[6 0 R /Fit]', '[4 0 R /Fit]'));
}

test('continuous wheel reading crosses mixed-size pages and keeps the URL in sync', async ({ page }) => {
  await installReadingRoutes(page, {
    kind: 'pdf',
    pdf: makePdf([
      { width: 612, height: 792, text: 'MIXED PAGE ONE' },
      { width: 792, height: 612, text: 'MIXED PAGE TWO' },
    ]),
  });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByText('MIXED PAGE ONE')).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('1 / 2')).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);

  await page.mouse.move(640, 420);
  for (let wheel = 0; wheel < 3; wheel += 1) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('MIXED PAGE TWO')).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page).toHaveURL(/\/attachment-1\.pdf\?page=2$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await page.mouse.move(1000, 650);
  for (let wheel = 0; wheel < 12; wheel += 1) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('MIXED PAGE ONE')).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('1 / 2')).toBeVisible();
  await expect(page).toHaveURL(/\/attachment-1\.pdf\?page=1$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('MIXED PAGE TWO')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=2$/);
  await page.mouse.move(1000, 650);
  for (let wheel = 0; wheel < 12; wheel += 1) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('MIXED PAGE ONE')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=1$/);
  for (let wheel = 0; wheel < 3; wheel += 1) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('MIXED PAGE TWO')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=2$/);
});

test('a same-page internal link does not leave page synchronization suppressed', async ({ page }) => {
  await installReadingRoutes(page, { kind: 'pdf', pdf: selfLinkPdf() });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=1`);
  await expect(page.getByText('SELF LINK PAGE ONE', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await page.waitForTimeout(100);
  await page.getByLabel('PDF 第 1 页').getByRole('link').click();
  await expect(page.getByText('1 / 2')).toBeVisible();
  await expect(page).toHaveURL(/page=1$/);

  await page.mouse.move(640, 420);
  for (let wheel = 0; wheel < 3; wheel += 1) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('SELF LINK PAGE TWO', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=2$/);

  await page.mouse.move(1000, 650);
  for (let wheel = 0; wheel < 12; wheel += 1) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(50);
  }
  await expect(page.getByText('SELF LINK PAGE ONE', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=1$/);
});

test('a long mixed-size document renders a bounded page window and follows internal links', async ({ page }) => {
  await installReadingRoutes(page, { kind: 'pdf', pdf: mixedLongPdf() });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=117`);
  await expect(page.getByText('117 / 120')).toBeVisible();
  await expect(page.getByText('LONG PAGE 117', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('第 1 页')).not.toBeInViewport();

  const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
  expect(canvasCount).toBeGreaterThan(0);
  expect(canvasCount).toBeLessThanOrEqual(8);

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=50`);
  await expect(page.getByText('50 / 120')).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBeLessThanOrEqual(8);

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=1`);
  await expect(page.getByText('1 / 120')).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBeLessThanOrEqual(8);

  const portrait = await page.getByLabel('PDF 第 1 页').boundingBox();
  const landscape = await page.getByLabel('PDF 第 2 页').boundingBox();
  expect(portrait).toBeTruthy();
  expect(landscape).toBeTruthy();
  expect(landscape!.height / portrait!.height).toBeCloseTo(612 ** 2 / 792 ** 2, 2);

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByText('LONG PAGE 1', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await page.getByLabel('PDF 第 1 页').getByRole('link').click();
  await expect(page.getByText('120 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 120 页')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=120$/);
});

test('zoom and window resizing keep the reading anchor inside the reader', async ({ page }) => {
  await installReadingRoutes(page, { kind: 'pdf', pdf: makePdf() });
  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByText('PDF PAGE 1', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await page.mouse.move(640, 360);
  for (let wheel = 0; wheel < 5; wheel += 1) {
    await page.mouse.wheel(0, 160);
    await page.waitForTimeout(20);
  }
  await expect(page.getByText('1 / 2')).toBeVisible();
  const reader = page.getByRole('region', { name: 'PDF 连续阅读' });
  const firstPage = page.getByLabel('PDF 第 1 页');
  async function readingPosition() {
    const readerBox = await reader.boundingBox();
    const pageBox = await firstPage.boundingBox();
    if (!readerBox || !pageBox) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      (readerBox.x + readerBox.width / 2 - pageBox.x) / pageBox.width,
      (readerBox.y + readerBox.height / 2 - pageBox.y) / pageBox.height,
    );
  }

  const beforeZoom = await readingPosition();
  await page.getByRole('button', { name: '放大' }).click();
  await expect(firstPage).toBeInViewport({ ratio: 0.2 });
  expect(Math.abs(await readingPosition() - beforeZoom)).toBeLessThan(0.04);

  const beforeResize = await readingPosition();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(firstPage).toBeInViewport({ ratio: 0.2 });
  expect(Math.abs(await readingPosition() - beforeResize)).toBeLessThan(0.04);
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageOverflow).toBe(0);
});

test('page deep links normalize safely, support browser history, refresh, and original download', async ({ page }) => {
  const pdf = mixedLongPdf();
  await installReadingRoutes(page, { kind: 'pdf', pdf });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=999`);
  await expect(page.getByText('120 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 120 页')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=120$/);

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf?page=broken`);
  await expect(page.getByText('1 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页')).toBeInViewport({ ratio: 0.2 });

  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('2 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 2 页')).toBeInViewport({ ratio: 0.2 });
  expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(historyLength);

  await page.goBack();
  await expect(page.getByText('1 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页')).toBeInViewport({ ratio: 0.2 });
  await expect(page).toHaveURL(/page=1$/);

  await page.reload();
  await expect(page.getByText('1 / 120')).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页')).toBeInViewport({ ratio: 0.2 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('attachment-1.pdf');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect((await readFile(downloadPath!)).length).toBe(pdf.length);
});

test('every existing PDF entry reuses continuous reader behavior', async ({ page }) => {
  const bodyPdf = makePdf(3);
  const ordinaryPdf = makePdf([
    { text: 'ORDINARY ATTACHMENT PAGE ONE' },
    { text: 'ORDINARY ATTACHMENT PAGE TWO' },
    { text: 'ORDINARY ATTACHMENT PAGE THREE' },
  ]);
  const detail = readingDetail('pdf');
  const ordinaryAttachment = {
    ...detail.attachments[1],
    name: '普通PDF附件.pdf',
    filename: 'attachment-2.pdf',
    contentType: 'application/pdf',
    bytes: ordinaryPdf.length,
    url: detail.attachments[1].url.replace('attachment-2.doc', 'attachment-2.pdf'),
    downloadUrl: detail.attachments[1].downloadUrl.replace('attachment-2.doc', 'attachment-2.pdf'),
  };
  detail.attachments[1] = ordinaryAttachment;
  await installReadingRoutes(page, {
    detail,
    pdf: bodyPdf,
    files: {
      [detail.attachments[0].url]: bodyPdf,
      [ordinaryAttachment.url]: ordinaryPdf,
    },
  });

  async function readAcross(scrollSurface: Locator, reader: Locator | FrameLocator) {
    await scrollSurface.scrollIntoViewIfNeeded();
    await scrollSurface.hover();
    for (let wheel = 0; wheel < 24; wheel += 1) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(100);
      if (await reader.getByText('2 / 3').isVisible()) break;
    }
    const visiblePageRatio = await reader.getByLabel('PDF 第 2 页').evaluate(element => {
      const box = element.getBoundingClientRect();
      const overlap = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
      return Math.max(0, overlap) / box.height;
    });
    expect(visiblePageRatio).toBeGreaterThan(0.1);
    await expect(reader.getByText('2 / 3')).toBeVisible();
  }

  await page.goto(`/articles/${articleId}`);
  const detailFrame = page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  const ordinaryFrame = page.frameLocator('iframe[title="普通PDF附件.pdf PDF 预览"]');
  await expect(detailFrame.getByText('PDF PAGE 1', { exact: true })).toBeVisible();
  await expect(ordinaryFrame.getByText('ORDINARY ATTACHMENT PAGE ONE', { exact: true })).toBeVisible();
  await readAcross(page.locator('iframe[title="通知原件.pdf PDF 预览"]'), detailFrame);
  await readAcross(
    page.locator('iframe[title="普通PDF附件.pdf PDF 预览"]'),
    ordinaryFrame,
  );

  await page.goto(`/api/articles/${articleId}/revisions/${revisionId}/snapshot`);
  const snapshotFrame = page.frameLocator('iframe[title="快照中的 PDF"]');
  await readAcross(page.locator('iframe[title="快照中的 PDF"]'), snapshotFrame);

  await page.goto(`/reader/${articleId}/revisions/${oldRevisionId}/attachment-1.pdf`);
  await expect(page.getByText('1 / 3')).toBeVisible();
  await readAcross(page.getByRole('region', { name: 'PDF 连续阅读' }), page.locator('main'));

  await page.goto(`/reader/${articleId}/attachment-1.pdf`);
  await expect(page.getByText('1 / 3')).toBeVisible();
  await readAcross(page.getByRole('region', { name: 'PDF 连续阅读' }), page.locator('main'));
});

test('a missing PDF can be retried after storage recovery', async ({ page }) => {
  const pdf = makePdf(2);
  await installReadingRoutes(page, { kind: 'pdf', pdf });
  let fileAttempts = 0;
  await page.route('**/api/articles/**/revisions/**/files/attachment-1.pdf**', async route => {
    fileAttempts += 1;
    if (fileAttempts === 1) {
      return route.fulfill({
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
        json: { error: 'file missing' },
      });
    }
    return route.fulfill({
      contentType: 'application/pdf',
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="attachment-1.pdf"',
      },
      body: pdf,
    });
  });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible();
  await expect(page.getByText('PDF 文件不存在或暂时不可用，请重试预览。')).toBeVisible();

  const retry = page.getByRole('button', { name: '重试预览' });
  await expect.poll(() => retry.count()).toBe(1);
  const recoveredFile = page.waitForResponse(response => response.url().includes('/files/attachment-1.pdf') && response.status() === 200);
  await retry.click();
  expect((await recoveredFile).status()).toBe(200);
  await expect(page.getByText('PDF PAGE 1', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('1 / 2')).toBeVisible();
  expect(fileAttempts).toBe(2);
});

test('a corrupt PDF reports parsing failure and can be retried after replacement', async ({ page }) => {
  const pdf = makePdf(2);
  await installReadingRoutes(page, { kind: 'pdf', pdf });
  let fileAttempts = 0;
  await page.route('**/api/articles/**/revisions/**/files/attachment-1.pdf**', async route => {
    fileAttempts += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="attachment-1.pdf"',
      },
      body: fileAttempts === 1 ? Buffer.from('this is not a valid PDF') : pdf,
    });
  });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible();
  await expect(page.getByText('PDF 文件已损坏或无法解析，请重试预览。')).toBeVisible();

  const retry = page.getByRole('button', { name: '重试预览' });
  await expect.poll(() => retry.count()).toBe(1);
  const recoveredFile = page.waitForResponse(response => response.url().includes('/files/attachment-1.pdf') && response.status() === 200);
  await retry.click();
  expect((await recoveredFile).status()).toBe(200);
  await expect(page.getByText('PDF PAGE 1', { exact: true })).toBeInViewport({ ratio: 0.2 });
  expect(fileAttempts).toBe(2);
});

test('file denial after a valid session gives distinct recovery feedback', async ({ page }) => {
  const pdf = makePdf(2);
  await installReadingRoutes(page, { kind: 'pdf', pdf, authenticated: true, entitled: true });
  let status = 401;
  await page.route('**/api/articles/**/revisions/**/files/attachment-1.pdf**', async route => {
    return route.fulfill({
      status,
      headers: { 'Cache-Control': 'no-store' },
      json: { error: status === 401 ? 'session expired' : 'access denied' },
    });
  });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible();
  await expect(page.getByText('文件会话已失效，请重新登录后再打开此 PDF。')).toBeVisible();

  status = 403;
  const retry = page.getByRole('button', { name: '重试预览' });
  await expect.poll(() => retry.count()).toBe(1);
  const deniedFile = page.waitForResponse(response => response.url().includes('/files/attachment-1.pdf') && response.status() === 403);
  await retry.click();
  expect((await deniedFile).status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible();
  await expect(page.getByText('当前访问权益不允许读取此 PDF。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试预览' })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载 PDF' })).toBeVisible();
});

test('narrow dark-mode readers support selectable text and keyboard scrolling', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cqu-moe-theme', 'dark'));
  await page.setViewportSize({ width: 320, height: 640 });
  await installReadingRoutes(page, {
    kind: 'pdf',
    pdf: makePdf([
      { text: 'SELECTABLE KEYBOARD PAGE ONE' },
      { text: 'SELECTABLE KEYBOARD PAGE TWO' },
    ]),
  });

  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('SELECTABLE KEYBOARD PAGE ONE', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await page.getByText('SELECTABLE KEYBOARD PAGE ONE', { exact: true }).selectText();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('SELECTABLE KEYBOARD PAGE ONE');

  const reader = page.getByRole('region', { name: 'PDF 连续阅读' });
  await reader.focus();
  await page.keyboard.press('PageDown');
  await expect(page.getByText('SELECTABLE KEYBOARD PAGE TWO', { exact: true })).toBeInViewport({ ratio: 0.2 });
  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page).toHaveURL(/page=2$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
