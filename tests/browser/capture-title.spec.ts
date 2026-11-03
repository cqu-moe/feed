import { build } from 'esbuild';
import { test, expect } from '@playwright/test';

test('capture keeps the full notice title when the source has no h1 or .title', async ({ page }) => {
  const title = '关于开展重庆大学2026—2027学年第一学期“阳光60分”健康行活动的通知';
  const url = 'https://xgb.cqu.edu.cn/info/1024/5803.htm';
  const bundle = await build({ entryPoints: ['worker/collect.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', plugins: [{ name: 'workers-runtime', setup(api) {
      api.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'runtime' }));
      api.onLoad({ filter: /.*/, namespace: 'runtime' }, () => ({
        contents: 'export class DurableObject{}; export class WorkerEntrypoint{}; export class WorkflowEntrypoint{};',
      }));
    } }] });
  const { createCollector } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: `<title>${title}-重庆大学党委学工部</title><main><h3>${title}</h3><div class="v_news_content">通知正文</div></main>` }));
  await page.goto(url);
  let heading: string | undefined;
  const captured = new Error('title captured before archive upload');
  const collector = createCollector({ scrape: async (_env: unknown, _url: string,
    options: { actions: { script: string }[] }) => {
    heading = (await page.evaluate(options.actions[0].script) as { heading: string }).heading;
    throw captured;
  } });
  await expect(collector({ BASE_URL: 'https://feed.test', BRIDGE_SECRET: 'test-only-bridge-secret' },
    { id: 'xgb', siteId: 'xgb', url: 'https://xgb.cqu.edu.cn/' },
    { id: '1234567890abcdef12345678', url, title }, { fence: 1 })).rejects.toBe(captured);
  expect(heading).toBe(title);
});
