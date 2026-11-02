import { build } from 'esbuild';
import { test, expect } from '@playwright/test';

test('a historical sample uses the configured CAPTCHA bridge and rejects an article challenge', async ({ page, context }) => {
  test.setTimeout(60_000);
  const { bridgeHTML } = await import(new URL('../../worker/bridge-page.mjs', import.meta.url).href);
  const bundle = await build({ entryPoints: ['worker/source-validation.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { verifySource } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = { id: 'sample', url: 'https://school.test/', listUrl: 'https://school.test/list.htm',
    configVersion: 1, enabled: false, validationTaskId: 'test-validation', timezone: 'Asia/Shanghai',
    config: { articlePattern: '^/info/\\d+/\\d+\\.htm$', sampleArticleUrl: 'https://school.test/info/1/1.htm' } };
  const list = '<meta charset="utf-8"><ul><li><a href="/info/1/2.htm">当前公告</a><time datetime="2026-11-02">2026-11-02</time></li></ul><a href="/list/2.htm">下一页</a>';
  const continuation = '<meta charset="utf-8"><ul><li><span>2026-10-20</span><a href="https://mp.weixin.qq.com/s/public-article">重大青年公众号文章</a></li></ul>';
  const article = `<meta charset="utf-8"><title>历史附件样本-学院</title><div class="v_news_content"><h1>历史附件样本</h1><p>${'这是已公开的往期通知正文。'.repeat(20)}</p><a href="/file.pdf">附件.pdf</a></div>`;
  let challenge = false;
  const solveOrigins: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://feed.test') return route.fulfill({ status: 403, body: '<title>Just a moment...</title>' });
    if (url.pathname === '/internal/bridge') {
      const token = url.searchParams.get('grant')!;
      const grant = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      return route.fulfill({ contentType: 'text/html', body: bridgeHTML({ ...grant, token }) });
    }
    if (url.pathname === '/internal/solve') {
      solveOrigins.push(url.origin);
      return route.fulfill({ json: { digits: '1234' } });
    }
    if (url.pathname === '/captcha.png') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=', 'base64') });
    if (url.pathname === '/file.pdf') return url.searchParams.get('codeValue') === '1234'
      ? route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nfixture-file-bytes' })
      : route.fulfill({ contentType: 'text/html', body: '<form><input name="codeValue"><img src="/captcha.png"></form>' });
    const body = url.pathname === '/list.htm' ? list : url.pathname === '/list/2.htm' ? continuation : challenge
      ? `<title>访问验证</title><p>${'请通过验证后继续访问。'.repeat(30)}</p>` : article;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const verify = () => verifySource({ BASE_URL: 'https://feed.test', BRIDGE_BASE_URL: 'https://bridge.test', BRIDGE_SECRET: 'test-only-bridge-secret' }, {
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
  expect(result.evidence).toMatchObject({ listPages: 2, paginationMode: 'followed', articleBody: true, attachmentSample: true, snapshotSample: true });
  expect(result.evidence.fileHashes).toHaveLength(1);
  expect(solveOrigins).toEqual(['https://bridge.test']);
  challenge = true;
  await expect(verify()).rejects.toThrow('Sample article body was not recognized');
});
