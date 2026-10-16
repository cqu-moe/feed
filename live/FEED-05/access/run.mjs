import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateIsolation } from '../generate-config.mjs';
import { verifyImmutableProductBase } from '../source-guard.mjs';
import { BASE, PROJECT, ROOT, mode, requireThat as check } from '../browser/state.mjs';

process.umask(0o077);
check(resolve(process.cwd()) === resolve(PROJECT), 'RUN_FROM_LIVE_FEED');
const selected = mode(process.argv.slice(2));
const config = 'feed.access.live.config.ts';
const cli = 'node_modules/e2e/dist/cli/bin.js';
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: '1', NO_COLOR: '1',
  DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' };
if (selected === '--check') {
  const directory = resolve('live/FEED-05/access/.offline'); await mkdir(directory, { recursive: true, mode: 0o700 });
  async function offline(name, args, expected = 0) {
    const result = spawnSync(process.execPath, ['--import', resolve('live/FEED-05/access/offline-guard.mjs'), ...args], {
      env: { ...env, FEED05_MODE: 'offline' }, encoding: 'utf8', timeout: 60000,
    });
    await writeFile(`${directory}/${name}.log`, (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600 });
    check(!result.error && result.signal === null && result.status === expected, `OFFLINE_${name}_EXIT`);
    return result;
  }
  await offline('safety', ['--test', 'live/FEED-05/access/safety.test.mjs']);
  await offline('totp', ['--test', 'live/FEED-05/access/totp.test.mjs']);
  await offline('types', ['node_modules/typescript/bin/tsc', '-p', 'live/FEED-05/access/tsconfig.json']);
  const listed = await offline('discovery', [cli, 'list', '--config', config, '--reporter', 'json']);
  const pairs = JSON.parse(listed.stdout).pairs.filter(p => p.kind === 'test' && p.disposition === 'run');
  check(pairs.length === 1 && pairs[0].title === 'FEED05 isolated owner access revocation and exact restoration', 'EXACT_ONE_ACCESS_TEST');
  const zero = await offline('zero', [cli, 'run', '--config', config, '--grep', '^FEED05_ACCESS_ZERO_SELECTION$'], 2);
  const run = JSON.parse(zero.stdout).run;
  check(run.status === 'error' && run.exitCode === 2 && run.results.length === 0
    && run.summary.selected === 0 && run.summary.executed === 0 && run.errors.length === 1
    && run.errors[0].code === 'NO_TESTS' && run.errors[0].phase === 'collection', 'ZERO_CONTROL_REASON');
  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: 'offline-passed', safetyFiles: 2, discovered: 1,
    zeroSelectionExit: 2, remoteRequests: 0, browserLaunches: 0, privateAccountReads: 0, actualAccessRevocationRun: false,
    restoreContract: 'Exact existing feed.access=1 and feed.sub_limit=3 baseline only; quota semantics unchanged; full-set PUT may rebuild updatedAt.' }, null, 2), { mode: 0o600 });
  console.log('FEED05 access offline checks passed; exact two-row semantic restore prepared; no live requests');
} else {
  const sourceGuard = await verifyImmutableProductBase();
  const isolationErrors = validateIsolation(JSON.parse(await readFile('live/FEED-05/generated/wrangler.json', 'utf8')));
  check(isolationErrors.length === 0, 'ISOLATION_CONFIG_INVALID');
  const { chromium } = await import('@playwright/test'); const executable = chromium.executablePath(); await access(executable, constants.X_OK);
  const out = `${ROOT}/access-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(out, { recursive: true, mode: 0o700 }); await mkdir(`${out}/.home`, { mode: 0o700 });
  const paths = ['config.ts', 'admin.mjs', 'access.live.e2e.ts', 'run.mjs', 'offline-guard.mjs', 'safety.test.mjs', 'totp.mjs', 'totp.test.mjs'].map(p => `live/FEED-05/access/${p}`)
    .concat(['feed.access.live.config.ts', 'package.json', 'pnpm-lock.yaml', 'live/FEED-05/browser/provider.ts', 'live/FEED-05/browser/state.mjs', 'live/FEED-05/source-guard.mjs']);
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  await writeFile(`${out}/source-manifest.json`, JSON.stringify({ source: BASE, sourceGuard, harness: hashes }, null, 2), { mode: 0o600 });
  const log = createWriteStream(`${out}/runner.log`, { flags: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'run', '--config', config, '--trace', 'off', '--video', 'off'], {
    env: { ...env, HOME: `${out}/.home`, XDG_CONFIG_HOME: `${out}/.home/.config`, FEED05_MODE: 'execute', FEED05_OUTPUT: out, FEED05_CHROMIUM_PATH: executable },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const stop = () => child.kill('SIGINT'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const exit = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })); });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await new Promise(done => log.end(done));
  let report, result, browser;
  try { report = JSON.parse(await readFile(`${out}/report.json`, 'utf8')); } catch { /* missing evidence fails below */ }
  try { result = (await readFile(`${out}/intent.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse).findLast(r => r.phase === 'result'); } catch { /* missing evidence fails below */ }
  try { browser = JSON.parse(await readFile(`${out}/browser-cleanup.json`, 'utf8')); } catch { /* missing evidence fails below */ }
  const attempt = report?.run?.results.filter(r => r.kind === 'test' && r.selected).flatMap(r => r.attempts ?? []);
  const count = report?.run?.summary;
  const passed = exit.code === 0 && exit.signal === null && report?.run?.status === 'passed'
    && count?.selected === 1 && count.executed === 1 && count.passed === 1 && !count.failed && !count.skipped && !count.interrupted && !count.flaky
    && attempt?.length === 1 && attempt[0].status === 'passed' && attempt[0].cleanup === 'complete'
    && Array.isArray(attempt[0].secondaryErrors) && attempt[0].secondaryErrors.length === 0
    && Array.isArray(report.run.errors) && report.run.errors.length === 0
    && result?.primaryFailed === false && result.cleanupFailures === 0
    && result.completed?.includes('access-denied') && result.completed?.includes('owner-access-recovered')
    && browser?.exited === true && browser.profileRemoved === true && browser.cdpClosed === true;
  await writeFile(`${out}/shareable-summary.json`, JSON.stringify({ passed, source: BASE, exit, selected: count?.selected ?? 0,
    executed: count?.executed ?? 0, primaryFailed: result?.primaryFailed !== false, cleanupFailures: result?.cleanupFailures ?? 1,
    accessDenied: result?.completed?.includes('access-denied') ?? false, recovered: result?.completed?.includes('owner-access-recovered') ?? false,
    browserCleaned: browser?.exited === true && browser?.profileRemoved === true && browser?.cdpClosed === true, rawArtifacts: 'private-only' }, null, 2), { mode: 0o600 });
  async function secure(path) { const info = await lstat(path); if (info.isSymbolicLink()) return; await chmod(path, info.isDirectory() ? 0o700 : 0o600); if (info.isDirectory()) for (const name of await readdir(path)) await secure(`${path}/${name}`); }
  await secure(out); console.log(JSON.stringify({ passed, privateOutput: out })); process.exitCode = passed ? 0 : 1;
}
