import { spawnSync, spawn } from 'node:child_process';
import { createWriteStream, constants } from 'node:fs';
import { access, mkdir, readFile, writeFile, chmod, readdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateIsolation } from '../generate-config.mjs';
import { verifyImmutableProductBase } from '../source-guard.mjs';
import { AUTH, BASE, FEED, PROJECT, ROOT, mode, requireThat as check } from './state.mjs';

process.umask(0o077);
check(resolve(process.cwd()) === resolve(PROJECT), 'RUN_FROM_LIVE_FEED');
const selected = mode(process.argv.slice(2));
const cli = 'node_modules/e2e/dist/cli/bin.js';
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: '1', NO_COLOR: '1',
  DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' };
if (selected === '--check') {
  const dir = resolve('live/FEED-05/browser/.offline');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  function offline(name, argv, expected = 0) {
    const r = spawnSync(process.execPath, argv, { env: { ...env, FEED05_MODE: 'offline' }, encoding: 'utf8' });
    return writeFile(`${dir}/${name}.log`, (r.stdout ?? '') + (r.stderr ?? ''), { mode: 0o600 }).then(() => {
      check(!r.error && r.status === expected, `OFFLINE_${name}_EXIT`); return r;
    });
  }
  await offline('safety', ['--test', 'live/FEED-05/browser/safety.test.mjs']);
  await offline('types', ['node_modules/typescript/bin/tsc', '-p', 'live/FEED-05/browser/tsconfig.json']);
  const listed = await offline('discovery', [cli, 'list', '--config', 'feed.live.config.ts', '--reporter', 'json']);
  const pairs = JSON.parse(listed.stdout).pairs.filter(p => p.kind === 'test' && p.disposition === 'run');
  check(pairs.length === 1 && pairs[0].title.startsWith('FEED05 isolated real OAuth'), 'DISCOVERY_EXACT_ONE');
  const zero = await offline('zero', [cli, 'run', '--config', 'feed.live.config.ts', '--grep', '^FEED05_ZERO_SELECTION$'], 2);
  const empty = JSON.parse(zero.stdout).run;
  check(empty.status === 'error' && empty.exitCode === 2 && empty.results.length === 0
    && empty.summary.selected === 0 && empty.summary.executed === 0
    && empty.errors.length === 1 && empty.errors[0].category === 'configuration'
    && empty.errors[0].code === 'NO_TESTS' && empty.errors[0].phase === 'collection', 'ZERO_CONTROL_REASON');
  await writeFile(`${dir}/receipt.json`, JSON.stringify({ offline: true, remoteRequests: 0, selected: pairs.map(p => p.id),
    zero: { exit: 2, reason: 'NO_TESTS (collection)' }, actualBusinessRun: false }, null, 2), { mode: 0o600 });
  console.log('FEED05 offline checks passed; no live business executed');
} else {
  const sourceGuard = await verifyImmutableProductBase();
  // Offline deployment shape is a prerequisite, not proof of what is currently deployed.
  const isolationErrors = validateIsolation(JSON.parse(await readFile('live/FEED-05/generated/wrangler.json', 'utf8')));
  check(isolationErrors.length === 0, 'ISOLATION_CONFIG_INVALID');
  // Resolve the installed binary before replacing HOME with the disposable home.
  const { chromium } = await import('@playwright/test');
  const executable = chromium.executablePath(); await access(executable, constants.X_OK);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  const out = `${ROOT}/${id}`; await mkdir(out, { mode: 0o700 });
  const paths = ['feed.live.config.ts', 'package.json', 'pnpm-lock.yaml',
    ...['run.mjs', 'state.mjs', 'provider.ts', 'subscriptions.live.e2e.ts', 'safety.test.mjs'].map(name => `live/FEED-05/browser/${name}`),
    'live/FEED-05/source-guard.mjs'];
  const hashes = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  await writeFile(`${out}/source-manifest.json`, JSON.stringify({ source: BASE, sourceGuard, harness: hashes }, null, 2), { mode: 0o600 });
  await mkdir(`${out}/.home`, { mode: 0o700 });
  const log = createWriteStream(`${out}/runner.log`, { flags: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'run', '--config', 'feed.live.config.ts', '--trace', 'off', '--video', 'off'], {
    env: { ...env, HOME: `${out}/.home`, XDG_CONFIG_HOME: `${out}/.home/.config`, FEED05_MODE: 'execute', FEED05_RUN_ID: id, FEED05_OUTPUT: out, FEED05_CHROMIUM_PATH: executable },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const stop = () => child.kill('SIGINT'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const exit = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })); });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  await new Promise(done => log.end(done));
  let report, result, browser;
  try { report = JSON.parse(await readFile(`${out}/report.json`, 'utf8')); } catch { /* missing evidence is a failure */ }
  try {
    const records = (await readFile(`${out}/intent.jsonl`, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    result = records.findLast(r => r.phase === 'result');
  } catch { /* missing evidence is a failure */ }
  try { browser = JSON.parse(await readFile(`${out}/browser-cleanup.json`, 'utf8')); } catch { /* missing evidence is a failure */ }
  const attempts = (report?.run?.results ?? []).filter(r => r.kind === 'test' && r.selected).flatMap(r => r.attempts ?? []);
  const steps = ['create', 'edit', 'pause', 'resume', 'rss-rotate', 'rss-revoke', 'cross-owner-delete', 'soft-delete', 'restore', 'cleanup-soft-delete'];
  const summary = { feed: FEED, auth: AUTH, source: BASE, exit, primaryFailed: result?.primaryFailed !== false,
    cleanupFailures: Number.isSafeInteger(result?.cleanupFailures) ? result.cleanupFailures : 1,
    completed: steps.filter(step => result?.completed?.includes(step)),
    attemptPassed: attempts.length === 1 && attempts[0].status === 'passed',
    attemptCleanup: attempts.length === 1 && attempts[0].cleanup === 'complete' && !attempts[0].secondaryErrors?.length,
    browserCleaned: browser?.exited === true && browser?.profileRemoved === true && browser?.cdpClosed === true,
    reading: 'unsupported-empty-archive', rawArtifacts: 'private-only' };
  const counts = report?.run?.summary;
  const passed = exit.code === 0 && report?.run?.status === 'passed' && counts?.selected === 1 && counts.executed === 1
    && counts.passed === 1 && !counts.failed && !counts.skipped && !counts.interrupted && !counts.flaky && summary.attemptPassed
    && summary.attemptCleanup && summary.browserCleaned && !summary.primaryFailed && summary.cleanupFailures === 0;
  await writeFile(`${out}/shareable-summary.json`, JSON.stringify({ ...summary, passed }, null, 2), { mode: 0o600 });
  async function secure(path) {
    const info = await lstat(path); if (info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of await readdir(path)) await secure(`${path}/${name}`);
  }
  await secure(out);
  console.log(JSON.stringify({ passed, primaryFailed: summary.primaryFailed, cleanupFailures: summary.cleanupFailures, privateOutput: out }));
  process.exitCode = passed ? 0 : 1;
}
