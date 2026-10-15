import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AUTH_E2E_COMMIT, FEED_E2E_BASE_COMMIT, setFeedEntitlements, startFeedRuntime } from './runtime.mjs';

const authInput = process.env.FEED_E2E_AUTH_CHECKOUT;
const ingestion = process.env.FEED_E2E_SUITE === 'ingestion';
if (process.env.FEED_E2E_SUITE && !ingestion) throw new Error('Unknown FEED_E2E_SUITE');
if (!authInput) throw new Error('FEED_E2E_AUTH_CHECKOUT is required (a clean pinned checkout inside .e2e)');
const authDir = resolve(authInput);
const outputRoot = resolve('.e2e');
if (!isChild(outputRoot, authDir) || !isChild(await realpath(outputRoot), await realpath(authDir))) throw new Error('Auth build checkout must be inside this worktree .e2e directory');
for (const path of ['node_modules', 'frontend/node_modules']) {
  if (!isChild(await realpath(authDir), await realpath(join(authDir, path)))) throw new Error('Auth dependencies must be private copies, not links to another checkout');
}
const authCommit = git(['-C', authDir, 'rev-parse', 'HEAD']);
if (authCommit !== AUTH_E2E_COMMIT) throw new Error(`Auth commit must be ${AUTH_E2E_COMMIT}`);
if (git(['-C', authDir, 'status', '--porcelain'])) throw new Error('Pinned Auth checkout must remain clean');
const feedCommit = git(['rev-parse', 'HEAD']);
execFileSync('git', ['merge-base', '--is-ancestor', FEED_E2E_BASE_COMMIT, feedCommit]);
const feedDirty = Boolean(git(['status', '--porcelain']));
const output = resolve(process.env.FEED_E2E_OUTPUT || `.e2e/run-${Date.now()}-${process.pid}`);
if (!isChild(outputRoot, output) || isChild(authDir, output) || output === authDir) throw new Error('E2E output must be a fresh child of .e2e outside the Auth checkout');
await mkdir(outputRoot, { recursive: true });
await mkdir(output);
const buildDir = join(output, 'build');
const browserDir = resolve('.e2e/browser-cache');
const privateHome = join(output, '.home');
await mkdir(buildDir);
await mkdir(privateHome);
const isolatedEnv = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  CI: process.env.CI,
  HOME: privateHome,
  XDG_CONFIG_HOME: join(privateHome, '.config'),
  WRANGLER_SEND_METRICS: 'false',
  DO_NOT_TRACK: '1',
  E2E_TELEMETRY_DISABLED: '1',
  PLAYWRIGHT_BROWSERS_PATH: browserDir,
};
const manifest = {
  suite: ingestion ? 'ingestion' : 'reader',
  disableConsumers: process.env.FEED_E2E_DISABLE_CONSUMERS === '1',
  feedCommit, feedBase: FEED_E2E_BASE_COMMIT, feedDirty, authCommit,
  sourceDigest: await sourceDigest(),
  runner: 'e2e@0.21.0', engine: '@e2e-dev/web@0.15.0', node: process.version,
  variants: [], errors: [],
};
const faults = { assertion: process.env.FEED_E2E_BREAK_ASSERTION || '', cleanup: process.env.FEED_E2E_FAIL_CLEANUP === '1' };

try {
  build(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'e2e/tsconfig.json']);
  build(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
  build(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { env: { VITE_POSTHOG_PROJECT_TOKEN: '', VITE_POSTHOG_HOST: '' } });
  build(process.execPath, ['scripts/copy-pdf-assets.mjs']);
  build(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', 'e2e/wrangler.jsonc', '--outdir', join(buildDir, 'feed')]);
  build('npm', ['--prefix', 'frontend', 'run', 'build'], { cwd: authDir, env: { VITE_POSTHOG_PROJECT_TOKEN: '', VITE_POSTHOG_HOST: '' } });
  build(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--config', 'e2e/wrangler.jsonc', '--outdir', join(buildDir, 'auth')], { cwd: authDir });
  build(process.execPath, ['node_modules/@e2e-dev/web/dist/bin.js', 'install', 'chromium']);
  manifest.bundles = {
    feed: sha(await readFile(join(buildDir, 'feed/index.js'))),
    auth: sha(await readFile(join(buildDir, 'auth/index.js'))),
  };

  const variants = process.env.FEED_E2E_VARIANT ? [process.env.FEED_E2E_VARIANT] : ['desktop', 'mobile'];
  if (variants.some(v => !['desktop', 'mobile'].includes(v))) throw new Error('Invalid FEED_E2E_VARIANT');
  for (const variant of variants) {
    const variantDir = join(output, variant);
    await mkdir(variantDir);
    const evidence = { variant, errors: [], cleanup: { status: 'pending' } };
    manifest.variants.push(evidence);
    let runtime;
    let accounts = {};
    let rawLog = '';
    try {
      runtime = await startFeedRuntime({ buildDir, stateDir: join(variantDir, '.runtime'), authDir, ingestion,
        disableConsumers: process.env.FEED_E2E_DISABLE_CONSUMERS === '1' });
      if (process.env.FEED_E2E_FAIL_STARTUP === '1') throw new Error('Injected startup failure after real Worker initialization');
      evidence.readiness = runtime.readiness;
      evidence.migrations = runtime.migrations;
      evidence.baseline = runtime.baseline;
      console.log(`Real Feed/Auth ready (${variant}); synthetic isolated storage`);
      const { prepareAccount } = await import(pathToFileURL(join(authDir, 'e2e/prepare-account.mjs')).href);
      accounts.password = `Feed-E2e-${randomBytes(18).toString('base64url')}`;
      for (const role of ['owner', 'reject', 'other']) {
        const email = `feed-${variant}-${role}-${randomBytes(9).toString('hex')}@example.test`;
        accounts[role] = await prepareAccount(
          { ...runtime, db: runtime.authDb, origin: new URL(runtime.authOrigin).origin },
          { email, password: accounts.password, name: `FEED E2E ${role}` },
        );
        await setFeedEntitlements(runtime.authDb, accounts[role].userId, { access: true, limit: role === 'owner' ? 3 : 1 });
      }
      const childEnv = {
        ...isolatedEnv,
        FEED_E2E_APP_URL: runtime.feedOrigin, FEED_E2E_AUTH_URL: runtime.authOrigin,
        FEED_E2E_CONTROL_URL: runtime.controlOrigin, FEED_E2E_CONTROL_SECRET: runtime.controlSecret,
        FEED_E2E_OUTPUT: variantDir, FEED_E2E_MOBILE: variant === 'mobile' ? '1' : '',
        FEED_E2E_BREAK_ASSERTION: faults.assertion,
        FEED_E2E_SUITE: ingestion ? 'ingestion' : '',
        FEED_E2E_ADMIN_TOKEN: runtime.ingestion?.bindings.ADMIN_TOKEN ?? '',
        FEED_E2E_STOCK_BROWSER: process.env.FEED_E2E_STOCK_BROWSER || '',
        FEED_E2E_OWNER_ID: accounts.owner.userId, FEED_E2E_OTHER_ID: accounts.other.userId,
      };
      for (const role of ['owner', 'reject', 'other']) {
        childEnv[`FEED_E2E_${role.toUpperCase()}_EMAIL`] = accounts[role].email;
        childEnv[`FEED_E2E_${role.toUpperCase()}_PASSWORD`] = accounts.password;
      }
      const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', '--config', 'e2e.config.ts', '--output', variantDir, ...process.argv.slice(2)], {
        stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { rawLog += chunk; });
      const stop = () => child.kill('SIGTERM');
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        evidence.runnerExit = await new Promise((done, fail) => {
          child.once('error', fail);
          child.once('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
        });
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      let report;
      try { report = JSON.parse(await readFile(join(variantDir, 'report.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new Error(`e2e exited ${evidence.runnerExit} without a report; original startup/collection error is in runner.log`);
      }
      evidence.summary = report.run.summary;
      const s = evidence.summary;
      if (!s.executed || s.skipped || s.interrupted || s.flaky) throw new Error('Required suite was empty, skipped, interrupted or flaky');
      if (evidence.runnerExit !== 0 || s.failed || report.run.status !== 'passed') throw new Error(`Browser suite failed (exit ${evidence.runnerExit})`);
      if (!process.env.FEED_E2E_STOCK_BROWSER) {
        const receipts = (await readdir(variantDir)).filter(p => p.startsWith('browser-cleanup-'));
        if (!receipts.length) throw new Error('No browser cleanup receipt');
        for (const receipt of receipts) {
          const clean = JSON.parse(await readFile(join(variantDir, receipt), 'utf8'));
          if (clean.exited !== true || clean.profileRemoved !== true) throw new Error('Browser cleanup readback failed');
        }
        evidence.browserCleanup = { status: 'passed', receipts: receipts.length };
      }
    } catch (error) {
      evidence.errors.push(...errorMessages(error));
      if (error.cleanup) evidence.cleanup = error.cleanup;
    } finally {
      if (runtime?.ingestion) {
        try {
          await writeFile(join(variantDir, 'ingestion.json'), JSON.stringify(await runtime.ingestion.control({ action: 'ingestion-state' }, { mf: null, db: runtime.feedDb }), null, 2));
        } catch (error) { evidence.errors.push(`Ingestion evidence readback failed: ${error.message}`); }
      }
      let runtimeSensitive = [];
      try { runtimeSensitive = await runtime?.sensitiveValues() ?? []; }
      catch { evidence.errors.push('Sensitive-value inventory failed; public export withheld'); }
      const values = [accounts.password, ...Object.values(accounts).map(a => a?.email), ...runtimeSensitive].filter(Boolean);
      evidence.observations = runtime?.observations ?? [];
      try {
        if (runtime) evidence.cleanup = { status: 'passed', ...(await runtime.close()) };
        else if (evidence.cleanup.status === 'pending') evidence.cleanup = { status: 'not-started' };
        if (faults.cleanup) throw new Error('Injected cleanup failure after successful physical cleanup');
      } catch (error) {
        evidence.cleanup.status = 'failed';
        evidence.errors.push(...errorMessages(error));
      }
      const cleanLog = redact(rawLog, values);
      await writeFile(join(variantDir, 'runner.log'), cleanLog);
      process.stdout.write(cleanLog);
      // Export copies only. Preserve the original runner report and failure evidence.
      if (!evidence.errors.includes('Sensitive-value inventory failed; public export withheld')) await exportPublic(variantDir, join(output, 'public', variant), values);
      await mkdir(join(output, 'public', variant), { recursive: true });
      await writeFile(join(output, 'public', variant, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
      if (evidence.errors.length) manifest.errors.push(...evidence.errors);
    }
    if (manifest.errors.length) break;
  }
} catch (error) {
  manifest.errors.push(...errorMessages(error));
} finally {
  await mkdir(join(output, 'public'), { recursive: true });
  await writeFile(join(output, 'public/run.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (manifest.errors.length) {
    process.exitCode = 1;
    console.error(manifest.errors.join('\n'));
  }
  console.log(`Evidence: ${relative(process.cwd(), output)}/public`);
}

function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isChild(parent, path) { const r = relative(parent, path); return r !== '' && r !== '..' && !r.startsWith('../') && !r.startsWith('/'); }
function errorMessages(error) { return error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [error.message]; }
function build(command, args, { cwd = process.cwd(), env = {} } = {}) {
  try {
    execFileSync(command, args, { cwd, env: { ...isolatedEnv, ...env, WRANGLER_LOG_PATH: join(buildDir, `${cwd === authDir ? 'auth' : 'feed'}-wrangler.log`) }, stdio: 'pipe' });
  } catch (error) {
    // Toolchain errors contain no accounts: all builds run before account preparation.
    throw new Error(`Build failed: ${command} ${args.join(' ')}\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`);
  }
}
async function sourceDigest() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const hashes = [];
  for (const path of paths) {
    if (!/^(src\/|worker\/|e2e\/|public\/|scripts\/|migrations\/|tests\/helpers\/mixed-pdf\.mjs$|tsconfig|e2e\.config|package\.json|pnpm-|\.github\/|\.design\/|\.nvmrc|vite\.config|index\.html)/.test(path)) continue;
    hashes.push([path, sha(await readFile(path))]);
  }
  return { sha256: sha(JSON.stringify(hashes)), files: Object.fromEntries(hashes) };
}
function redact(input, values) {
  let text = input;
  for (const value of values) {
    text = text.replaceAll(value, '[redacted]').replaceAll(encodeURIComponent(value), '[redacted]');
  }
  return text
    .replace(/([?&])(?:token|state|code|nonce)=[^&\s"'<>]+/g, '$1redacted')
    .replace(/(?:token|state|code|nonce)%3D[^%\s"'<>]+/gi, 'redacted')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._+/=-]+/gi, '$1[redacted]')
    .replace(/__(?:Host-)?feed_(?:session|login)=[^;\s"']+/gi, '__Host-feed_session=[redacted]');
}
async function exportPublic(source, destination, values) {
  await mkdir(destination, { recursive: true });
  async function copy(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'public') continue;
      const src = join(from, entry.name), dst = join(to, entry.name);
      if (entry.isDirectory()) await copy(src, dst);
      else if (entry.name.endsWith('.json')) {
        const parsed = JSON.parse(await readFile(src, 'utf8'));
        const clean = (value) => typeof value === 'string' ? redact(value, values)
          : Array.isArray(value) ? value.map(clean)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v)]))
          : value;
        await writeFile(dst, JSON.stringify(clean(parsed), null, 2) + '\n');
      } else if (/\.(txt|md|log)$/.test(entry.name)) await writeFile(dst, redact(await readFile(src, 'utf8'), values));
      // This suite never restores cookies: e2e withholds pixels after the first credential fill.
      else if (entry.name.endsWith('.png')) await copyFile(src, dst);
    }
  }
  await copy(source, destination);
  // Text redaction changes byte counts; exported artifact metadata must describe exported bytes.
  const reportPath = join(destination, 'report.json');
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  async function update(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.artifacts)) {
      const artifacts = [];
      for (const artifact of value.artifacts) {
        try {
          const bytes = await readFile(join(destination, 'results', artifact.path));
          artifacts.push({ ...artifact, size: bytes.byteLength, sha256: sha(bytes) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      value.artifacts = artifacts;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) { for (const item of child) await update(item); }
      else if (child && typeof child === 'object') await update(child);
    }
  }
  await update(report);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(json|txt|md|log)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        if (values.some(value => value && (text.includes(value) || text.includes(encodeURIComponent(value))))) throw new Error('Sensitive synthetic value in public evidence');
      }
    }
  }
  await inspect(destination);
}
