import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { assertSelectedAttemptCleanup, auditNativeAttempts, exportPublic, publishPublicRun } from '../e2e/evidence.mjs';

test('public E2E export preserves raw evidence and resolves artifact IDs after redaction and binary omission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'raw'), destination = join(root, 'public');
  const generated = `reader/${'a'.repeat(43)}`;
  await mkdir(join(source, 'results', generated), { recursive: true });
  const secret = 'Synthetic-only-export-secret';
  const report = { run: { results: [{ attempts: [{
    id: 'attempt-one',
    artifacts: [
      { id: 'log', path: `${generated}/failure.txt`, size: 999, sha256: 'stale', kind: 'log' },
      { id: 'download', path: `${generated}/notification.pdf`, size: 4, sha256: 'stale', kind: 'download' },
    ],
    failure: { screen: 'log' },
    steps: [{ artifacts: ['log', 'download'], message: secret }],
  }] }] } };
  const original = JSON.stringify(report);
  await writeFile(join(source, 'report.json'), original);
  await writeFile(join(source, 'results', generated, 'failure.txt'), `failure ${secret}`);
  await writeFile(join(source, 'results', generated, 'notification.pdf'), '%PDF');
  await exportPublic(source, destination, [secret]);
  assert.equal(await readFile(join(source, 'report.json'), 'utf8'), original);
  const clean = JSON.parse(await readFile(join(destination, 'report.json'), 'utf8'));
  const attempt = clean.run.results[0].attempts[0];
  assert.deepEqual(attempt.steps[0].artifacts, ['log']);
  assert.equal(attempt.steps[0].message, '[redacted]');
  assert.equal(attempt.artifacts.length, 1);
  assert.equal(attempt.artifacts[0].path, 'reader/[redacted]/failure.txt');
  assert.equal(attempt.failure.screen, attempt.artifacts[0].id);
  const bytes = await readFile(join(destination, 'results', attempt.artifacts[0].path));
  assert.equal(bytes.toString(), 'failure [redacted]');
  assert.equal(attempt.artifacts[0].size, bytes.length);
  assert.equal(attempt.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(readFile(join(destination, 'results', 'reader', '[redacted]', 'notification.pdf')), { code: 'ENOENT' });
});

test('public E2E export also redacts startup and supplementary-engine evidence without an e2e report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'raw'), destination = join(root, 'public');
  await mkdir(source);
  await writeFile(join(source, 'playwright-report.json'), JSON.stringify({ error: 'synthetic-password' }));
  await exportPublic(source, destination, ['synthetic-password']);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'playwright-report.json'), 'utf8')), { error: '[redacted]' });
});

test('selected attempt cleanup failures override passing browser aggregates and preserve original details', () => {
  for (const attempt of [
    { cleanup: 'failed', secondaryErrors: [] },
    { cleanup: 'complete', secondaryErrors: [{ phase: 'cleanup', code: 'ENGINE_FAILURE', message: 'private-provider-detail' }] },
  ]) {
    const report = { run: { status: 'passed', exitCode: 0, results: [{ selected: true, attempts: [attempt] }] } };
    const original = structuredClone(report);
    assert.throws(() => assertSelectedAttemptCleanup(report), error => {
      assert.match(error.message, /cleanup failed/);
      assert.ok(!error.message.includes('private-provider-detail'));
      return true;
    });
    assert.deepEqual(report, original);
  }
  assert.doesNotThrow(() => assertSelectedAttemptCleanup({ run: { results: [
    { selected: true, attempts: [{ cleanup: 'complete', secondaryErrors: [] }] },
    { selected: false, attempts: [{ cleanup: 'failed', secondaryErrors: [{ phase: 'cleanup' }] }] },
  ] } }));
});

test('native release admission rejects wrong suite, stale attempt identity, viewport and cleanup despite passed aggregates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-native-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = { suites: [{ specs: [{ id: 'actual-native-id', file: 'ingestion.e2e.ts', title: 'original ingestion journey', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, duration: 1, errors: [] }] }] }] }] };
  const base = { testId: 'actual-native-id', attemptId: 'attempt-one', engine: 'firefox', retry: 0,
    cleanup: 'complete', exited: true, profileRemoved: true, headless: true,
    profiles: [{ path: join(root, '.profiles/removed-attempt'), disconnected: true, removed: true }], errors: [], unexpected: [],
    viewports: [{ testId: 'actual-native-id', attemptId: 'attempt-one', expected: { width: 390, height: 844 }, actual: { width: 390, height: 844 } }] };
  const audit = () => auditNativeAttempts(report, report, report, root, { suite: 'ingestion', browser: 'firefox', variant: 'mobile' });
  const file = join(root, 'browser-cleanup-firefox-actual-native-id.json');
  await writeFile(file, JSON.stringify(base));
  assert.equal((await audit())[0].cleanup, 'complete');
  for (const mutate of [
    receipt => { receipt.testId = 'old-success'; },
    receipt => { receipt.engine = 'webkit'; },
    receipt => { receipt.viewports[0].attemptId = 'old-attempt'; },
    receipt => { receipt.viewports[0].actual.width = 1440; },
    receipt => { receipt.cleanup = 'failed'; },
    receipt => { receipt.retry = 1; },
  ]) {
    const receipt = structuredClone(base); mutate(receipt);
    await writeFile(file, JSON.stringify(receipt));
    await assert.rejects(audit());
  }
  await writeFile(file, JSON.stringify(base));
  await assert.rejects(auditNativeAttempts(report, report, report, root, { suite: 'mail', browser: 'firefox', variant: 'mobile' }), /different original suite/);
  report.suites[0].specs[0].tests[0].results[0].status = 'failed';
  await assert.rejects(audit(), /Actual native attempt failed/);
  report.suites[0].specs[0].tests[0].results[0].status = 'passed';
  await mkdir(base.profiles[0].path, { recursive: true });
  await assert.rejects(audit(), /profile remains/);
  const emptyDirectory = join(root, 'empty-selection');
  await mkdir(emptyDirectory);
  const empty = { suites: [], errors: [] };
  const options = { suite: 'ingestion', browser: 'firefox', variant: 'mobile', allowFailure: true };
  assert.deepEqual(await auditNativeAttempts(empty, report, empty, emptyDirectory, options), []);
  await assert.rejects(auditNativeAttempts({ ...empty, errors: [{ message: 'unrelated collection failure' }] }, report, empty, emptyDirectory, options), /Empty native selection includes framework errors/);

});

test('a rejected sensitive JSON key leaves private originals intact and no public/staging residue', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-private-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'public');
  await mkdir(source);
  for (const secret of ['synthetic-sensitive-key', 'synthetic-escaped-"key']) {
    const original = JSON.stringify({ [secret]: 'private' });
    await writeFile(join(source, 'data.json'), original);
    await assert.rejects(exportPublic(source, destination, [secret]), /Sensitive synthetic value/);
    await assert.rejects(readFile(join(destination, 'data.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(source, 'data.json'), 'utf8'), original);
    assert.deepEqual(await readdir(root), ['source']);
  }
  await mkdir(destination);
  await writeFile(join(destination, 'old-success.json'), 'old owned evidence');
  await assert.rejects(exportPublic(source, destination, []), /must be fresh/);
  assert.equal(await readFile(join(destination, 'old-success.json'), 'utf8'), 'old owned evidence');
});

test('run publication scans metadata before promotion and publishes only a safe summary after rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-run-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = 'synthetic-publication-secret', unknown = 'unknown-raw-stack-must-stay-private';
  for (const corrupt of [false, true]) {
    const directory = join(root, String(corrupt)), source = join(directory, 'private-original');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'data.json'), JSON.stringify({ content: 'safe reading' }));
    const stage = join(directory, '.public-stage');
    await exportPublic(source, join(stage, 'desktop'), [secret]);
    if (corrupt) await writeFile(join(stage, 'unvalidated-metadata.json'), JSON.stringify({ [secret]: 'rejected' }));
    const manifest = { suite: 'reader', browser: 'firefox', errors: [unknown], variants: [{ variant: 'desktop',
      errors: [unknown], observations: [{ value: secret }], cleanup: { status: 'passed', storageRemoved: true, portsClosed: [] } }] };
    const result = await publishPublicRun(directory, manifest, [secret]);
    assert.equal(result.status, corrupt ? 'rejected' : 'published');
    const text = await readFile(join(directory, 'public/run.json'), 'utf8');
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(unknown), false);
    assert((await readFile(join(directory, '.private-run.json'), 'utf8')).includes(unknown));
    assert.equal(await readFile(join(source, 'data.json'), 'utf8'), '{"content":"safe reading"}');
    await assert.rejects(readdir(stage), { code: 'ENOENT' });
    if (corrupt) {
      assert.deepEqual(await readdir(join(directory, 'public')), ['run.json']);
      assert.equal(JSON.parse(text).evidencePublication.reason, 'ARTIFACT_EXPORT_REJECTED');
    } else {
      const runtime = await readFile(join(directory, 'public/desktop/runtime.json'), 'utf8');
      assert(!runtime.includes(secret) && !runtime.includes(unknown));
    }
  }
});


test('untrusted real child stdout and stderr remain private even without a secret inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-private-console-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = ['synthetic-uninventoried-stdout', 'synthetic-uninventoried-stderr'];
  const childCode = `process.stdout.write(${JSON.stringify(secrets[0])}); process.stderr.write(${JSON.stringify(secrets[1])}); process.exitCode=1;`;
  const code = `import {spawn} from 'node:child_process';
    import {recordPrivateChildOutput,exportPublic} from ${JSON.stringify(new URL('../e2e/evidence.mjs', import.meta.url).href)};
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','pipe']});
    let raw='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>raw+=b);
    await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done)});
    await recordPrivateChildOutput(${JSON.stringify(root)},raw,[]);
    await exportPublic(${JSON.stringify(root)},${JSON.stringify(join(root, 'public'))},[]);`;
  const outer = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(outer.stdout, '');
  assert.equal(outer.stderr, '');
  const raw = await readFile(join(root, '.private-child.log'), 'utf8');
  for (const secret of secrets) assert(raw.includes(secret));
  assert.deepEqual(await readdir(join(root, 'public')), []);
});


test('native platform error stacks stay private with their causes and no console replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feed-private-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, '.private-platform.log');
  const code = `import {privatePlatformLog} from ${JSON.stringify(new URL('../e2e/private-log.mjs', import.meta.url).href)};
    const log=privatePlatformLog(${JSON.stringify(file)});
    log.error(new Error('synthetic-platform-secret',{cause:new Error('synthetic-original-cause')}));`;
  const outer = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(outer.stdout, '');
  assert.equal(outer.stderr, '');
  const raw = await readFile(file, 'utf8');
  assert(raw.includes('synthetic-platform-secret'));
  assert(raw.includes('synthetic-original-cause'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await exportPublic(root, join(root, 'public'), []);
  assert.deepEqual(await readdir(join(root, 'public')), []);
});

// These are the runner's real discovery/final-publication callers. --list imports
// a fixture but executes no test/browser; filesystem failures use real paths and
// permissions. Optional exclusive output retains the raw RED/GREEN controls.
async function runnerControlRoot(t, name) {
  if (process.env.FEED_E2E_UNIT_EVIDENCE) {
    const root = resolve(process.env.FEED_E2E_UNIT_EVIDENCE, name);
    await mkdir(root, { mode: 0o700 });
    return root;
  }
  const root = await mkdtemp(join(tmpdir(), `feed-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function controlChild(root, code) {
  let result;
  try { result = { ...await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]), code: 0 }; }
  catch (error) { result = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  for (const stream of ['stdout', 'stderr']) await writeFile(join(root, `.private-outer-${stream}.log`), result[stream], { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'control-exit.json'), JSON.stringify({ code: result.code }), { flag: 'wx' });
  return result;
}

test('actual native --list stderr is private on both successful discovery and collection failure', async t => {
  const root = await runnerControlRoot(t, 'discovery');
  const marker = 'synthetic-list-import-stderr-secret';
  for (const fail of [false, true]) await t.test(String(fail), async () => {
    const directory = join(root, String(fail)); await mkdir(directory);
    const config = join(directory, 'probe.config.mjs');
    await writeFile(config, `export default { testDir: ${JSON.stringify(directory)}, testMatch: 'probe.spec.mjs', outputDir: ${JSON.stringify(join(directory, 'results'))} };`);
    await writeFile(join(directory, 'probe.spec.mjs'), `import {test} from ${JSON.stringify(new URL('../node_modules/@playwright/test/index.mjs', import.meta.url).href)};
      process.stderr.write(${JSON.stringify(marker)}); ${fail ? "throw new Error('synthetic-list-collection-cause');" : ''}
      test('list only; must never execute', () => { throw new Error('UNEXPECTED_EXECUTION'); });`);
    const code = `import {discoverNativeTests} from ${JSON.stringify(new URL('../e2e/evidence.mjs', import.meta.url).href)};
      try { await discoverNativeTests(${JSON.stringify(directory)}, ['--config', ${JSON.stringify(config)}], {PATH:process.env.PATH,HOME:${JSON.stringify(directory)}}, 'native-discovery.json'); }
      catch { process.exitCode=1; }`;
    const result = await controlChild(directory, code);
    assert.equal(result.code, fail ? 1 : 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '', 'discovery must not replay child stderr to the outer console');
    assert.equal(await readFile(join(directory, '.private-native-discovery.json.stderr.log'), 'utf8'), marker);
    const raw = await readFile(join(directory, '.private-native-discovery.json.stdout.log'), 'utf8');
    assert.equal(raw, await readFile(join(directory, 'native-discovery.json'), 'utf8'));
    const report = JSON.parse(raw);
    if (fail) assert(report.errors.some(error => error.message.includes('synthetic-list-collection-cause')));
    else assert.deepEqual(report.errors, []);
    for (const stream of ['stdout', 'stderr']) assert.equal((await stat(join(directory, `.private-native-discovery.json.${stream}.log`))).mode & 0o777, 0o600);
  });
});

test('final publication preserves scan, real filesystem cleanup and journal fallback errors privately', async t => {
  const root = await runnerControlRoot(t, 'publication');
  for (const fault of ['journal', 'cleanup', 'fallback']) await t.test(fault, async () => {
    const directory = join(root, fault), stage = join(directory, '.public-stage');
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const secret = 'synthetic-publication-key-secret';
    await writeFile(join(stage, 'rejected.json'), JSON.stringify({ [secret]: 'private original' }));
    if (fault !== 'cleanup') await mkdir(join(directory, '.private-publication-error.json'));
    if (fault === 'fallback') await mkdir(join(directory, '.private-publication-failure.json'));
    if (fault === 'cleanup') {
      // Metadata can overwrite this existing file, but cleanup cannot unlink it.
      await writeFile(join(stage, 'run.json'), '{}');
      await chmod(stage, 0o500);
    }
    const code = `import {publishRunEvidence} from ${JSON.stringify(new URL('../e2e/evidence.mjs', import.meta.url).href)};
      await publishRunEvidence(${JSON.stringify(directory)}, {suite:'reader',browser:'firefox',errors:[],variants:[]}, [${JSON.stringify(secret)}]);`;
    let result;
    try { result = await controlChild(directory, code); }
    finally { if (fault === 'cleanup') await chmod(stage, 0o700); }
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert(!result.stderr.includes(secret));
    assert(!result.stderr.includes('EISDIR') && !result.stderr.includes('EACCES'), 'raw filesystem exceptions must not escape the final caller');
    const names = (await readdir(directory)).filter(name => name.startsWith('.private-publication-') && name.endsWith('.json'));
    const journals = [];
    for (const name of names) if ((await stat(join(directory, name))).isFile()) {
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
      journals.push(JSON.parse(await readFile(join(directory, name), 'utf8')));
    }
    const errors = value => [value, ...(value.errors ?? []).flatMap(errors), ...(value.cause ? errors(value.cause) : [])];
    const retained = journals.flatMap(errors);
    assert(retained.some(error => error.message === 'Sensitive synthetic value in public evidence' && error.stack), 'primary scanner rejection and stack must survive final serialization');
    assert(retained.some(error => error.code === (fault === 'cleanup' ? 'EACCES' : 'EISDIR') && error.syscall && error.stack), 'actual secondary filesystem cause must survive');
    if (fault === 'fallback') for (const name of ['.private-publication-error.json', '.private-publication-failure.json']) {
      assert(retained.some(error => error.code === 'EISDIR' && error.path === join(directory, name)), 'both original and fallback journal failures must survive');
    }
    assert(journals.some(error => error.name === 'AggregateError' && error.cause && error.errors.length >= 2), 'aggregate structure must survive');
    await assert.rejects(readdir(join(directory, 'public')), { code: 'ENOENT' });
    if (fault !== 'cleanup') await assert.rejects(readdir(stage), { code: 'ENOENT' });
    else assert((await readFile(join(stage, 'rejected.json'), 'utf8')).includes(secret));
  });
});
