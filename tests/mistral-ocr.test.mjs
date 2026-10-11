import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OCR_MODELS, mistralOcr } from '../worker/mistral-ocr.mjs';

const pdf = new TextEncoder().encode('%PDF-1.7\nCQU notice fixture');
const env = { MISTRAL_API_KEY: 'test-mistral-key' };

function ocrResponse({ pages, model = 'mistral-ocr-4-1', pagesProcessed = pages.length }) {
  return {
    model,
    pages,
    usage_info: { pages_processed: pagesProcessed, doc_size_bytes: pdf.byteLength },
  };
}

async function withFetch(mockFetch, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('Mistral OCR sends bounded inline PDF requests and expands page table text', async () => {
  const calls = [];
  const result = await withFetch(async (request, options) => {
    calls.push({ request, options });
    return Response.json(ocrResponse({
      pages: [
        {
          index: 2,
          markdown: '第二页 ![img-0.jpeg](img-0.jpeg) [通知](https://example.comnotice) **强调**',
          tables: [],
        },
        {
          index: 0,
          markdown: '第一页 [tbl-3.html](tbl-3.html) [tbl-1.html](tbl-1.html)',
          tables: [{id:'tbl-1.html',content:'末尾表格'}, {id:'tbl-3.html',content: '| 姓名 | 学号 |\n|---|---|\n| 张三 | 20260001 |', format: 'markdown' }],
        },
      ],
    }));
  }, () => mistralOcr(env, { bytes: pdf.buffer, pages: [2, 0], model: 'mistral-ocr-4-1' }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].request, 'https://api.mistral.ai/v1/ocr');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-mistral-key');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'mistral-ocr-4-1');
  assert.deepEqual(body.pages, [0, 2]);
  assert.deepEqual(Object.keys(body).sort(), ['document', 'include_image_base64', 'model', 'pages', 'table_format']);
  assert.equal(body.table_format, null);
  assert.equal(body.include_image_base64, false);
  assert.equal(body.document.type, 'document_url');
  assert.equal(atob(body.document.document_url.slice('data:application/pdf;base64,'.length)), new TextDecoder().decode(pdf));
  assert.doesNotMatch(Object.keys(body).join(' '), /annotation/i);

  assert.deepEqual(result.pages.map((page) => page.index), [0, 2]);
  assert.equal(result.requestedModel, 'mistral-ocr-4-1');
  assert.equal(result.model, 'mistral-ocr-4-1');
  assert.equal(result.estimatedUsd, 0.008);
  assert.ok(result.elapsedMs >= 0);
  assert.match(result.pages[0].text, /张三 20260001/);
  assert.match(result.pages[0].markdown,/张三.*20260001[\s\S]*末尾表格/);
  assert.doesNotMatch(result.pages[0].markdown,/tbl-/);
  assert.match(result.pages[1].text, /第二页 通知 强调/);
  assert.doesNotMatch(result.pages[1].text, /example\.com|img-0|!\[|\]\(/);
});

test('Mistral OCR rejects unsafe model, page, and PDF input before HTTP', async () => {
  await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: [0], model: 'mistral-ocr-latest' }), /Unsupported/);
  await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: [0], model: 'constructor' }), /Unsupported/);
  await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: [0, 0], model: 'mistral-ocr-2512' }), /duplicated/);
  await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: ['0'], model: 'mistral-ocr-2512' }), /non-negative integers/);
  await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: [-1], model: 'mistral-ocr-2512' }), /non-negative integers/);
  await assert.rejects(() => mistralOcr(env, { bytes: new TextEncoder().encode('not a pdf'), pages: [0], model: 'mistral-ocr-2512' }), /%PDF/);
});

test('Mistral OCR surfaces bounded provider errors and validates returned page usage', async () => {
  await withFetch(async () => Response.json({ message: 'rate limited' }, { status: 429 }), async () => {
    await assert.rejects(
      () => mistralOcr(env, { bytes: pdf.buffer, pages: [0], model: 'mistral-ocr-2512' }),
      /Mistral OCR HTTP 429: rate limited/,
    );
  });

  const malformedResponses = [
    ocrResponse({ pages: [{ index: 0, markdown: 'only page' }], pagesProcessed: 0 }),
    ocrResponse({ pages: [{ index: 0, markdown: 'only page' }, { index: 1, markdown: 'second page' }], pagesProcessed: 1 }),
    ocrResponse({ pages: [{ index: 1, markdown: 'wrong page' }] }),
    ocrResponse({ pages: [{ index: 0, markdown: 'one' }, { index: 0, markdown: 'duplicate' }] }),
    ocrResponse({ pages: [{ index: 0, markdown: 'one' }, { index: 1, markdown: 'extra' }] }),
  ];
  for (const payload of malformedResponses) {
    await withFetch(async () => Response.json(payload), async () => {
      await assert.rejects(() => mistralOcr(env, { bytes: pdf.buffer, pages: [0], model: 'mistral-ocr-2512' }));
    });
  }
});

test('Mistral OCR rejects responses larger than the transport bound before parsing', async () => {
  await withFetch(async () => new Response('{}', {
    headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
  }), async () => {
    await assert.rejects(
      () => mistralOcr(env, { bytes: pdf.buffer, pages: [0], model: 'mistral-ocr-2512' }),
      /exceeds 8 MiB/,
    );
  });
});

test('OCR model catalogue contains the exact OCR 3 and OCR 4.1 identifiers and prices', () => {
  assert.deepEqual(OCR_MODELS, {
    'mistral-ocr-2512': { label: 'OCR 3', usdPerPage: 0.002 },
    'mistral-ocr-4-1': { label: 'OCR 4.1', usdPerPage: 0.004 },
  });
});
