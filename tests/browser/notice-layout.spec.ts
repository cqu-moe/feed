import { readFile } from 'node:fs/promises';
import {
  articleId,
  expect,
  installReadingRoutes,
  oldRevisionId,
  readingDetail,
  revisionId,
  test,
} from './fixtures';

const longAttachmentName =
  '附件1：2026-2027学年优异生选拔与培养汇总申请材料明细表（含学院推荐意见与成绩说明）.doc';

test('reader opens a web notice and downloads its material in layout A', async ({ page }) => {
  const detail = readingDetail('html');
  detail.article.bodyText = [
    '各学院：',
    '请根据学校要求开展优异生培养工作。',
    '附件【报名表.doc】已下载次',
    '上一条：学术通知',
    '附件：1. 优异生指标',
    '2. 优异生申请表',
  ].join('\n\n');
  detail.attachments = [
    {
      ...detail.attachments[0],
      name: longAttachmentName,
      bytes: 43,
    },
  ];
  const material = 'agent-27 stable application document bytes';

  await installReadingRoutes(page, {
    detail,
    files: {
      [new URL(detail.attachments[0].downloadUrl ?? '', 'https://feed.test').pathname]: material,
    },
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  const openingParagraph = page.getByText('请根据学校要求开展优异生培养工作。');
  await expect(openingParagraph).toBeVisible();
  expect((await openingParagraph.boundingBox())?.y ?? Number.MAX_SAFE_INTEGER)
    .toBeLessThan(page.viewportSize()?.height ?? 0);

  await expect(page.getByRole('heading', { name: '版本时间线' })).toHaveCount(0);
  await expect(page.getByText('已下载次')).toHaveCount(0);
  await expect(page.getByText('上一条：学术通知')).toHaveCount(0);
  await expect(page.getByText('附件：1. 优异生指标')).toBeVisible();

  await page.getByRole('link', { name: /附件 1/ }).click();
  await expect(page.getByRole('heading', { name: '附件', exact: true })).toBeVisible();
  await expect(page.getByText(longAttachmentName)).toBeVisible();
  await expect(page.getByText('DOC · 43 B')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: new RegExp(longAttachmentName) }).click();
  const download = await downloadPromise;
  expect(download.url()).toContain(`/articles/${articleId}/revisions/${revisionId}/files/attachment-2.doc`);
  const downloadPath = await download.path();
  expect(downloadPath, 'Playwright returned a download artifact');
  await expect(readFile(downloadPath!)).resolves.toEqual(Buffer.from(material));
});

test('history and archive information open on demand and restore trigger focus', async ({ page }) => {
  const oldDetail = {
    ...readingDetail('html', oldRevisionId),
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
  const { detail } = await installReadingRoutes(page, { oldDetail });
  await page.goto(`/articles/${articleId}`);

  const historyTrigger = page.getByRole('button', { name: '历史版本' });
  await expect(historyTrigger).toBeVisible();
  await expect(page.getByRole('heading', { name: '版本时间线' })).toHaveCount(0);
  await historyTrigger.click();
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeVisible();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page).toHaveURL(new RegExp(`revision=${oldRevisionId}`));
  await expect(page.getByRole('heading', { level: 1, name: '历史通知：第一批培养材料' })).toBeVisible();

  const archiveTrigger = page.getByRole('button', { name: '存档信息' });
  await archiveTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '存档信息' })).toBeVisible();
  await expect(page.getByRole('link', { name: '原貌存档' })).toBeVisible();
  await expect(page.getByRole('link', { name: '网页截图' })).toBeVisible();
  await expect(page.getByRole('link', { name: '原始通知' })).toBeVisible();
  await expect(page.getByText('统一正文 · 必需 · 失败')).toBeVisible();
  await expect(page.getByText('源站产物未保存成功')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '存档信息' })).toBeHidden();
  await expect(archiveTrigger).toBeFocused();

  await page.getByRole('button', { name: '返回最新完整版本' }).click();
  await expect(page).not.toHaveURL(new RegExp(`revision=${oldRevisionId}`));
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();

  await historyTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeHidden();
  await expect(historyTrigger).toBeFocused();
});

test('a history failure keeps the saved notice readable', async ({ page }) => {
  await installReadingRoutes(page, { historyStatus: 500 });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  const historyTrigger = page.getByRole('button', { name: '历史版本' });
  await historyTrigger.click();
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeVisible();
  await expect(page.getByText('版本历史加载失败')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试版本' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(historyTrigger).toBeFocused();
});

test('a long title without attachments remains usable across reading widths', async ({ page }) => {
  const detail = readingDetail('html');
  detail.article.title = '关于开展2026—2027学年优异生选拔培养、名单公示、导师确认与材料提交工作的补充通知';
  detail.attachments = [];
  await installReadingRoutes(page, { detail });
  await page.addInitScript(() => localStorage.setItem('cqu-moe-theme', 'light'));

  for (const size of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/articles/${articleId}`);
    await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
    await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
    await expect(page.getByRole('button', { name: '历史版本' })).toBeVisible();
    await expect(page.getByRole('button', { name: '存档信息' })).toBeVisible();
    await expect(page.getByRole('link', { name: /附件 0/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await page.addInitScript(() => localStorage.setItem('cqu-moe-theme', 'dark'));
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/articles/${articleId}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(page.getByText('这篇通知没有附件。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
