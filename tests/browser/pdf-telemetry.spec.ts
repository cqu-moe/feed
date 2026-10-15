import { gunzipSync } from 'node:zlib';
import { test, expect, installReadingRoutes, articleId, revisionId, makePdf } from './fixtures';
import type { Page } from '@playwright/test';

test.skip(process.env.VITE_POSTHOG_PROJECT_TOKEN !== 'phc_feed_browser_test', 'Run with the dedicated local telemetry fixture build.');

type CapturedEvent = { event: string; properties: Record<string, unknown> };

async function observeEvents(page: Page) {
  // The external SDK filters webdriver. Model a normal browser only inside
  // this local fixture; every capture request remains intercepted below.
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const events: CapturedEvent[] = [];
  await page.context().route('**/__telemetry/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataBuffer();
      if (body?.length) {
        const decoded = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString() : body.toString();
        const formData = decoded.startsWith('data=') ? new URLSearchParams(decoded).get('data') : null;
        const json = formData === null ? decoded : formData.startsWith('{') || formData.startsWith('[')
          ? formData : Buffer.from(formData, 'base64').toString();
        const payload = JSON.parse(json);
        const batch = Array.isArray(payload) ? payload : payload.batch ?? [payload];
        events.push(...batch.filter((item: CapturedEvent) => typeof item.event === 'string'));
      }
    }
    await route.fulfill({ json: { status: 1, featureFlags: {}, featureFlagPayloads: {}, sessionRecording: false } });
  });
  return events;
}

const pdfOpens = (events: CapturedEvent[], id: string) => events.filter(event => event.event === 'feed_item_opened'
  && event.properties.operation === 'pdf_read' && event.properties.article_id === id);
const sentinelArticleId = 'abcdef1234567890abcdef12';

// The next real document-open event drains the same external SDK queue, so the
// absence assertion does not depend on an arbitrary sleep or an internal hook.
async function flushThroughAnotherDocument(page: Page, events: CapturedEvent[]) {
  await page.evaluate(path => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `/reader/${sentinelArticleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByText('PDF PAGE 1', { exact: true })).toBeVisible();
  await expect.poll(() => pdfOpens(events, sentinelArticleId).length, { timeout: 20_000 }).toBe(1);
}

test('one standalone PDF open stays one event through page and zoom changes', async ({ page }) => {
  await installReadingRoutes(page, { kind: 'pdf', pdf: makePdf(3) });
  const events = await observeEvents(page);
  await page.goto(`/reader/${articleId}/revisions/${revisionId}/attachment-1.pdf`);
  await expect(page.getByText('PDF PAGE 1', { exact: true })).toBeVisible();
  await expect.poll(() => pdfOpens(events, articleId).length, { timeout: 20_000 }).toBe(1);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('2 / 3')).toBeVisible();
  await page.getByRole('button', { name: '放大' }).click();
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 500);
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByText('1 / 3')).toBeVisible();
  await flushThroughAnotherDocument(page, events);
  expect(pdfOpens(events, articleId)).toHaveLength(1);
});

test('an embedded PDF does not add a standalone open event', async ({ page }) => {
  await installReadingRoutes(page, { kind: 'pdf', pdf: makePdf(3) });
  const events = await observeEvents(page);
  await page.goto(`/articles/${articleId}`);
  const frame = page.frameLocator('iframe[title="通知原件.pdf PDF 预览"]');
  await expect(frame.getByText('PDF PAGE 1', { exact: true })).toBeVisible();
  await frame.getByRole('button', { name: '下一页' }).click();
  await expect(frame.getByText('2 / 3')).toBeVisible();
  await flushThroughAnotherDocument(page, events);
  expect(pdfOpens(events, articleId)).toHaveLength(0);
});
