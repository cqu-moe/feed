import { build } from 'esbuild';
import { test, expect } from '@playwright/test';

test('an attachment sample outside the first list validates real article content and rejects a challenge', async ({ page }) => {
  test.setTimeout(60_000);
  const bundle = await build({ entryPoints: ['worker/source-validation.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { verifySource } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = { id: 'sample', url: 'https://school.test/', listUrl: 'https://school.test/list.htm',
    configVersion: 1, enabled: false, validationTaskId: 'test-validation', timezone: 'Asia/Shanghai',
    config: { articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://school.test/info/1/1.htm' } };
  const list = '<meta charset="utf-8"><ul><li><a href="/info/1/2.htm">当前公告</a><time datetime="2026-11-02">2026-11-02</time></li></ul>';
  const article = `<meta charset="utf-8"><title>历史附件样本-学院</title><div class="v_news_content"><h1>历史附件样本</h1><p>${'这是已公开的往期通知正文。'.repeat(20)}</p><a href="/file.pdf">附件.pdf</a></div>`;
  let challenge = false;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/file.pdf') return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nfixture-file-bytes' });
    const body = url.pathname === '/list.htm' ? list : challenge
      ? `<title>访问验证</title><p>${'请通过验证后继续访问。'.repeat(30)}</p>` : article;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const verify = () => verifySource({ BASE_URL: 'https://feed.test', BRIDGE_SECRET: 'test-only-bridge-secret' }, {
    find: async () => source,
    recordValidation: async (_id: string, _version: number, evidence: unknown) => ({ verified: true, evidence }),
    recordValidationFailure: async () => {},
  }, source.id, { source, taskId: source.validationTaskId, attemptNo: 1,
    scrape: async (_env: unknown, url: string, options: { actions: { script: string }[] }) => {
      await page.goto(url);
      return { actions: { javascriptReturns: [{ value: await page.evaluate(options.actions[0].script) }] } };
    } });
  // Avoid printing a megabyte-sized bundled data URL in a failure stack.
  const result = await verify().catch((error: Error) => { throw new Error(error.message); });
  expect(result.verified).toBe(true);
  expect(result.evidence).toMatchObject({ articleBody: true, attachmentSample: true, snapshotSample: true });
  expect(result.evidence.fileHashes).toHaveLength(1);
  challenge = true;
  await expect(verify()).rejects.toThrow('Sample article body was not recognized');
});
