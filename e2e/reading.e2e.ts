import { beforeEach, afterEach, test } from './test-api';
import type { Browser } from './test-api';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from './test-api';
import { apiFetch, control, login } from './support';

const webArticleId = 'e2e000000000000000000002';
const webCurrentRevisionId = 'e2e000000000000000000022';
const webOldRevisionId = 'e2e000000000000000000012';
const webUnreadyRevisionId = 'e2e000000000000000000032';
const pdfArticleId = 'e2e000000000000000000003';
const pdfCurrentRevisionId = 'e2e000000000000000000023';

let unexpected: string[];
let clientIpSequence = 100;

beforeEach(async ({ browser }) => {
  unexpected = [];
  const clientIp = `192.0.2.${++clientIpSequence}`;
  const feed = new URL(process.env.FEED_E2E_APP_URL!);
  const auth = new URL(process.env.FEED_E2E_AUTH_URL!);
  await browser.route('**/*', async route => {
    const target = new URL(route.request.url);
    if (target.origin !== feed.origin && target.origin !== auth.origin) {
      unexpected.push(target.origin);
      await route.abort();
      return;
    }
    await route.continue(target.origin === auth.origin
      ? { headers: { ...route.request.headers, 'cf-connecting-ip': clientIp } }
      : {});
  });
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

test('FEED02 real archive search reading and PDF history', async ({ app, screen, browser }) => {
  await login(app, screen, browser, 'OWNER');
  await browser.evaluate(() => {
    localStorage.setItem('cqu-moe-theme', 'dark');
    return null;
  });
  await app.open('/');
  if (process.env.FEED_E2E_BREAK_ASSERTION === '1') {
    await expect(screen.getByRole('heading', '故意错误的阅读断言')).toBeVisible();
  }
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'dark');

  await screen.getByLabel('搜索通知').fill('FEED02 网页通知唯一关键词');
  await screen.getByLabel('搜索通知').press('Enter');
  await expect(screen.getByRole('heading', { level: 2, name: 'FEED02 网页通知（当前完整版本）' })).toBeVisible();
  await expect(screen.getByRole('link', '统一阅读')).toHaveCount(1);
  await screen.getByRole('link', '统一阅读').click();
  await expect(screen.getByRole('heading', { level: 1, name: 'FEED02 网页通知（当前完整版本）' })).toBeVisible();
  await expect(screen.getByText('这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。')).toBeVisible();
  await expect(screen.getByText('新版本暂未就绪')).toBeVisible();

  const history = await apiFetch<{ revisions: Array<{ id: string; state: string; revisionNo: number }> }>(
    browser,
    `/api/articles/${webArticleId}/revisions`,
  );
  expect(history.status).toBe(200);
  expect(history.body.revisions.map(revision => [revision.revisionNo, revision.state])).toEqual([
    [3, 'blocked'],
    [2, 'ready'],
    [1, 'ready'],
  ]);
  const unready = await apiFetch<{
    article: { bodyText: string; snapshotUrl: null };
    attachments: Array<{ filename: string; bytes: null; contentType: null; status: string; error: string; url: null; downloadUrl: null }>;
  }>(
    browser,
    `/api/articles/${webArticleId}/revisions/${webUnreadyRevisionId}`,
  );
  expect(unready.status).toBe(200);
  expect(unready.body.article.bodyText).toBe('');
  expect(unready.body.article.snapshotUrl).toBeNull();
  expect(unready.body.attachments).toHaveLength(1);
  expect(unready.body.attachments[0]).toEqual({
    id: `${webUnreadyRevisionId}:attachment-1`,
    name: '未完成申请表.doc',
    filename: 'attachment-5.doc',
    bytes: null,
    contentType: null,
    status: 'pending',
    error: 'attachment_missing',
    role: 'attachment',
    originalUrl: 'https://jwc.cqu.edu.cn/files/feed02-unready.doc',
    url: null,
    downloadUrl: null,
  });

  const currentDocUrl = await screen.getByRole('link', '当前申请表.doc').getAttribute('href');
  const currentDocResponse = await rawFetch(browser, currentDocUrl!, 'HEAD');
  const currentDoc = await browser.waitForDownload(() => screen.getByRole('link', '当前申请表.doc').click());
  await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'download-response.json'), JSON.stringify({
    status: currentDocResponse.status,
    contentDisposition: currentDocResponse.headers['content-disposition'] ?? null,
    contentType: currentDocResponse.headers['content-type'] ?? null,
    suggestedFilename: currentDoc.suggestedFilename,
    sha256: sha256(await readFile(currentDoc.absolutePath)),
  }, null, 2));
  expect(currentDoc.suggestedFilename).toBe('当前申请表.doc');
  const currentDocBytes = await readFile(currentDoc.absolutePath);
  expect(currentDocBytes.toString('utf8')).toBe('FEED02 current ordinary attachment');

  await screen.getByRole('button', '历史版本').focus();
  await screen.getByRole('button', '历史版本').press('Enter');
  await expect(screen.getByRole('button', '查看版本').first()).toBeDisabled();
  await screen.getByRole('button', { name: '查看版本' }).last().click();
  await expect(screen.getByRole('heading', { level: 1, name: 'FEED02 网页通知（历史完整版本）' })).toBeVisible();
  await expect(screen.getByText('这是历史完整网页正文，附件与快照均属于旧版本。')).toBeVisible();
  const oldDoc = await browser.waitForDownload(() => screen.getByRole('link', '历史申请表.doc').click());
  expect((await readFile(oldDoc.absolutePath)).toString('utf8')).toBe('FEED02 old ordinary attachment');
  await expect(screen.getByRole('link', '网页快照')).toHaveAttribute('href', `/api/articles/${webArticleId}/revisions/${webOldRevisionId}/snapshot`);
  await screen.getByRole('link', '网页快照').press('Enter');
  await expect(screen.getByText('旧版本快照')).toBeVisible();
  await browser.back();
  await expect(screen.getByText('这是历史完整网页正文，附件与快照均属于旧版本。')).toBeVisible();
  await expect(screen.getByRole('link', '当前申请表.doc')).toHaveCount(0);

  await screen.getByRole('button', '返回最新完整版本').click();
  await expect(screen.getByText('这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。')).toBeVisible();
  await expect(screen.getByRole('link', '网页快照')).toHaveAttribute('href', `/api/articles/${webArticleId}/revisions/${webCurrentRevisionId}/snapshot`);
  await screen.getByRole('link', '网页快照').press('Enter');
  await expect(screen.getByText('当前版本快照')).toBeVisible();
  await browser.back();
  const currentShot = await rawFetch(browser, `/api/articles/${webArticleId}/revisions/${webCurrentRevisionId}/screenshot`);
  const oldShot = await rawFetch(browser, `/api/articles/${webArticleId}/revisions/${webOldRevisionId}/screenshot`);
  const reading = await control('reading-manifest') as { currentScreenshotSha256: string; oldScreenshotSha256: string };
  expect([currentShot.status, oldShot.status]).toEqual([200, 200]);
  expect(sha256(Buffer.from(currentShot.bodyBase64, 'base64'))).toBe(reading.currentScreenshotSha256);
  expect(sha256(Buffer.from(oldShot.bodyBase64, 'base64'))).toBe(reading.oldScreenshotSha256);
  expect(currentShot.bodyBase64 === oldShot.bodyBase64).toBe(false);
  const screenshotPixels = await browser.evaluate(async (paths: string[]) => {
    const pixels = [];
    for (const path of paths) {
      const image = new Image(); image.src = path; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      pixels.push(Array.from(context.getImageData(0, 0, 1, 1).data));
    }
    return pixels;
  }, [`/api/articles/${webArticleId}/revisions/${webCurrentRevisionId}/screenshot`, `/api/articles/${webArticleId}/revisions/${webOldRevisionId}/screenshot`]);
  expect(screenshotPixels).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);


  await app.open('/');
  await screen.getByLabel('搜索通知').fill('FEED02 分页存档资料');
  await screen.getByRole('button', '搜索').click();
  await expect(screen.getByText('共 22 条通知 · 第 1 / 2 页')).toBeVisible();
  await screen.getByRole('button', '下一页').click();
  await expect(browser).toHaveURL(/q=FEED02(?:%20|\+)%E5%88%86%E9%A1%B5%E5%AD%98%E6%A1%A3%E8%B5%84%E6%96%99&page=2/);
  await expect(screen.getByText('共 22 条通知 · 第 2 / 2 页')).toBeVisible();
  await browser.back();
  await expect(browser).toHaveURL(/q=FEED02(?:%20|\+)%E5%88%86%E9%A1%B5%E5%AD%98%E6%A1%A3%E8%B5%84%E6%96%99$/);
  await expect(screen.getByText('共 22 条通知 · 第 1 / 2 页')).toBeVisible();
  await screen.getByRole('button', '清除筛选').click();

  await screen.getByLabel('通知来源').click();
  await screen.getByRole('option', '国际处').click();
  await expect(screen.getByRole('heading', { level: 2, name: 'FEED02 PDF 正文通知' })).toBeVisible();
  await expect(screen.getByRole('link', '统一阅读')).toHaveCount(1);
  await screen.getByRole('link', '统一阅读').click();
  const originalFrame = browser.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  await expect(originalFrame.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(screen.getByText('这是可搜索的正文文字，但默认阅读仍应打开原件。')).toHaveCount(0);
  await originalFrame.getByRole('region', 'PDF 连续阅读').hover();
  const wheelDistance = await browser.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!.contentDocument!;
    const region = doc.querySelector('[aria-label="PDF 连续阅读"]')!.getBoundingClientRect();
    const page = doc.querySelector('[aria-label="PDF 第 2 页"]')!.getBoundingClientRect();
    return page.top - region.top + Math.min(page.height, region.height) / 2 - region.height / 2;
  });
  try {
    // Firefox bounds one large wheel event to roughly one scrollport. Use
    // three actual gestures for native engines; never set scrollTop or retry.
    const gestures = process.env.FEED_E2E_CROSS_BROWSER === '1' ? 3 : 1;
    const motion: Array<{ before: number; after: number; requested: number }> = [];
    const scrollTop = () => browser.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!
      .contentDocument!.querySelector('[aria-label="PDF 连续阅读"]')!.scrollTop);
    for (let gesture = 0; gesture < gestures; gesture++) {
      const before = gestures > 1 ? await scrollTop() : 0;
      await browser.mouse.wheel(0, wheelDistance / gestures);
      if (gestures > 1) {
        await expect.poll(scrollTop).toBeGreaterThan(before);
        motion.push({ before, after: await scrollTop(), requested: wheelDistance / gestures });
        await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'wheel-input-evidence.json'), JSON.stringify({ wheelDistance, motion }, null, 2));
      }
    }
    await expect(originalFrame.getByText('2 / 3')).toBeVisible();
  } catch (error) {
    try {
      const observed = await browser.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!;
        const doc = frame.contentDocument!, region = doc.querySelector('[aria-label="PDF 连续阅读"]')!;
        return { scrollTop: region.scrollTop, height: region.clientHeight, scrollHeight: region.scrollHeight,
          activePage: new URL(frame.contentWindow!.location.href).searchParams.get('page'),
          pages: Array.from(doc.querySelectorAll('.feed-reader-page')).map(page => ({ top: (page as HTMLElement).offsetTop, height: page.clientHeight })) };
      });
      await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'wheel-failure-evidence.json'), JSON.stringify({ wheelDistance, observed }, null, 2));
    } catch (captureError) { throw new AggregateError([error, captureError], 'PDF wheel assertion and observation both failed', { cause: error }); }
    throw error;
  }
  await expect.poll(() => readerGeometry(browser)).toMatchObject({ page: 2, inScrollport: true, painted: true });
  await originalFrame.getByRole('button', { name: '上一页' }).click();
  await expect(originalFrame.getByText('1 / 3')).toBeVisible();
  await expect.poll(() => readerGeometry(browser)).toMatchObject({ page: 1, inScrollport: true, painted: true });
  const beforeInternalLink = await readerGeometry(browser);
  await originalFrame.getByLabel('PDF 第 1 页').getByRole('link').click();
  await expect(originalFrame.getByText('3 / 3')).toBeVisible();
  await expect(originalFrame.getByLabel('PDF 第 3 页')).toBeVisible();
  await expect.poll(() => readerGeometry(browser)).toMatchObject({ page: 3, inScrollport: true, painted: true });
  const beforeZoom = await readerGeometry(browser);
  await originalFrame.getByRole('button', { name: '放大' }).click();
  await expect.poll(async () => (await readerGeometry(browser)).width).toBeGreaterThan(beforeZoom.width);
  await expect(originalFrame.getByText('3 / 3')).toBeVisible();
  const afterZoom = await readerGeometry(browser);

  const ordinaryFrame = browser.frameLocator('iframe[title="普通附件.pdf PDF 预览"]');
  await expect(ordinaryFrame.getByText('ORDINARY ATTACHMENT PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });

  const manifest = await control('reading-manifest') as {
    currentPdfSha256: string;
    currentPdfByteSize: number;
    oldPdfSha256: string;
    ordinaryPdfSha256: string;
  };
  const original = await browser.waitForDownload(() => originalFrame.getByRole('link', '下载').click());
  expect(sha256(await readFile(original.absolutePath))).toBe(manifest.currentPdfSha256);
  const ordinary = await browser.waitForDownload(() => screen.getByRole('link', '普通附件.pdf').click());
  expect(sha256(await readFile(ordinary.absolutePath))).toBe(manifest.ordinaryPdfSha256);

  await screen.getByRole('button', '历史版本').click();
  await screen.getByRole('button', { name: '查看版本' }).last().click();
  const oldOriginalFrame = browser.frameLocator('iframe[title="历史通知原件.pdf PDF 预览"]');
  await expect(oldOriginalFrame.getByText('OLD PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });
  const oldOriginal = await browser.waitForDownload(() => oldOriginalFrame.getByRole('link', '下载').click());
  expect(sha256(await readFile(oldOriginal.absolutePath))).toBe(manifest.oldPdfSha256);
  await screen.getByRole('button', '返回最新完整版本').click();
  await expect(originalFrame.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });

  const snapshot = await rawFetch(browser, `/api/articles/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/snapshot`);
  expect(snapshot.status).toBe(200);
  expect(snapshot.text).toContain('FEED02 PDF 当前版本快照');
  expect(snapshot.headers['content-security-policy']).toContain("script-src 'none'");
  await screen.getByRole('link', '网页快照').focus();
  await expect(screen.getByRole('link', '网页快照')).toBeFocused();
  await screen.getByRole('link', '网页快照').press('Enter');
  await expect(screen.getByRole('heading', { name: 'FEED02 PDF 当前版本快照' })).toBeVisible();
  const snapshotDom = await browser.evaluate(() => ({
    scripts: document.querySelectorAll('script').length,
    forms: document.querySelectorAll('form').length,
    eventHandlers: Array.from(document.querySelectorAll('*')).filter(element => Array.from(element.attributes).some(attr => /^on/i.test(attr.name))).length,
    pdfFrames: Array.from(document.querySelectorAll('iframe')).map(frame => ({ src: frame.getAttribute('src'), title: frame.getAttribute('title') })),
  }));
  expect(snapshotDom.scripts).toBe(0);
  expect(snapshotDom.forms).toBe(0);
  expect(snapshotDom.eventHandlers).toBe(0);
  expect(snapshotDom.pdfFrames).toEqual([
    { src: `/reader/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/attachment-1.pdf`, title: '已存档的 PDF' },
  ]);
  await expect(browser.frameLocator('iframe[title="已存档的 PDF"]').getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });
  await browser.back();
  await expect(screen.getByRole('heading', { level: 1, name: 'FEED02 PDF 正文通知' })).toBeVisible();

  const file = `/api/articles/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/files/attachment-1.pdf`;
  const head = await rawFetch(browser, file, 'HEAD');
  expect(head.status).toBe(200);
  expect(head.headers['accept-ranges']).toBe('bytes');
  expect(head.headers['content-length']).toBe(String(manifest.currentPdfByteSize));
  const range = await rawFetch(browser, file, 'GET', { range: 'bytes=0-9' });
  expect(range.status).toBe(206);
  expect(range.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
  expect(range.bodyBase64).toBe(Buffer.from('%PDF-1.4\n1').toString('base64'));
  const invalidRange = await rawFetch(browser, file, 'GET', { range: 'bytes=999999-' });
  expect(invalidRange.status).toBe(416);
  expect(invalidRange.headers['content-range']).toMatch(/^bytes \*\/\d+$/);

  await browser.evaluate(() => {
    localStorage.setItem('cqu-moe-theme', 'light');
    return null;
  });
  await browser.reload();
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(originalFrame.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });
  await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'reading-evidence.json'), JSON.stringify({
    currentPdfSha256: sha256(await readFile(original.absolutePath)),
    oldPdfSha256: sha256(await readFile(oldOriginal.absolutePath)),
    ordinaryPdfSha256: sha256(await readFile(ordinary.absolutePath)),
    currentScreenshotSha256: sha256(Buffer.from(currentShot.bodyBase64, 'base64')),
    oldScreenshotSha256: sha256(Buffer.from(oldShot.bodyBase64, 'base64')),
    beforeInternalLink, beforeZoom, afterZoom, snapshotDom, screenshotPixels,
    head: { status: head.status, byteSize: head.headers['content-length'] },
    range: { status: range.status, contentRange: range.headers['content-range'], bodyBase64: range.bodyBase64 },
    invalidRange: { status: invalidRange.status, contentRange: invalidRange.headers['content-range'] },
    themes: ['dark', 'light'], keyboardSnapshotRoundTrip: true,
  }, null, 2));
});

test('FEED02 archive failures recover without fake content and denial is immediate', async ({ app, screen, browser }) => {
  await login(app, screen, browser, 'OWNER');

  await control('remove-reading-object', { kind: 'web-body' });
  await app.open(`/articles/${webArticleId}`);
  await expect(screen.getByText('暂时无法加载通知')).toBeVisible();
  await expect(screen.getByText('这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。')).toHaveCount(0);
  await control('restore-reading-object', { kind: 'web-body' });
  await screen.getByRole('button', '重新加载').click();
  await expect(screen.getByText('这是当前完整网页正文，包含 FEED02 网页通知唯一关键词。')).toBeVisible();

  const readerPath = `/reader/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/attachment-1.pdf`;
  await control('remove-reading-object', { kind: 'current-pdf' });
  await app.open(readerPath);
  await expect(screen.getByRole('heading', 'PDF 暂时无法预览')).toBeVisible();
  await expect(screen.getByRole('link', '下载 PDF')).toBeVisible();
  await control('restore-reading-object', { kind: 'current-pdf' });
  await screen.getByRole('button', '重试预览').click();
  await expect(screen.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });

  await browser.addInitScript(`(() => {
    if (sessionStorage.getItem('feed02-canvas-fault-injected') === '1') return;
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.isConnected && this.canvas.width > 100) {
        CanvasRenderingContext2D.prototype.fillRect = fillRect;
        sessionStorage.setItem('feed02-canvas-fault-injected', '1');
        throw new Error('Browser canvas drawing temporarily unavailable');
      }
      return fillRect.apply(this, args);
    };
  })();`);
  // Keep the real URL-change session read pending across download navigation.
  let sessionReads = 0;
  let sessionHeld = false;
  let resumeSession!: () => void;
  const pendingSession = new Promise<void>(resolve => { resumeSession = resolve; });
  await browser.route(`${process.env.FEED_E2E_APP_URL}/api/session`, async route => {
    if (++sessionReads === 2) { sessionHeld = true; await pendingSession; }
    await route.continue();
  });
  let failedDrawDownload: Awaited<ReturnType<Browser['waitForDownload']>>;
  try {
    await app.open(readerPath);
    await expect(screen.getByRole('heading', 'PDF 页面暂时无法呈现')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sessionHeld).toBe(true);
    failedDrawDownload = await browser.waitForDownload(() => screen.getByRole('link', '下载 PDF').click());
  } finally { resumeSession(); }
  await expect(screen.getByRole('button', '重试预览')).toBeVisible();
  const manifest = await control('reading-manifest') as { currentPdfSha256: string };
  expect(sha256(await readFile(failedDrawDownload.absolutePath))).toBe(manifest.currentPdfSha256);
  await screen.getByRole('button', '重试预览').click();
  await expect(screen.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });

  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: false, limit: 3 });
  const deniedDetail = await rawFetch(browser, `/api/articles/${webArticleId}`);
  const deniedFile = await rawFetch(browser, `/api/articles/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/files/attachment-1.pdf`);
  const deniedSnapshot = await rawFetch(browser, `/api/articles/${pdfArticleId}/revisions/${pdfCurrentRevisionId}/snapshot`);
  expect([deniedDetail.status, deniedFile.status, deniedSnapshot.status]).toEqual([403, 403, 403]);
  await browser.reload();
  await expect(browser).toHaveURL(/\/access\?returnTo=/);
  await control('set-entitlements', { userId: process.env.FEED_E2E_OWNER_ID, access: true, limit: 3 });
  await browser.reload();
  await expect(screen.getByText('REAL PDF PAGE ONE', { exact: true })).toBeVisible({ timeout: 15000 });
  await writeFile(join(process.env.FEED_E2E_OUTPUT!, 'reading-failure-evidence.json'), JSON.stringify({
    revokedStatuses: [deniedDetail.status, deniedFile.status, deniedSnapshot.status],
    drawFailureDownloadSha256: sha256(await readFile(failedDrawDownload.absolutePath)),
    detailRecovered: true, missingFileRecovered: true, canvasRecovered: true, reauthorizationRecovered: true,
  }, null, 2));
});

async function rawFetch(
  browser: Browser,
  path: string,
  method: 'GET' | 'HEAD' = 'GET',
  headers: Record<string, string> = {},
) {
  const payload = await browser.evaluate(async (input: { path: string; method: 'GET' | 'HEAD'; headers: Record<string, string> }) => {
    const response = await fetch(input.path, { method: input.method, headers: input.headers, cache: 'no-store' });
    const bytes = await response.arrayBuffer();
    let bodyBase64 = '';
    const body = new Uint8Array(bytes);
    for (let index = 0; index < body.length; index += 1) bodyBase64 += String.fromCharCode(body[index]!);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return JSON.stringify({
      status: response.status,
      headers,
      bodyBase64: btoa(bodyBase64),
      text: input.method === 'HEAD' ? '' : new TextDecoder().decode(bytes),
    });
  }, { path, method, headers });
  return JSON.parse(payload) as { status: number; headers: Record<string, string>; bodyBase64: string; text: string };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readerGeometry(browser: Browser) {
  return browser.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="通知原件.pdf PDF 预览"]')!;
    const doc = frame.contentDocument!;
    const page = Number(new URL(frame.contentWindow!.location.href).searchParams.get('page'));
    const region = doc.querySelector('[aria-label="PDF 连续阅读"]')!.getBoundingClientRect();
    const sheet = doc.querySelector(`[aria-label="PDF 第 ${page} 页"]`)!;
    const box = sheet.getBoundingClientRect();
    const canvas = sheet.querySelector('canvas');
    const pixels = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasInk = false;
    if (pixels) for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 200 && pixels[i + 1]! < 200 && pixels[i + 2]! < 200 && pixels[i + 3]! > 0) { hasInk = true; break; }
    }
    return { page, width: box.width, inScrollport: box.top < region.bottom && box.bottom > region.top, painted: hasInk };
  });
}
