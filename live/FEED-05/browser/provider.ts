import type { BrowserProvider } from '@e2e-dev/web';
import { chromium, type BrowserContext } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { AUTH, FEED, output, preserveFailure, requireThat } from './state.mjs';

let lease: { context: BrowserContext; profile: string; port: number; rejected: () => number } | undefined;
export const provider: BrowserProvider = {
  name: 'feed05-private-chromium', scope: 'worker',
  async acquire() {
    requireThat(process.env.FEED05_MODE === 'execute', 'OFFLINE_BROWSER_FORBIDDEN');
    requireThat(process.env.FEED05_CHROMIUM_PATH, 'LAUNCHER_CHROMIUM_REQUIRED');
    requireThat(((await stat(output())).mode & 0o777) === 0o700, 'PRIVATE_OUTPUT_PERMISSIONS');
    const profiles = join(output(), '.profiles');
    await mkdir(profiles, { mode: 0o700 });
    const profile = await mkdtemp(join(profiles, 'chromium-'));
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block',
        executablePath: process.env.FEED05_CHROMIUM_PATH,
        args: ['--remote-debugging-port=0', '--password-store=basic', '--use-mock-keychain', '--enable-automation'] });
      let rejected = 0;
      await context.route('**/*', async route => {
        if ([FEED, AUTH].includes(new URL(route.request().url()).origin)) await route.continue();
        else { rejected++; await route.abort(); }
      });
      const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
      const { arguments: flags } = await cdp.send('Browser.getBrowserCommandLine');
      await cdp.detach();
      const isolation = { headless: flags.some(x => x.startsWith('--headless')),
        basic: flags.includes('--password-store=basic'), mock: flags.includes('--use-mock-keychain') };
      requireThat(Object.values(isolation).every(Boolean), 'BROWSER_ISOLATION');
      await writeFile(join(output(), 'isolation.json'), JSON.stringify(isolation), { mode: 0o600 });
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      lease = { context, profile, port: Number(port), rejected: () => rejected };
      return { id: 'feed05', cdpEndpoint: `ws://127.0.0.1:${port}${path}` };
    } catch (primary) {
      const cleanup = await Promise.allSettled([context?.close()]);
      cleanup.push(...await Promise.allSettled([rm(profile, { recursive: true, force: true })]));
      throw await preserveFailure('BROWSER_ACQUIRE', [primary, ...cleanup.filter(x => x.status === 'rejected').map(x => x.reason)]);
    }
  },
  async release() {
    const owned = lease; lease = undefined;
    requireThat(owned, 'BROWSER_LEASE_MISSING');
    if (!owned) return;
    const errors: unknown[] = [];
    try { await owned.context.close(); } catch (e) { errors.push(e); }
    try {
      await new Promise<void>((done, fail) => {
        const socket = createConnection({ host: '127.0.0.1', port: owned.port });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); fail(new Error('CDP_STILL_OPEN')); });
        socket.once('timeout', () => { socket.destroy(); fail(new Error('CDP_READBACK_TIMEOUT')); });
        socket.once('error', e => e.message.includes('ECONNREFUSED') ? done() : fail(e));
      });
    } catch (e) { errors.push(e); }
    if (owned.rejected()) errors.push(new Error('UNEXPECTED_BROWSER_EGRESS'));
    try {
      await rm(owned.profile, { recursive: true, force: true });
      await stat(owned.profile).then(() => { throw new Error('PROFILE_REMAINS'); }, e => { if (e.code !== 'ENOENT') throw e; });
    } catch (e) { errors.push(e); }
    if (!errors.length) {
      try { await writeFile(join(output(), 'browser-cleanup.json'), JSON.stringify({ exited: true, profileRemoved: true, cdpClosed: true }), { mode: 0o600 }); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw await preserveFailure('BROWSER_CLEANUP', errors);
  },
};
