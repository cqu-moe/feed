import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ACCOUNT_ID, FEED_ORIGIN, AUTH_ORIGIN, buildIsolatedConfig, PRODUCTION_D1_ID } from '../generate-config.mjs';
import { PROJECT, ROOT } from '../browser/state.mjs';
import { verifyImmutableProductBase } from '../source-guard.mjs';

const guard = resolve('live/FEED-05/controls/guard.mjs');
const entries = ['browser', 'access'].map(p => `live/FEED-05/${p}/run.mjs`);
const configPath = resolve('live/FEED-05/generated/wrangler.json');
const generated = resolve('live/FEED-05/generated');
const valid = () => buildIsolatedConfig({ accountId: ACCOUNT_ID, feedOrigin: FEED_ORIGIN,
  authOrigin: AUTH_ORIGIN, d1DatabaseId: '22222222-3333-4444-8555-666666666666' });
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: '1', NO_COLOR: '1',
  DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', FEED05_MODE: 'offline' };
function run(entry, args = [], extra = {}) {
  return spawnSync(process.execPath, ['--import', guard, entry, ...args], {
    cwd: PROJECT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000,
  });
}
function rejected(result, reason) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, reason);
  assert.doesNotMatch(result.stdout + result.stderr, /CONTROL_PRIVATE_READ_FORBIDDEN|CONTROL_NETWORK_OR_PROCESS_FORBIDDEN/);
}

test('actual launchers reject invalid config before the browser dependency boundary', async t => {
  // Exclusive synthetic config: never replace a parent's existing local config.
  await mkdir(generated, { mode: 0o700 });
  try {
    await writeFile(configPath, JSON.stringify(valid()), { flag: 'wx', mode: 0o600 });
    for (const entry of entries) {
      rejected(run(entry, ['--run']), /CONTROL_BROWSER_BOUNDARY/);
      for (const [name, change] of [
        ['mail enabled', c => { c.vars.MAIL_ENABLED = 'true'; }],
        ['production D1', c => { c.d1_databases[0].database_id = PRODUCTION_D1_ID; }],
        ['missing binding', c => { c.services = []; }],
      ]) await t.test(`${entry}: ${name}`, async () => {
        const config = valid(); change(config);
        await writeFile(configPath, JSON.stringify(config));
        const result = run(entry, ['--run']);
        rejected(result, /ISOLATION_CONFIG_INVALID/);
        assert.doesNotMatch(result.stderr, /CONTROL_BROWSER_BOUNDARY/);
      });
      await writeFile(configPath, JSON.stringify(valid()));
    }
  } finally { await unlink(configPath); await rmdir(generated); }
});

test('actual product guard detects each real vendored tarball mutation and ignored additions', async t => {
  const deps = JSON.parse(await readFile('package.json', 'utf8')).dependencies;
  for (const [name, spec] of Object.entries(deps).filter(([, v]) => v.startsWith('file:'))) {
    await t.test(name, async () => {
      const path = spec.slice(5), before = await readFile(path);
      try {
        await writeFile(path, Buffer.concat([before, Buffer.from('offline-control')]));
        await assert.rejects(verifyImmutableProductBase(), /PRODUCT_PATHS_CHANGED_FROM_DEPLOYED_BASE/);
      } finally { await writeFile(path, before); }
      assert.deepEqual(await readFile(path), before);
    });
  }
  await t.test('ignored nontracked file', async () => {
    const path = '.design/.DS_Store';
    await writeFile(path, 'offline-control', { flag: 'wx' });
    try { await assert.rejects(verifyImmutableProductBase(), /UNTRACKED_PRODUCT_PATH/); }
    finally { await unlink(path); }
  });
  const inventory = (await verifyImmutableProductBase()).fileHashes;
  for (const spec of Object.values(deps).filter(v => v.startsWith('file:'))) {
    const path = spec.slice(5).replace(/^\.\//, '');
    assert.equal(inventory[path], createHash('sha256').update(await readFile(path)).digest('hex'));
  }
});

test('real caller and filesystem failure chains survive journal and framework boundaries', async t => {
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  for (const scenario of ['journal-write', 'journal-sync', 'subscription', 'access', 'provider', 'result-io', 'result-write-io', 'all-io']) {
    await t.test(scenario, async () => {
      const out = await mkdtemp(`${ROOT}/offline-${scenario}-`);
      const result = run('live/FEED-05/controls/failure-probe.mjs', [scenario], { FEED05_OUTPUT: out });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true });
    });
  }
});
