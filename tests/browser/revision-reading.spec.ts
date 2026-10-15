import { readFile } from 'node:fs/promises';
import {
  articleId,
  expect,
  installReadingRoutes,
  makePdf,
  oldRevisionId,
  readingDetail,
  revisionId,
  test,
  unreadyRevisionId,
} from './fixtures';

function pathname(value: string | null | undefined): string {
  return new URL(value ?? '', 'https://feed.test').pathname;
}

test('a reader can trace the loaded current and historical version snapshot', async ({ page }) => {
  const currentOriginal = makePdf([{ text: 'CURRENT SNAPSHOT JOURNEY ORIGINAL' }]);
  const oldOriginal = makePdf([{ text: 'OLD SNAPSHOT JOURNEY ORIGINAL' }]);
  const currentMaterial = Buffer.from('current-version-application.doc');
  const oldMaterial = Buffer.from('old-version-application.doc');
  const detail = readingDetail('pdf');
  const oldDetail = readingDetail('pdf', oldRevisionId);
  detail.attachments[0].bytes = currentOriginal.length;
  detail.attachments[1].bytes = currentMaterial.length;
  oldDetail.attachments[0] = {
    ...oldDetail.attachments[0],
    filename: 'attachment-5.pdf',
    url: `/api/articles/${articleId}/revisions/${oldRevisionId}/files/attachment-5.pdf`,
    downloadUrl: `/api/articles/${articleId}/revisions/${oldRevisionId}/files/attachment-5.pdf?download=1`,
    bytes: oldOriginal.length,
  };
  oldDetail.attachments[1] = {
    ...oldDetail.attachments[1],
    name: '旧版申请表.doc',
    filename: 'attachment-6.doc',
    url: `/api/articles/${articleId}/revisions/${oldRevisionId}/files/attachment-6.doc`,
    downloadUrl: `/api/articles/${articleId}/revisions/${oldRevisionId}/files/attachment-6.doc?download=1`,
    bytes: oldMaterial.length,
  };

  await installReadingRoutes(page, {
    detail,
    oldDetail,
    files: {
      [pathname(detail.attachments[0].url)]: currentOriginal,
      [pathname(detail.attachments[1].downloadUrl)]: currentMaterial,
      [pathname(oldDetail.attachments[0].url)]: oldOriginal,
      [pathname(oldDetail.attachments[1].downloadUrl)]: oldMaterial,
    },
    snapshots: {
      [pathname(detail.article.snapshotUrl)]: '<!doctype html><meta charset="utf-8"><title>当前快照</title><main><h1>当前版本快照</h1></main>',
      [pathname(oldDetail.article.snapshotUrl)]: '<!doctype html><meta charset="utf-8"><title>历史快照</title><main><h1>历史版本快照</h1></main>',
    },
  });
  await page.goto(`/articles/${articleId}`);

  const currentSnapshot = page.getByRole('link', { name: '网页快照', exact: true });
  await expect(currentSnapshot).toBeVisible();
  await expect(currentSnapshot).not.toHaveAttribute('target');
  await expect(currentSnapshot.locator('svg')).toBeVisible();
  await expect(currentSnapshot).toHaveAttribute('href', detail.article.snapshotUrl);
  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('CURRENT SNAPSHOT JOURNEY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });

  await currentSnapshot.click();
  await expect(page).toHaveURL(pathname(detail.article.snapshotUrl));
  await expect(page.getByRole('heading', { name: '当前版本快照' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('CURRENT SNAPSHOT JOURNEY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: '历史版本' }).click();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  await expect(page.getByText(/正在阅读 .+ 的历史版本/)).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="历史通知原件.pdf PDF 预览"]').getByText('OLD SNAPSHOT JOURNEY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '旧版申请表.doc' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath, 'Playwright returned a download artifact').toBeTruthy();
  await expect(readFile(downloadPath!)).resolves.toEqual(oldMaterial);

  const oldSnapshot = page.getByRole('link', { name: '网页快照', exact: true });
  await expect(oldSnapshot).toHaveAttribute('href', oldDetail.article.snapshotUrl);
  await oldSnapshot.click();
  await expect(page.getByRole('heading', { name: '历史版本快照' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  const returnButton = page.getByRole('button', { name: '返回最新完整版本' });
  await returnButton.focus();
  await expect(returnButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('CURRENT SNAPSHOT JOURNEY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });
});

test('a web notice exposes its snapshot after text and keeps archive entries distinct', async ({ page }) => {
  const detail = readingDetail('html');
  const expectedSnapshot = detail.article.snapshotUrl;
  await installReadingRoutes(page, {
    detail,
    snapshots: {
      [pathname(expectedSnapshot)]: '<!doctype html><meta charset="utf-8"><title>网页快照</title><main><h1>网页通知快照</h1></main>',
    },
  });
  await page.goto(`/articles/${articleId}`);

  const textButton = page.getByRole('button', { name: '正文', exact: true });
  const snapshot = page.getByRole('link', { name: '网页快照', exact: true });
  await expect(textButton).toBeVisible();
  await expect(textButton).toHaveAttribute('aria-pressed', 'true');
  await expect(snapshot).toBeVisible();
  await expect(snapshot).toHaveAttribute('href', expectedSnapshot);
  const order = await page.evaluate(() => {
    const text = document.querySelector('.feed-reading-mode button');
    const snapshotLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'))
      .find(link => link.textContent?.includes('网页快照'));
    if (!text || !snapshotLink) return null;
    return Number(text.compareDocumentPosition(snapshotLink) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
  });
  expect(order).toBe(true);

  await snapshot.focus();
  await expect(snapshot).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '网页通知快照' })).toBeVisible();
  await page.goBack();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '存档信息', exact: true }).click();
  const archive = page.getByRole('dialog', { name: '存档信息' });
  await expect(archive.getByRole('link', { name: '原始通知' })).toHaveAttribute('href', detail.article.url);
  await expect(archive.getByRole('link', { name: '原貌存档' })).toHaveAttribute('href', expectedSnapshot);
  await expect(archive.getByRole('link', { name: '网页截图' })).toHaveAttribute(
    'href',
    `/api/articles/${articleId}/revisions/${revisionId}/screenshot`,
  );
});

test('a revision without a snapshot has no fake success link', async ({ page }) => {
  const detail = {
    ...readingDetail('html'),
    article: { ...readingDetail('html').article, snapshotUrl: null },
  } as unknown as ReturnType<typeof readingDetail>;
  await installReadingRoutes(page, { detail });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '存档信息', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '存档信息' }).getByRole('link', { name: '原貌存档' })).toHaveCount(0);
});

test('switching revisions preserves the loaded document until replacement and rejects stale responses', async ({ page }) => {
  const detail = readingDetail('html');
  const oldDetail = readingDetail('html', oldRevisionId);
  await installReadingRoutes(page, {
    detail,
    oldDetail,
    detailDelays: { [oldRevisionId]: 1200 },
  });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page).toHaveURL(new RegExp(`revision=${oldRevisionId}`));
  await expect(page.getByRole('status').and(page.getByText('正在切换通知版本…'))).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', detail.article.snapshotUrl);
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toHaveCount(0);

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByRole('status').and(page.getByText('正在切换通知版本…'))).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toHaveCount(0);
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', detail.article.snapshotUrl);
});

test('returning from historical to current preserves loaded identity while current loads', async ({ page }) => {
  const detail = readingDetail('html');
  const oldDetail = readingDetail('html', oldRevisionId);
  await installReadingRoutes(page, {
    detail,
    oldDetail,
    detailDelays: { [revisionId]: 1200 },
  });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toBeVisible();

  await page.getByRole('button', { name: '返回最新完整版本' }).click();
  await expect(page).not.toHaveURL(new RegExp(`revision=${oldRevisionId}`));
  await expect(page.getByRole('status').and(page.getByText('正在切换通知版本…'))).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  await expect(page.getByText('正在阅读 2026年10月11日 11:01 的历史版本')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', oldDetail.article.snapshotUrl);

  await page.getByRole('button', { name: '历史版本' }).click();
  const loadedOldRow = page.locator('.feed-history-list > li', {
    has: page.getByText('2026年10月11日 11:01 · 首次存档'),
  });
  await expect(loadedOldRow.getByRole('button', { name: '当前查看' })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看版本', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByText(/正在阅读 .+ 的历史版本/)).toHaveCount(0);
});

test('changing articles does not display the previous article while the new detail loads', async ({ page }) => {
  const currentDetail = readingDetail('html');
  await installReadingRoutes(page, { detail: currentDetail });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  const nextArticleId = 'd42a90333229c47e1c30158f';
  const nextDetail = readingDetail('html');
  nextDetail.article.id = nextArticleId;
  nextDetail.revision.articleId = nextArticleId;
  nextDetail.article.title = '下一篇独立通知';
  nextDetail.article.bodyText = '下一篇独立通知正文。';
  await page.route(`**/api/articles/${nextArticleId}`, async (route) => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    return route.fulfill({ status: 200, json: nextDetail });
  });
  await page.route(`**/api/articles/${nextArticleId}/revisions`, route => route.fulfill({
    status: 200,
    json: { revisions: [nextDetail.revision] },
  }));

  await page.goto(`/articles/${nextArticleId}`);
  await expect(page.getByRole('heading', { level: 1, name: currentDetail.article.title })).toHaveCount(0);
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toHaveCount(0);
  await expect(page.getByText('正在加载通知')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: nextDetail.article.title })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText('下一篇独立通知正文。')).toBeVisible();
});

test('retrying history preserves the loaded notice and its selected reading mode', async ({ page }) => {
  const original = makePdf([{ text: 'HISTORY RETRY ORIGINAL' }]);
  const detail = readingDetail('pdf');
  const oldDetail = readingDetail('pdf', oldRevisionId);
  detail.attachments[0].bytes = original.length;
  const detailUrls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/articles/${articleId}`) detailUrls.push(url.pathname);
  });
  await installReadingRoutes(page, {
    detail,
    oldDetail,
    files: {
      [pathname(detail.attachments[0].url)]: original,
    },
  });
  let historyAttempts = 0;
  await page.route(`**/api/articles/${articleId}/revisions`, async (route) => {
    historyAttempts += 1;
    if (historyAttempts === 1) {
      return route.fulfill({ status: 500, json: { error: 'history unavailable' } });
    }
    return route.fulfill({
      status: 200,
      json: { revisions: [detail.revision, oldDetail.revision] },
    });
  });
  await page.goto(`/articles/${articleId}`);

  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('HISTORY RETRY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '正文', exact: true }).click();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.locator('iframe[title="通知原件.pdf PDF 预览"]')).toHaveCount(0);

  await page.getByRole('button', { name: '历史版本' }).click();
  await expect(page.getByText('版本历史加载失败')).toBeVisible();
  const retry = page.getByRole('button', { name: '重试历史', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole('button', { name: /查看版本/ }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.locator('iframe[title="通知原件.pdf PDF 预览"]')).toHaveCount(0);
  expect(detailUrls).toEqual([`/api/articles/${articleId}`]);
});

test('history session expiry keeps the notice readable and offers login recovery', async ({ page }) => {
  await installReadingRoutes(page, { historyStatus: 401 });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  const sheet = page.getByRole('dialog', { name: '历史版本' });
  await expect(sheet.getByText('需要重新登录', { exact: true })).toBeVisible();
  await expect(sheet.getByText('版本历史需要重新登录后才能读取；当前正文仍可阅读。')).toBeVisible();
  await expect(sheet.getByRole('link', { name: '重新登录' })).toHaveAttribute('href', '/auth/login');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
});

test('history permission failure keeps the notice readable and explains access recovery', async ({ page }) => {
  await installReadingRoutes(page, { historyStatus: 403 });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  const sheet = page.getByRole('dialog', { name: '历史版本' });
  await expect(sheet.getByText('没有版本历史权限')).toBeVisible();
  await expect(sheet.getByText('当前账号缺少 feed.access 权益；已打开的通知仍可阅读。')).toBeVisible();
  await expect(sheet.getByRole('link', { name: '前往 auth.cqu.moe' })).toHaveAttribute(
    'href',
    'https://auth.cqu.moe/',
  );
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
});

test('an unready newer observation leaves the last complete version as the default read', async ({ page }) => {
  const detail = readingDetail('html');
  const oldDetail = readingDetail('html', oldRevisionId);
  const unreadyRevision = {
    ...detail.revision,
    id: unreadyRevisionId,
    revisionNo: 4,
    title: '正在核对的新版本',
    state: 'assembling',
    observedAt: '2026-10-15T04:00:00Z',
    readyAt: '2026-10-15T04:01:00Z',
    changeKind: 'substantive',
    missingCount: 2,
  };
  await installReadingRoutes(page, {
    detail,
    oldDetail,
    revisions: [unreadyRevision, detail.revision, oldDetail.revision],
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByText('最新观察版本仍在核对，当前继续显示最后一个完整版本。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', detail.article.snapshotUrl);

  await page.getByRole('button', { name: '历史版本' }).click();
  await expect(page.getByText('2026年10月15日 12:00 · 实质变化')).toBeVisible();
  await expect(page.getByText('仍在归档核对中')).toBeVisible();
  await expect(page.getByRole('button', { name: '当前查看' })).toBeVisible();
});

test('a blocked newer observation uses clear unready wording', async ({ page }) => {
  const detail = readingDetail('html');
  const blockedRevision = {
    ...detail.revision,
    id: unreadyRevisionId,
    revisionNo: 4,
    state: 'blocked',
    observedAt: '2026-10-15T04:00:00Z',
    missingCount: 2,
  };
  await installReadingRoutes(page, {
    detail,
    revisions: [blockedRevision, detail.revision],
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('新版本暂未就绪')).toBeVisible();
  await expect(page.getByText('最新观察版本有必需项未完成，当前继续显示最后一个完整版本。')).toBeVisible();
  await expect(page.getByText(/缺项或失败中/)).toHaveCount(0);
});

test('directly opening an unready revision exposes only metadata, missing reasons, and a return entry', async ({ page }) => {
  const detail = readingDetail('html');
  const oldDetail = readingDetail('html', oldRevisionId);
  const stalePrefix = `/api/articles/${articleId}/revisions/${revisionId}`;
  const unreadyDetail = {
    ...readingDetail('html', unreadyRevisionId),
    article: {
      ...detail.article,
      title: '正在核对的新版本',
      bodyText: 'UNREADY BODY MUST NOT BE EXPOSED',
      capturedAt: '2026-10-15T04:00:00Z',
      snapshotUrl: `${stalePrefix}/snapshot`,
      screenshotUrl: `${stalePrefix}/screenshot`,
    },
    attachments: [
      {
        ...detail.attachments[0],
        name: '未就绪申请表.doc',
        filename: 'attachment-2.doc',
        url: `${stalePrefix}/files/attachment-2.doc`,
        downloadUrl: `${stalePrefix}/files/attachment-2.doc?download=1`,
      },
    ],
    revision: {
      ...detail.revision,
      id: unreadyRevisionId,
      revisionNo: 4,
      title: '正在核对的新版本',
      state: 'blocked',
      observedAt: '2026-10-15T04:00:00Z',
      missingCount: 2,
    },
    requirements: [
      {
        slotKey: 'body',
        kind: 'body',
        required: true,
        state: 'failed',
        name: '统一正文',
        filename: null,
        originalUrl: null,
        errorCode: 'artifact_missing',
        fetchedAt: null,
      },
    ],
  } as ReturnType<typeof readingDetail>;
  await installReadingRoutes(page, {
    detail,
    oldDetail,
    unreadyDetail,
    revisions: [unreadyDetail.revision, detail.revision, oldDetail.revision],
  });
  await page.goto(`/articles/${articleId}?revision=${unreadyRevisionId}`);

  await expect(page.getByRole('heading', { level: 1, name: '正在核对的新版本' })).toBeVisible();
  await expect(page.getByText('教务处 · 发布 2026年9月24日')).toBeVisible();
  await expect(page.getByText('缺项或失败的版本不能作为完整阅读')).toBeVisible();
  await expect(page.getByText('UNREADY BODY MUST NOT BE EXPOSED')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '正文', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '网页快照', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /附件 1/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '未就绪申请表.doc' })).toHaveCount(0);
  await expect(page.locator('#notice-attachments')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);

  await page.getByRole('button', { name: '存档信息', exact: true }).click();
  const archive = page.getByRole('dialog', { name: '存档信息' });
  await expect(archive.getByRole('link', { name: '原始通知' })).toBeVisible();
  await expect(archive.getByRole('link', { name: '原貌存档' })).toHaveCount(0);
  await expect(archive.getByRole('link', { name: '网页截图' })).toHaveCount(0);
  await expect(archive.getByText('统一正文 · 必需 · 失败')).toBeVisible();
  await expect(archive.getByText('源站产物未保存成功')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '返回最新完整版本' }).click();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', detail.article.snapshotUrl);
});

test('a selected historical version survives refresh, back, and forward navigation', async ({ page }) => {
  const detail = readingDetail('html');
  const oldDetail = readingDetail('html', oldRevisionId);
  await installReadingRoutes(page, { detail, oldDetail });
  await page.goto(`/articles/${articleId}`);
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', oldDetail.article.snapshotUrl);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', oldDetail.article.snapshotUrl);

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', detail.article.snapshotUrl);

  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  await expect(page.getByText('历史正文：第一批材料由学院保存。')).toBeVisible();
  await expect(page.getByRole('link', { name: '网页快照', exact: true }))
    .toHaveAttribute('href', oldDetail.article.snapshotUrl);
});

test('snapshot adjacency stays compact across widths, themes, and keyboard navigation', async ({ page }) => {
  const original = makePdf([{ text: 'SNAPSHOT ADJACENCY ORIGINAL' }]);
  const detail = readingDetail('pdf');
  detail.attachments[0].bytes = original.length;
  await installReadingRoutes(page, {
    detail,
    files: { [pathname(detail.attachments[0].url)]: original },
  });

  const originalButton = page.getByRole('button', { name: '原件 PDF：通知原件.pdf' });
  const snapshot = page.getByRole('link', { name: '网页快照', exact: true });
  for (const theme of ['light', 'dark']) {
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.goto(`/articles/${articleId}`);
      await page.evaluate(nextTheme => localStorage.setItem('cqu-moe-theme', nextTheme), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(
        page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('SNAPSHOT ADJACENCY ORIGINAL'),
      ).toBeVisible({ timeout: 15000 });
      const originalBox = await originalButton.boundingBox();
      const snapshotBox = await snapshot.boundingBox();
      expect(originalBox).toBeTruthy();
      expect(snapshotBox).toBeTruthy();
      expect(Math.abs(
        originalBox!.y + originalBox!.height / 2 - (snapshotBox!.y + snapshotBox!.height / 2),
      )).toBeLessThanOrEqual(1);
      expect(snapshotBox!.x).toBeGreaterThanOrEqual(originalBox!.x + originalBox!.width);
      expect(snapshotBox!.x - (originalBox!.x + originalBox!.width)).toBeLessThanOrEqual(24);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }

  await snapshot.focus();
  await expect(snapshot).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `${detail.article.title}｜网页快照` })).toBeVisible();
  await page.goBack();
  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('SNAPSHOT ADJACENCY ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });
});
