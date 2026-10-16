import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { closeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { journal, output } from '../browser/state.mjs';

const scenario = process.argv[2];
process.env.FEED05_MODE = 'execute';
process.env.FEED05_RUN_ID = 'offline-control-run';
const root = output();
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const primary = new Error('OWNER_NAVIGATION_FAILED', { cause: new Error('transport-detail') });
const secondary = new AggregateError([new Error('cleanup-detail')], 'SIGNOUT_FAILED_DETAIL');
let observed;

if (['journal-write', 'journal-sync', 'result-io', 'result-write-io', 'all-io'].includes(scenario)) {
  await fs.writeFile(join(root, 'intent.jsonl'), '', { mode: 0o600 });
  const open = fs.open;
  fs.open = async (path, flags, mode) => {
    if (!String(path).endsWith('/intent.jsonl') && scenario !== 'all-io') return open(path, flags, mode);
    const handle = await open(path, scenario === 'journal-write' ? 'r' : flags, mode);
    if (scenario === 'journal-write') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...args) => {
        try { return await write(...args); }
        catch (error) { closeSync(handle.fd); throw error; }
      };
    } else {
      let failSync = scenario === 'journal-sync';
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...args) => {
        if (['result-io', 'result-write-io', 'all-io'].includes(scenario)) {
          failSync = /"phase":"(?:result|failure)"/.test(String(data));
          if (scenario === 'result-write-io' && failSync) closeSync(handle.fd);
        }
        return write(data, ...args);
      };
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { if (failSync) closeSync(handle.fd); return sync(); };
    }
    return handle;
  };
  syncBuiltinESMExports();
}

if (scenario.startsWith('journal-')) {
  let dispatched = false;
  try { await journal({ phase: 'intent', step: 'control-write' }); dispatched = true; }
  catch (error) { observed = error; }
  assert.equal(dispatched, false);
  assert.equal(observed?.errors?.length, 2, 'both filesystem failures survive');
  assert.match(observed.errors[0].syscall, scenario === 'journal-write' ? /write/ : /fsync/);
  assert.equal(observed.errors[1].syscall, 'close');
} else if (scenario === 'provider') {
  process.env.FEED05_CHROMIUM_PATH = 'control-never-launched';
  globalThis.controlContext = () => ({
    route: async () => { throw primary; }, close: async () => { throw secondary; },
  });
  const { provider } = await import('../browser/provider.ts');
  try { await provider.acquire(); } catch (error) { observed = error; }
  assert.ok(observed);
  assert.deepEqual(await fs.readdir(join(root, '.profiles')), []);
} else {
  await import(scenario === 'access' ? '../access/access.live.e2e.ts' : '../browser/subscriptions.live.e2e.ts');
  let navigations = 0;
  try {
    await globalThis.controlBody({ app: {}, screen: {}, browser: {
      route: async () => {}, goto: async () => { throw ++navigations === 1 ? primary : secondary; },
    } });
  } catch (error) { observed = error; }
  assert.ok(observed);
}

if (!scenario.startsWith('journal-')) {
  // The installed framework really drops aggregate members. Durable private
  // evidence must retain them independently of its bounded serialization.
  const { classifyError, serializeError } = await import('../../../node_modules/e2e/dist/internal/errors.js');
  assert.ok(serializeError(classifyError(observed)).message);
  const records = [], fallback = [];
  for (const name of await fs.readdir(root)) if (name.endsWith('.jsonl')) {
    for (const line of (await fs.readFile(join(root, name), 'utf8')).trim().split('\n')) {
      if (line) {
        records.push(JSON.parse(line));
        if (name.startsWith('failure-')) fallback.push(JSON.parse(line));
      }
    }
    assert.equal((await fs.stat(join(root, name))).mode & 0o777, 0o600);
  }
  const flatten = error => [error, ...(error?.cause ? flatten(error.cause) : []),
    ...(error instanceof AggregateError ? error.errors.flatMap(flatten) : [])];
  if (scenario === 'all-io') {
    const errors = flatten(observed);
    assert.ok(errors.includes(primary)); assert.ok(errors.includes(secondary));
    assert.ok(errors.filter(error => error?.syscall === 'fsync').length >= 3);
    assert.ok(errors.filter(error => error?.syscall === 'close').length >= 3);
    assert.ok(observed.message.includes('transport-detail'));
    assert.ok(observed.message.includes('cleanup-detail'));
  }
  if (['result-io', 'result-write-io'].includes(scenario)) assert.equal(fallback.length, 1, 'independent private fallback was persisted');
  const text = JSON.stringify(['result-io', 'result-write-io'].includes(scenario) ? fallback : records);
  assert.ok(text.includes('OWNER_NAVIGATION_FAILED'), 'private primary persists');
  assert.ok(text.includes('transport-detail'), 'nested cause persists');
  assert.ok(text.includes('cleanup-detail'), 'aggregate cleanup member persists');
  if (['result-io', 'result-write-io'].includes(scenario)) {
    assert.ok(text.includes(scenario === 'result-io' ? 'fsync' : 'write'), 'failed result logging retains primary I/O cause');
    assert.ok(text.includes('close'), 'failed result logging retains close cause');
  }
}
console.log(JSON.stringify({ scenario, passed: true }));
