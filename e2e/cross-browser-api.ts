import { test as base, expect, firefox, webkit, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { Browser } from '@e2e-dev/web';
import type { App, Screen } from 'e2e';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export { expect };
type Surfaces = { browser: Browser; screen: Screen; app: App };

// Convert the small operation vocabulary used by the original e2e journeys;
// assertions operate on genuine Playwright Pages/Locators, never fake responses.
function queries(current: () => any, overrides: Record<string, unknown> = {}, observe: () => Promise<void> = async () => {}): any {
  return new Proxy({}, {
    get(_target, key: string) {
      if (key in overrides) return overrides[key];
      const target = current();
      if (key === 'getByRole') return (role: string, name: any = {}, options = {}) => queries(() => target.getByRole(role,
        { exact: true, ...(typeof name === 'string' || name instanceof RegExp ? { name, ...options } : name) }), {}, observe);
      if (['getByText', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText'].includes(key)) {
        return (text: any, options = {}) => queries(() => target[key](text, { exact: true, ...options }), {}, observe);
      }
      if (['locator', 'frameLocator', 'first', 'last', 'nth', 'filter'].includes(key)) {
        return (...args: any[]) => queries(() => target[key](...args), {}, observe);
      }
      if (['click', 'fill', 'press', 'focus', 'hover'].includes(key)) return async (...args: any[]) => { await observe(); return target[key](...args); };
      const value = target[key];
      return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
    },
  });
}

const native = base.extend<{ surfaces: Surfaces }>({
  surfaces: async ({}, use, info) => {
    const out = process.env.FEED_E2E_OUTPUT!;
    const engine = process.env.FEED_E2E_BROWSER!;
    if (!['firefox', 'webkit'].includes(engine)) throw new Error('Native TLS adapter requires Firefox/WebKit');
    const browserType = engine === 'firefox' ? firefox : webkit;
    const viewport = process.env.FEED_E2E_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const origins = [process.env.FEED_E2E_APP_URL!, process.env.FEED_E2E_AUTH_URL!].map(url => new URL(url).origin);
    const attemptId = randomUUID();
    const profiles: Array<{ path: string; removed: boolean; disconnected: boolean }> = [];
    const unexpected: string[] = [], errors: unknown[] = [];
    const viewports: unknown[] = [];
    const routes: Array<{ pattern: string | RegExp; handler: (route: any) => any }> = [];
    let context: BrowserContext | undefined, page!: Page, profile: typeof profiles[number];
    async function observe() {
      const url = new URL(page.url());
      if (!origins.includes(url.origin)) return;
      const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const value = { attemptId, testId: info.testId, origin: url.origin, path: url.pathname, expected: viewport, actual };
      if (!viewports.some(entry => JSON.stringify(entry) === JSON.stringify(value))) viewports.push(value);
      expect(actual).toEqual(viewport);
    }
    async function close() {
      if (!context) return;
      await context.close();
      profile.disconnected = context.browser()?.isConnected() === false;
      await rm(profile.path, { recursive: true, force: true });
      await stat(profile.path).then(() => { throw new Error('Disposable profile remains'); }, error => { if (error.code !== 'ENOENT') throw error; });
      profile.removed = true;
      if (!profile.disconnected) throw new Error('Browser did not disconnect');
      context = undefined;
    }
    async function open() {
      const directory = join(out, '.profiles');
      await mkdir(directory, { recursive: true });
      profile = { path: await mkdtemp(join(directory, `${engine}-`)), removed: false, disconnected: false };
      profiles.push(profile);
      context = await browserType.launchPersistentContext(profile.path, {
        headless: true, ignoreHTTPSErrors: true, viewport, baseURL: origins[0],
      });
      await context.route('**/*', async route => {
        const origin = new URL(route.request().url()).origin;
        if (origins.includes(origin)) await route.continue();
        else { unexpected.push(origin); await route.abort(); }
      });
      page = context.pages()[0] ?? await context.newPage();
      for (const entry of routes) await install(entry.pattern, entry.handler);
    }
    async function install(pattern: string | RegExp, handler: (route: any) => any) {
      await page.route(pattern, (route: Route) => handler({
        request: { url: route.request().url(), method: route.request().method(), headers: route.request().headers(), postData: route.request().postData() },
        continue: (options: any) => route.continue(options), abort: () => route.abort(),
      }));
    }
    const browser = queries(() => page, {
      back: async () => { await page.goBack(); await observe(); },
      cookies: () => context!.cookies(),
      route: async (pattern: string | RegExp, handler: (route: any) => any) => { routes.push({ pattern, handler }); await install(pattern, handler); },
      waitForDownload: async (trigger: () => Promise<void>, options?: { timeout?: number }) => {
        const download = page.waitForEvent('download', options);
        await trigger();
        const result = await download;
        const absolutePath = await result.path();
        if (!absolutePath) throw new Error('Download has no actual local file');
        return { absolutePath, path: absolutePath, suggestedFilename: result.suggestedFilename() };
      },
      goto: async (url: string) => { await page.goto(url); await observe(); },
      reload: async () => { await page.reload(); await observe(); },
    }, observe);
    const app = {
      open: async (path = '/') => { await page.goto(new URL(path, origins[0]).href); await observe(); },
      clearState: async () => { await close(); await open(); await page.goto(origins[0]); await observe(); },
    };
    try {
      await open();
      await use({ browser, screen: browser, app: app as App });
      await observe();
      expect(unexpected).toEqual([]);
    } finally {
      if (info.status !== 'passed' && page && !page.isClosed()) {
        try {
          const frames = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(frame => {
            const doc = frame.contentDocument;
            if (!doc) return { title: frame.title, readable: false };
            const region = doc.querySelector('[aria-label="PDF 连续阅读"]');
            return { title: frame.title, readable: true, path: frame.contentWindow!.location.pathname,
              page: new URL(frame.contentWindow!.location.href).searchParams.get('page'),
              frame: frame.getBoundingClientRect().toJSON(), scrollTop: region?.scrollTop,
              region: region?.getBoundingClientRect().toJSON(), toolbar: doc.querySelector('[role="toolbar"]')?.textContent,
              links: Array.from(doc.querySelectorAll('.linkAnnotation a')).map(link => ({ href: link.getAttribute('href'), box: link.getBoundingClientRect().toJSON() })),
              pages: Array.from(doc.querySelectorAll('.feed-reader-page')).map(sheet => ({ box: sheet.getBoundingClientRect().toJSON(), offsetTop: (sheet as HTMLElement).offsetTop })) };
          }));
          await writeFile(join(out, `native-failure-${info.testId}.json`), JSON.stringify({ attemptId, testId: info.testId, frames }, null, 2));
        } catch (error) { errors.push(error); }
      }
      try { await close(); } catch (error) { errors.push(error); }
      for (const entry of profiles.filter(entry => !entry.removed)) {
        try { await rm(entry.path, { recursive: true, force: true }); entry.removed = true; } catch (error) { errors.push(error); }
      }
      const cleanup = errors.length || profiles.some(entry => !entry.removed || !entry.disconnected) ? 'failed' : 'complete';
      await writeFile(join(out, `browser-cleanup-${engine}-${info.testId}.json`), JSON.stringify({
        testId: info.testId, attemptId, title: info.title, retry: info.retry, engine,
        exited: profiles.length > 0 && profiles.every(entry => entry.disconnected),
        profileRemoved: profiles.length > 0 && profiles.every(entry => entry.removed),
        cleanup, headless: true, profiles, viewports, unexpected, errors: errors.map(String),
      }, null, 2));
      if (cleanup !== 'complete') throw new AggregateError(errors, 'Native browser cleanup failed');
    }
  },
});

type Body = (surfaces: Surfaces) => void | Promise<void>;
export const test = Object.assign((title: string, body: Body) => native(title, async ({ surfaces }) => body(surfaces)), {
  beforeEach: (body: Body) => native.beforeEach(async ({ surfaces }) => body(surfaces)),
  afterEach: (body: Body) => native.afterEach(async ({ surfaces }) => body(surfaces)),
});
