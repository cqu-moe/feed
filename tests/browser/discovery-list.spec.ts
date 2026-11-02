import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { test, expect } from '@playwright/test';

// Reduced from the public XGB list fetched on 2026-11-02. Both link forms
// occur in the same list; the first article uses the dynamic JSP route.
const listHtml = `<meta charset="utf-8"><main>
  <div class="list-item"><div class="left-block">
    <a href="detail.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=1024&amp;wbnewsid=5808"><h2>学生争先创优表彰决定</h2></a>
    <p>通知摘要</p><p class="time-line">2026-10-30</p>
    <p><a href="info/1024/5808.htm">更多+</a></p>
  </div></div>
  <div class="list-item"><a href="info/1024/5803.htm"><h2>阳光60分健康行</h2></a><p>2026-10-30</p></div>
  <a href="https://other.example/info/1024/5803.htm">站外链接</a>
  <a href="detail.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=1024&amp;wbtreeid=1025&amp;wbnewsid=5809">歧义参数</a>
  <a href="list.jsp?a1057881p=2&amp;wbtreeid=1024">&gt;</a>
</main>`;

test('XGB discovers dynamic and static article links with dates and pagination', async ({ page }) => {
  const bundle = await build({ entryPoints: ['worker/discovery.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { discoverList } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = JSON.parse(await readFile('worker/sources.json', 'utf8')).find((s: { id: string }) => s.id === 'xgb');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: listHtml }));
  await page.goto(source.listUrls[0]);
  const result = await discoverList({}, source, page.url(), { scrape: async (_env: unknown, _url: string,
    options: { actions: { script: string }[] }) => ({ actions: { javascriptReturns: [{ value: await page.evaluate(options.actions[0].script) }] } }) });
  expect(result.articles).toEqual([
    expect.objectContaining({ url: 'https://xgb.cqu.edu.cn/info/1024/5808.htm', title: '学生争先创优表彰决定', publishedDay: '2026-10-30' }),
    expect.objectContaining({ url: 'https://xgb.cqu.edu.cn/info/1024/5803.htm', title: '阳光60分健康行', publishedDay: '2026-10-30' }),
  ]);
  expect(result.next).toEqual(['https://xgb.cqu.edu.cn/list.jsp?a1057881p=2&wbtreeid=1024']);
});

test('SEE discovers dates split across time elements', async ({ page }) => {
  const html = `<meta charset="utf-8"><main><div class="wzlb"><div class="lb"><ul>
    <li class="flex">
      <div class="time"><h4>09/14</h4><span></span><p>2026</p></div>
      <div class="tet"><h4><a href="https://see.cqu.edu.cn/2022b/wznr.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=3897&amp;wbnewsid=21457">2026.09.17学年第一学期第二周学院工作安排</a></h4></div>
    </li>
    <li>
      <a href="https://see.cqu.edu.cn/info/3897/21456.htm">2026.09.20讲座预告（没有发布日期）</a>
    </li>
  </ul></div></div></main>`;
  const bundle = await build({ entryPoints: ['worker/discovery.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { discoverList } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = {
    id: 'see',
    url: 'https://see.cqu.edu.cn/',
    listUrls: ['https://see.cqu.edu.cn/xsgz/tzgg.htm'],
    articlePattern: '^/info/\\d+/\\d+\\.htm$',
    timezone: 'Asia/Shanghai',
  };
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(source.listUrls[0]);
  const result = await discoverList({}, source, page.url(), { scrape: async (_env: unknown, _url: string,
    options: { actions: { script: string }[] }) => ({ actions: { javascriptReturns: [{ value: await page.evaluate(options.actions[0].script) }] } }) });
  expect(result.articles).toEqual([
    expect.objectContaining({
      url: 'https://see.cqu.edu.cn/info/3897/21457.htm',
      title: '2026.09.17学年第一学期第二周学院工作安排',
      publishedDay: '2026-09-14',
    }),
    expect.objectContaining({url: 'https://see.cqu.edu.cn/info/3897/21456.htm', publishedDay: null, precision: 'unknown'}),
  ]);
});

test('CS ignores navigation links and uses card headings for wrapped article links', async ({ page }) => {
  const html = `<meta charset="utf-8"><main>
    <header class="header"><nav class="nav">
      <a href="https://cs.cqu.edu.cn/info/1571/8197.htm">党群工作</a>
    </nav></header>
    <div class="pup-nav"><a href="https://cs.cqu.edu.cn/info/1571/8197.htm">党群工作</a></div>
    <div class="subpage-nav"><a href="https://cs.cqu.edu.cn/info/1571/8197.htm">党群工作</a></div>
    <div class="subListOne"><ul>
      <a href="https://cs.cqu.edu.cn/info/1553/12210.htm" class="subListOne-item">
        <div class="time"><div class="year">2026/09/</div><div class="day">10</div><span>查看详情</span></div>
        <div class="det"><div class="p1">计算机学院关于接收2027年推荐免试研究生（含直博生）预报名的通知</div><div class="p2">通知摘要</div></div>
      </a>
      <div><a href="https://cs.cqu.edu.cn/info/1553/12209.htm" class="subListOne-item">
        <div class="det"><div class="p1">未知日期通知</div></div>
      </a></div>
    </ul></div>
  </main>`;
  const bundle = await build({ entryPoints: ['worker/discovery.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { discoverList } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = {
    id: 'cs',
    url: 'https://cs.cqu.edu.cn/',
    listUrls: ['https://cs.cqu.edu.cn/yjsjy/jxgg.htm'],
    articlePattern: '^/info/\\d+/\\d+\\.htm$',
    timezone: 'Asia/Shanghai',
  };
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(source.listUrls[0]);
  const result = await discoverList({}, source, page.url(), { scrape: async (_env: unknown, _url: string,
    options: { actions: { script: string }[] }) => ({ actions: { javascriptReturns: [{ value: await page.evaluate(options.actions[0].script) }] } }) });
  expect(result.articles).toEqual([
    expect.objectContaining({
      url: 'https://cs.cqu.edu.cn/info/1553/12210.htm',
      title: '计算机学院关于接收2027年推荐免试研究生（含直博生）预报名的通知',
      publishedDay: '2026-09-10',
    }),
    expect.objectContaining({
      url: 'https://cs.cqu.edu.cn/info/1553/12209.htm',
      title: '未知日期通知',
      publishedDay: null,
      precision: 'unknown',
    }),
  ]);
});

test('explicit datetime preserves minute precision and timezone', async ({ page }) => {
  const html = `<meta charset="utf-8"><main><li>
    <time datetime="2026-10-30T09:30:00+08:00"></time>
    <a href="info/1024/5809.htm">招聘信息汇总</a>
  </li></main>`;
  const bundle = await build({ entryPoints: ['worker/discovery.mjs'], bundle: true, write: false,
    platform: 'node', format: 'esm', external: ['cloudflare:workers'] });
  const { discoverList } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const source = {
    id: 'sci',
    url: 'https://sci.cqu.edu.cn/',
    listUrls: ['https://sci.cqu.edu.cn/list.htm'],
    articlePattern: '^/info/\\d+/\\d+\\.htm$',
    timezone: 'Asia/Shanghai',
  };
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(source.listUrls[0]);
  const result = await discoverList({}, source, page.url(), { scrape: async (_env: unknown, _url: string,
    options: { actions: { script: string }[] }) => ({ actions: { javascriptReturns: [{ value: await page.evaluate(options.actions[0].script) }] } }) });
  expect(result.articles).toEqual([
    expect.objectContaining({
      url: 'https://sci.cqu.edu.cn/info/1024/5809.htm',
      title: '招聘信息汇总',
      publishedDay: '2026-10-30',
      publishedAt: '2026-10-30T01:30:00.000Z',
      precision: 'minute',
    }),
  ]);
});
