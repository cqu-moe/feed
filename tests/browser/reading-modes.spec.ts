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
} from './fixtures';

const pdfTextUnavailable = 'PDF 正文暂未提取到可搜索文字；可在下方阅读原文件。';

function downloadPathname(attachment: { downloadUrl?: string | null }): string {
  return new URL(attachment.downloadUrl ?? '', 'https://feed.test').pathname;
}

async function downloadBytes<T extends { click(): Promise<void> }>(page: Parameters<typeof installReadingRoutes>[0], target: T): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await target.click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path, 'Playwright returned a download artifact').toBeTruthy();
  return Buffer.from(await readFile(path!));
}

test('a body PDF opens as the original while text remains switchable', async ({ page }) => {
  const original = makePdf([{ text: 'BODY ORIGINAL FOR MODES' }]);
  const detail = readingDetail('pdf');
  detail.attachments[0].bytes = original.length;
  const material = Buffer.from('ordinary material for a PDF notice');

  await installReadingRoutes(page, {
    detail,
    historyDelay: 4000,
    files: {
      [downloadPathname(detail.attachments[0])]: original,
      [downloadPathname(detail.attachments[1])]: material,
    },
  });
  await page.goto(`/articles/${articleId}`);

  const originalButton = page.getByRole('button', { name: '原件 PDF：通知原件.pdf' });
  const textButton = page.getByRole('button', { name: '正文', exact: true });
  const originalFrame = page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  await expect(originalButton).toBeVisible();
  await expect(originalButton).toHaveText('原件 PDF');
  await expect(originalButton).toHaveAttribute('aria-pressed', 'true');
  await expect(originalFrame.getByText('BODY ORIGINAL FOR MODES')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('link', { name: /附件 1/ })).toBeVisible();
  await expect(page.locator('#notice-attachments')).not.toContainText('通知原件.pdf');
  await expect(page.locator('#notice-attachments')).toContainText('附件2：优异生申请表.doc');

  await textButton.focus();
  await page.keyboard.press('Enter');
  await expect(textButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.locator('iframe[title="通知原件.pdf PDF 预览"]')).toHaveCount(0);

  await page.getByRole('button', { name: '历史版本' }).click();
  await expect(page.getByRole('dialog', { name: '历史版本' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /查看版本/ }).first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await originalButton.focus();
  await page.keyboard.press('Enter');
  await expect(originalFrame.getByText('BODY ORIGINAL FOR MODES')).toBeVisible({ timeout: 15000 });
  await expect(downloadBytes(page, originalFrame.getByRole('link', { name: '下载' }))).resolves.toEqual(original);
});

test('selecting another revision resets reading mode for the newly loaded document', async ({ page }) => {
  const currentOriginal = makePdf([{ text: 'CURRENT VERSION ORIGINAL' }]);
  const oldOriginal = makePdf([{ text: 'OLD VERSION ORIGINAL' }]);
  const detail = readingDetail('pdf');
  const oldDetail = readingDetail('pdf', oldRevisionId);
  detail.attachments[0].bytes = currentOriginal.length;
  oldDetail.attachments[0].bytes = oldOriginal.length;

  await installReadingRoutes(page, {
    detail,
    oldDetail,
    files: {
      [downloadPathname(detail.attachments[0])]: currentOriginal,
      [downloadPathname(oldDetail.attachments[0])]: oldOriginal,
    },
  });
  await page.goto(`/articles/${articleId}`);

  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('CURRENT VERSION ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });
  const textButton = page.getByRole('button', { name: '正文', exact: true });
  await textButton.click();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '历史版本' }).click();
  await page.getByRole('button', { name: /查看版本/ }).last().click();
  await expect(page.getByRole('heading', { level: 1, name: oldDetail.article.title })).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="历史通知原件.pdf PDF 预览"]').getByText('OLD VERSION ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: '返回最新完整版本' }).click();
  await expect(page.getByRole('heading', { level: 1, name: detail.article.title })).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('CURRENT VERSION ORIGINAL'),
  ).toBeVisible({ timeout: 15000 });
});

test('multiple body PDFs keep stable order and ordinary PDFs remain attachments', async ({ page }) => {
  const first = makePdf([{ text: 'FIRST BODY ORIGINAL' }]);
  const second = makePdf([{ text: 'SECOND BODY ORIGINAL' }]);
  const ordinary = makePdf([{ text: 'ORDINARY PDF ATTACHMENT' }]);
  const base = readingDetail('pdf');
  const firstBody = { ...base.attachments[0], name: '第一份正文原件.pdf', bytes: first.length };
  const secondBody = {
    ...base.attachments[0],
    id: 'second-body',
    name: '第二份正文原件.pdf',
    filename: 'attachment-3.pdf',
    url: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-3.pdf`,
    downloadUrl: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-3.pdf?download=1`,
    bytes: second.length,
  };
  const ordinaryPdf = {
    ...base.attachments[1],
    name: '普通PDF附件.pdf',
    filename: 'attachment-4.pdf',
    contentType: 'application/pdf',
    url: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-4.pdf`,
    downloadUrl: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-4.pdf?download=1`,
    bytes: ordinary.length,
  };
  const detail = {
    ...base,
    attachments: [firstBody, secondBody, ordinaryPdf],
  } as ReturnType<typeof readingDetail>;
  detail.article.attachmentCount = detail.attachments.length;

  await installReadingRoutes(page, {
    detail,
    files: {
      [downloadPathname(firstBody)]: first,
      [downloadPathname(secondBody)]: second,
      [downloadPathname(ordinaryPdf)]: ordinary,
    },
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.locator('iframe[title="第一份正文原件.pdf PDF 预览"]')).toBeVisible();
  await expect(page.frameLocator('iframe[title="第一份正文原件.pdf PDF 预览"]').getByText('FIRST BODY ORIGINAL')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '原件 PDF：第二份正文原件.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: '原件 PDF：第一份正文原件.pdf' })).toHaveText('原件 PDF 1');
  await expect(page.getByRole('button', { name: '原件 PDF：第二份正文原件.pdf' })).toHaveText('原件 PDF 2');
  await expect(page.getByRole('link', { name: /附件 1/ })).toBeVisible();
  await expect(page.locator('#notice-attachments')).not.toContainText('第一份正文原件.pdf');
  await expect(page.locator('#notice-attachments')).not.toContainText('第二份正文原件.pdf');
  await expect(page.locator('#notice-attachments')).toContainText('普通PDF附件.pdf');
  await expect(
    page.frameLocator('iframe[title="普通PDF附件.pdf PDF 预览"]').getByText('ORDINARY PDF ATTACHMENT'),
  ).toBeVisible({ timeout: 15000 });

  const secondButton = page.getByRole('button', { name: '原件 PDF：第二份正文原件.pdf' });
  await secondButton.focus();
  await page.keyboard.press('Enter');
  await expect(secondButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('当前原件：第二份正文原件.pdf')).toBeVisible();
  await expect(page.frameLocator('iframe[title="第二份正文原件.pdf PDF 预览"]').getByText('SECOND BODY ORIGINAL')).toBeVisible({ timeout: 15000 });
  await expect(downloadBytes(page, page.locator('#notice-attachments').getByRole('link', { name: '普通PDF附件.pdf' }))).resolves.toEqual(ordinary);
});

test('a missing role is recovered only from exact body_pdf requirement metadata', async ({ page }) => {
  const original = makePdf([{ text: 'RECOVERED LEGACY BODY' }]);
  const ordinary = makePdf([{ text: 'ROLELESS ORDINARY PDF' }]);
  const base = readingDetail('pdf');
  const recovered = { ...base.attachments[0], bytes: original.length };
  const ordinaryPdf = {
    ...base.attachments[1],
    name: '未知角色普通PDF.pdf',
    contentType: 'application/pdf',
    bytes: ordinary.length,
  };
  const detail = {
    ...base,
    attachments: [recovered, ordinaryPdf],
    requirements: [
      {
        slotKey: 'body-pdf',
        kind: 'body_pdf',
        required: true,
        state: 'fulfilled',
        name: '通知原件.pdf',
        filename: 'attachment-1.pdf',
        originalUrl: 'https://example.edu/original.pdf',
        errorCode: null,
        fetchedAt: '2026-10-14T01:11:00Z',
      },
    ],
  } as ReturnType<typeof readingDetail>;
  const legacyBody = {
    ...recovered,
    role: undefined,
  };
  const legacyOrdinary = {
    ...ordinaryPdf,
    role: undefined,
  };
  detail.attachments = [legacyBody, legacyOrdinary];

  await installReadingRoutes(page, {
    detail,
    files: {
      [downloadPathname(legacyBody)]: original,
      [downloadPathname(legacyOrdinary)]: ordinary,
    },
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('RECOVERED LEGACY BODY')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('link', { name: /附件 1/ })).toBeVisible();
  await expect(page.locator('#notice-attachments')).not.toContainText('通知原件.pdf');
  await expect(page.locator('#notice-attachments')).toContainText('未知角色普通PDF.pdf');
});

test('a roleless PDF attachment does not change a web notice to original mode', async ({ page }) => {
  const ordinary = makePdf([{ text: 'ROLELESS PDF SHOULD STAY ATTACHED' }]);
  const explicitUnknownRole = makePdf([{ text: 'UNKNOWN ROLE SHOULD STAY ATTACHED' }]);
  const base = readingDetail('html');
  const missingRolePdf = {
    ...base.attachments[0],
    name: '没有角色的空文件名普通PDF.pdf',
    filename: '',
    contentType: 'application/pdf',
    bytes: ordinary.length,
    url: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-2.pdf`,
    downloadUrl: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-2.pdf?download=1`,
  };
  const unknownRolePdf = {
    ...base.attachments[0],
    id: 'unknown-role-pdf',
    name: '旧角色普通PDF.pdf',
    filename: 'attachment-3.pdf',
    role: 'legacy-pdf',
    contentType: 'application/pdf',
    bytes: explicitUnknownRole.length,
    url: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-3.pdf`,
    downloadUrl: `/api/articles/${articleId}/revisions/${revisionId}/files/attachment-3.pdf?download=1`,
  };
  const detail = {
    ...base,
    attachments: [missingRolePdf, unknownRolePdf],
    requirements: [
      {
        slotKey: 'empty-filename',
        kind: 'body_pdf',
        required: true,
        state: 'failed',
        name: '正文原件.pdf',
        filename: '',
        originalUrl: 'https://example.edu/body.pdf',
        errorCode: 'attachment_missing',
        fetchedAt: null,
      },
      {
        slotKey: 'legacy-explicit-role',
        kind: 'body_pdf',
        required: true,
        state: 'fulfilled',
        name: '旧角色正文.pdf',
        filename: 'attachment-3.pdf',
        originalUrl: 'https://example.edu/legacy.pdf',
        errorCode: null,
        fetchedAt: '2026-10-14T01:11:00Z',
      },
    ],
  } as ReturnType<typeof readingDetail>;
  detail.article.attachmentCount = 2;

  await installReadingRoutes(page, {
    detail,
    files: {
      [downloadPathname(missingRolePdf)]: ordinary,
      [downloadPathname(unknownRolePdf)]: explicitUnknownRole,
    },
  });
  await page.goto(`/articles/${articleId}`);

  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  await expect(page.getByRole('button', { name: /原件 PDF/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /附件 2/ })).toBeVisible();
  await expect(page.locator('#notice-attachments')).toContainText('没有角色的空文件名普通PDF.pdf');
  await expect(page.locator('#notice-attachments')).toContainText('旧角色普通PDF.pdf');
});

test('a failed legacy body PDF with a constructed URL stays in text mode', async ({ page }) => {
  const detail = readingDetail('pdf');
  detail.attachments[0] = {
    ...detail.attachments[0],
    status: 'failed',
    error: '附件未保存成功',
  };

  await installReadingRoutes(page, { detail });
  await page.goto(`/articles/${articleId}`);

  const textButton = page.getByRole('button', { name: '正文', exact: true });
  await expect(textButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
  const originalButton = page.getByRole('button', { name: '原件 PDF：通知原件.pdf' });
  await expect(originalButton).toBeDisabled();
  await expect(originalButton).toHaveText('原件 PDF');
  await expect(page.getByText('原件文件尚未保存')).toBeVisible();
  await expect(page.locator('iframe[title="通知原件.pdf PDF 预览"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '下载原件 PDF' })).toHaveCount(0);
});

test('unavailable extracted text keeps its switch position and explains why', async ({ page }) => {
  const original = makePdf([{ text: 'ORIGINAL WHEN TEXT IS UNAVAILABLE' }]);
  const detail = readingDetail('pdf');
  detail.article.bodyText = pdfTextUnavailable;
  detail.attachments[0].bytes = original.length;

  await installReadingRoutes(page, { detail, files: { [downloadPathname(detail.attachments[0])]: original } });
  await page.goto(`/articles/${articleId}`);

  await expect(page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('ORIGINAL WHEN TEXT IS UNAVAILABLE')).toBeVisible({ timeout: 15000 });
  const textButton = page.getByRole('button', { name: '正文', exact: true });
  await textButton.focus();
  await page.keyboard.press('Enter');
  await expect(textButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这个版本的正文还没有可提取文字，请先阅读原件 PDF。')).toBeVisible();
  await expect(page.getByText(pdfTextUnavailable)).toHaveCount(0);
});

test('original preview failure keeps text and protected download available', async ({ page }) => {
  const original = makePdf([{ text: 'DOWNLOAD AFTER PREVIEW FAILURE' }]);
  const detail = readingDetail('pdf');
  detail.attachments[0].bytes = original.length;

  await installReadingRoutes(page, {
    detail,
    previewStatus: 500,
    downloadStatus: 200,
    files: { [downloadPathname(detail.attachments[0])]: original },
  });
  await page.goto(`/articles/${articleId}`);

  const failedFrame = page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  await expect(failedFrame.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible({ timeout: 15000 });
  const textButton = page.getByRole('button', { name: '正文', exact: true });
  await textButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();

  await page.getByRole('button', { name: '原件 PDF：通知原件.pdf' }).focus();
  await page.keyboard.press('Enter');
  await expect(failedFrame.getByRole('heading', { name: 'PDF 暂时无法预览' })).toBeVisible({ timeout: 15000 });
  await expect(downloadBytes(page, page.getByRole('link', { name: '下载原件 PDF' }))).resolves.toEqual(original);
});

test('original mode stays usable across widths, themes, and keyboard switching', async ({ page }) => {
  const original = makePdf([{ text: 'RESPONSIVE BODY ORIGINAL' }]);
  const detail = readingDetail('pdf');
  detail.attachments[0].bytes = original.length;

  await installReadingRoutes(page, { detail, files: { [downloadPathname(detail.attachments[0])]: original } });
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
      await expect(page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]').getByText('RESPONSIVE BODY ORIGINAL')).toBeVisible({ timeout: 15000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }

  const textButton = page.getByRole('button', { name: '正文', exact: true });
  await textButton.focus();
  await page.keyboard.press('Enter');
  await expect(textButton).toBeFocused();
  await expect(page.getByText('请根据学校要求开展优异生培养工作。')).toBeVisible();
});
