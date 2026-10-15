import type { E2EConfig } from 'e2e';
import { web, type BrowserProvider } from '@e2e-dev/web';
import { chromium, type BrowserContext } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const browsers = new Map<string, { context: BrowserContext; profile: string; port: number }>();
const localChromium: BrowserProvider = {
  name: 'feed-local-chromium',
  scope: 'worker',
  async acquire(request) {
    const id = `${request.targetName}-${request.slot}`;
    const profileRoot = join(process.env.FEED_E2E_OUTPUT!, '.profiles');
    await mkdir(profileRoot, { recursive: true });
    const profile = await mkdtemp(join(profileRoot, `${id}-`));
    let context: BrowserContext | undefined;
    try {
      // e2e 0.15 has no TLS context option. Its BrowserProvider interface keeps all test operations in e2e.
      context = await chromium.launchPersistentContext(profile, {
        executablePath: chromium.executablePath(),
        headless: true,
        args: ['--ignore-certificate-errors', '--remote-debugging-port=0', '--no-proxy-server',
          '--password-store=basic', '--use-mock-keychain', '--enable-automation'],
        timeout: 10000,
      });
      const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
      const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
      await cdp.detach();
      const isolation = {
        headless: args.some(arg => arg.startsWith('--headless')),
        passwordStoreBasic: args.includes('--password-store=basic'),
        mockKeychain: args.includes('--use-mock-keychain'),
      };
      await writeFile(join(process.env.FEED_E2E_OUTPUT!, `browser-isolation-${id}.json`), JSON.stringify(isolation));
      if (Object.values(isolation).some(enabled => !enabled)) throw new Error('Browser credential-store isolation flags are missing');
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      browsers.set(id, { context, profile, port: Number(port) });
      return { id, cdpEndpoint: `ws://127.0.0.1:${port}${path}` };
    } catch (error) {
      const cleanup = await Promise.allSettled([context?.close()]);
      cleanup.push(...await Promise.allSettled([rm(profile, { recursive: true, force: true })]));
      throw new AggregateError([error, ...cleanup.filter(r => r.status === 'rejected').map(r => r.reason)], `Chromium acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  async release(lease) {
    const entry = browsers.get(lease.id);
    if (!entry) throw new Error('Missing browser lease');
    browsers.delete(lease.id);
    const errors: unknown[] = [];
    try { await entry.context.close(); } catch (error) { errors.push(error); }
    try {
      await new Promise<void>((done, fail) => {
        const socket = createConnection({ host: '127.0.0.1', port: entry.port });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); fail(new Error('Chromium CDP remains open')); });
        socket.once('timeout', () => { socket.destroy(); fail(new Error('Chromium cleanup readback timed out')); });
        socket.once('error', error => error.message.includes('ECONNREFUSED') ? done() : fail(error));
      });
      await rm(entry.profile, { recursive: true, force: true });
      await stat(entry.profile).then(() => { throw new Error('Browser profile remains'); }, error => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Browser cleanup failed');
    await writeFile(join(process.env.FEED_E2E_OUTPUT!, `browser-cleanup-${lease.id}.json`), JSON.stringify({ exited: true, cdpPortClosed: entry.port, profileRemoved: true }));
  },
};

for (const key of ['FEED_E2E_APP_URL', 'FEED_E2E_AUTH_URL', 'FEED_E2E_OUTPUT', 'FEED_E2E_CONTROL_URL', 'FEED_E2E_CONTROL_SECRET']) {
  if (!process.env[key]) throw new Error(`${key} is required; use pnpm test:e2e`);
}

export default {
  credentials: Object.fromEntries(['owner', 'reject', 'other'].map(role => [role, {
    username: process.env[`FEED_E2E_${role.toUpperCase()}_EMAIL`]!,
    password: process.env[`FEED_E2E_${role.toUpperCase()}_PASSWORD`]!,
  }])),
  tests: process.env.FEED_E2E_SUITE === 'ingestion'
    ? ['e2e/ingestion.e2e.ts']
    : ['e2e/**/*.e2e.ts', '!e2e/ingestion.e2e.ts'],
  workers: 1,
  retries: 0,
  timeout: process.env.FEED_E2E_SUITE === 'ingestion' ? 300000 : 120000,
  assertionTimeout: 10000,
  output: process.env.FEED_E2E_OUTPUT!,
  targets: [{
    name: process.env.FEED_E2E_MOBILE ? 'mobile' : 'desktop',
    engine: web({
      browser: process.env.FEED_E2E_STOCK_BROWSER ? (process.env.FEED_E2E_BROWSER as 'chromium' | 'firefox' | 'webkit' ?? 'chromium') : localChromium,
      viewport: process.env.FEED_E2E_MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    }),
    app: { url: process.env.FEED_E2E_APP_URL! },
  }],
} satisfies E2EConfig;
