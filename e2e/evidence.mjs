import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertSelectedAttemptCleanup(report) {
  if (report.run.results.some(result => result.selected && result.attempts.some(attempt =>
    attempt.cleanup === 'failed' || attempt.secondaryErrors?.some(error => error.phase === 'cleanup')))) {
    throw new Error('Selected browser attempt cleanup failed; original details remain in report.json');
  }
}

export function nativeCases(report) {
  const visit = suites => suites.flatMap(suite => [
    ...(suite.specs ?? []).flatMap(spec => spec.tests.map(test => ({ id: spec.id, file: suite.file ?? spec.file,
      declaration: { file: spec.file, line: spec.line, column: spec.column }, title: spec.title, test }))),
    ...visit(suite.suites ?? []),
  ]);
  return visit(report.suites);
}

export async function auditNativeAttempts(report, discovery, selected, directory, { suite, browser, variant, allowFailure = false }) {
  const full = nativeCases(discovery), expected = nativeCases(selected), actual = nativeCases(report);
  if (!expected.length) assert.deepEqual(report.errors, [], 'Empty native selection includes framework errors');
  const files = suite === 'reader' ? ['journey.e2e.ts', 'reading.e2e.ts'] : [`${suite}.e2e.ts`];
  assert.deepEqual([...new Set(full.map(test => test.file))].sort(), files.sort(), 'Native discovery selected a different original suite');
  assert.equal(full.length, suite === 'reader' ? 4 : 1, 'Native discovery omitted original journeys');
  assert.deepEqual(actual.map(test => test.id).sort(), expected.map(test => test.id).sort(), 'Actual native test IDs differ from selected discovery');
  assert.ok(expected.every(test => full.some(original => original.id === test.id)), 'Selected native test is not in the original suite');
  const receiptFiles = (await readdir(directory)).filter(name => name.startsWith('browser-cleanup-'));
  const receipts = await Promise.all(receiptFiles.map(async name => ({ ...JSON.parse(await readFile(join(directory, name), 'utf8')), file: name })));
  assert.equal(receipts.length, actual.length, 'Missing or extra native attempt cleanup receipt');
  assert.equal(new Set(receipts.map(receipt => receipt.attemptId)).size, receipts.length, 'Native attempt identity was reused');
  const viewport = variant === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const attempts = [];
  for (const test of actual) {
    assert.equal(test.test.results.length, 1, 'Native journey must have exactly one attempt');
    const result = test.test.results[0];
    assert.equal(result.retry, 0, 'Native journey used a retry');
    if (!allowFailure) {
      assert.equal(test.test.expectedStatus, 'passed');
      assert.equal(test.test.status, 'expected');
      assert.equal(result.status, 'passed', 'Actual native attempt failed despite passed aggregate');
      assert.deepEqual(result.errors, []);
    }
    const matches = receipts.filter(receipt => receipt.testId === test.id);
    assert.equal(matches.length, 1, 'Native receipt test ID mismatch');
    const receipt = matches[0];
    assert.equal(receipt.engine, browser);
    assert.equal(receipt.retry, 0);
    assert.equal(receipt.cleanup, 'complete', 'Native attempt cleanup failed');
    assert.equal(receipt.exited, true);
    assert.equal(receipt.profileRemoved, true);
    assert.equal(receipt.headless, true);
    assert.ok(receipt.profiles.length, 'Native attempt did not own a profile');
    for (const profile of receipt.profiles) {
      assert.ok(resolve(profile.path).startsWith(resolve(directory, '.profiles') + '/'), 'Profile is outside the attempt runtime');
      assert.equal(profile.removed, true);
      assert.equal(profile.disconnected, true);
      await stat(profile.path).then(() => { throw new Error('Native profile remains after cleanup'); }, error => { if (error.code !== 'ENOENT') throw error; });
    }
    assert.deepEqual(receipt.errors, []);
    assert.deepEqual(receipt.unexpected, []);
    assert.ok(receipt.viewports.length, 'Native attempt has no actual viewport readback');
    for (const observed of receipt.viewports) {
      assert.equal(observed.attemptId, receipt.attemptId);
      assert.equal(observed.testId, test.id);
      assert.deepEqual(observed.expected, viewport);
      assert.deepEqual(observed.actual, viewport);
    }
    attempts.push({ id: test.id, file: test.file, declaration: test.declaration, title: test.title, attemptId: receipt.attemptId,
      status: result.status, retry: result.retry, durationMs: result.duration, cleanup: receipt.cleanup, receipt: receipt.file });
  }
  return attempts;
}

export function redact(input, values) {
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
// Child console is untrusted even when runtime secret inventory is unavailable.
// Keep the original bytes private; publish only separately scanned reports.
export async function recordPrivateChildOutput(directory, rawLog) {
  await writeFile(join(directory, '.private-child.log'), rawLog, { flag: 'wx', mode: 0o600 });
}

export async function discoverNativeTests(variantDir, args, childEnv, name) {
  const child = spawnSync(process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/cross-browser.config.ts', '--list', '--reporter=json', ...args],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of ['stdout', 'stderr']) await writeFile(join(variantDir, `.private-${name}.${stream}.log`), child[stream] ?? '', { flag: 'wx', mode: 0o600 });
  const text = String(child.stdout ?? '');
  await writeFile(join(variantDir, name), text, { flag: 'wx', mode: 0o600 });
  if (child.error || child.status !== 0) throw new Error('Native discovery failed; original output retained privately', {
    cause: child.error ?? new Error(`Native discovery exit ${child.status}, signal ${child.signal}`),
  });
  return JSON.parse(text);
}

export async function publishRunEvidence(output, manifest, values, options) {
  let published = false;
  // Reserve private custody before publication. A later journal path/cleanup
  // failure must not replace the primary error or escape through Node stderr.
  let reserve;
  try { reserve = await open(join(output, `.private-publication-reserve-${randomUUID()}.json`), 'wx', 0o600); }
  catch {
    process.exitCode = 1;
    console.error('Private publication journal unavailable; publication not attempted');
    return false;
  }
  let failure;
  try {
    const publication = await publishPublicRun(output, manifest, values, options);
    await writeFile(join(output, '.publication.json'), JSON.stringify(publication, null, 2) + '\n');
    published = true;
    if (publication.status === 'rejected') { process.exitCode = 1; console.error('Public evidence rejected; private originals retained'); }
  } catch (error) {
    process.exitCode = 1;
    try { await writeFile(join(output, '.private-publication-failure.json'), JSON.stringify(privateError(error), null, 2), { mode: 0o600 }); }
    catch (journalError) {
      error = new AggregateError([error, journalError], 'Publication failure journal also failed', { cause: error });
    }
    failure = error;
    console.error('Public evidence publication failed; original details retained privately');
  } finally {
    try {
      await reserve.writeFile(JSON.stringify(failure ? privateError(failure) : { status: 'not-needed' }, null, 2));
    } catch {
      // A storage write failure can make private retention impossible. Remain
      // nonzero and explicit; never let the raw exception reach the console.
      process.exitCode = 1;
      console.error('Reserved private journal write failed; failure evidence may be incomplete');
    } finally {
      try { await reserve.close(); }
      catch {
        process.exitCode = 1;
        console.error('Reserved private journal close failed');
      }
    }
  }
  return published;
}

function privateError(value, ancestors = new Set()) {
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (ancestors.has(value)) return '[Circular error reference]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(child => privateError(child, ancestors));
    return Object.fromEntries([
      ...(value instanceof Error ? [['name', value.name]] : []),
      ...Object.getOwnPropertyNames(value).map(key => [key, privateError(value[key], ancestors)]),
    ]);
  } finally { ancestors.delete(value); }
}

export async function exportPublic(source, destination, values) {
  await mkdir(dirname(destination), { recursive: true });
  await requireFresh(destination);
  const stage = await mkdtemp(join(dirname(destination), '.private-export-'));
  try {
    const checked = await exportPrivate(source, stage, values);
    await rename(stage, destination);
    return checked;
  } catch (error) {
    try { await rm(stage, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Export rejection and private staging cleanup both failed', { cause: error }); }
    throw error;
  }
}

async function requireFresh(destination) {
  await lstat(destination).then(() => { throw new Error('Public evidence destination must be fresh'); }, error => { if (error.code !== 'ENOENT') throw error; });
}

async function inspectPublic(directory, values) {
  let textFilesScanned = 0;
  const sensitive = text => values.some(value => value && (text.includes(value) || text.includes(encodeURIComponent(value))));
  const inspectJson = value => {
    if (typeof value === 'string') return sensitive(value);
    if (Array.isArray(value)) return value.some(inspectJson);
    return value && typeof value === 'object' && Object.entries(value).some(([key, child]) => sensitive(key) || inspectJson(child));
  };
  async function inspect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(json|txt|md|log)$/.test(entry.name)) {
        textFilesScanned++;
        const text = await readFile(path, 'utf8');
        if (sensitive(text) || (entry.name.endsWith('.json') && inspectJson(JSON.parse(text)))) throw new Error('Sensitive synthetic value in public evidence');
      }
    }
  }
  await inspect(directory);
  return { status: 'passed', knownSyntheticValues: values.length, textFilesScanned };
}

// Keep arbitrary failure payloads in private evidence. Only fixed control
// reasons are meaningful in public metadata; all other messages are opaque.
function publicErrors(errors = []) {
  const fixed = /^(Injected startup failure after real Worker initialization|Injected cleanup failure after successful physical cleanup|Required suite was empty, skipped, interrupted or flaky|Browser suite failed \(exit -?\d+\))$/;
  return errors.map(error => fixed.test(error) ? error : 'Execution failed; original details retained privately');
}

export async function publishPublicRun(directory, manifest, values, { rejected = false } = {}) {
  const stage = join(directory, '.public-stage'), destination = join(directory, 'public');
  await requireFresh(destination);
  await writeFile(join(directory, '.private-run.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const metadata = { ...manifest, errors: publicErrors(manifest.errors),
    variants: manifest.variants.map(variant => ({ ...variant, errors: publicErrors(variant.errors) })) };
  const failure = () => ({ suite: manifest.suite, browser: manifest.browser, feedCommit: manifest.feedCommit,
    authCommit: manifest.authCommit, sourceDigest: manifest.sourceDigest,
    evidencePublication: { status: 'rejected', reason: 'ARTIFACT_EXPORT_REJECTED' },
    errors: ['Public evidence rejected; private originals retained'],
    variants: manifest.variants.map(variant => ({ variant: variant.variant, runnerExit: variant.runnerExit,
      summary: variant.summary, cleanup: { status: variant.cleanup.status,
        storageRemoved: variant.cleanup.storageRemoved, portsClosed: variant.cleanup.portsClosed } })) });
  async function prepare(value) {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    if (!rejected) for (const variant of value.variants) {
      await writeFile(join(stage, variant.variant, 'runtime.json'), redact(JSON.stringify(variant, null, 2) + '\n', values));
    }
    await writeFile(join(stage, 'run.json'), redact(JSON.stringify(value, null, 2) + '\n', values));
    return inspectPublic(stage, values);
  }
  let checked;
  try {
    if (rejected) await rm(stage, { recursive: true, force: true });
    checked = await prepare(rejected ? failure() : metadata);
  } catch (error) {
    rejected = true;
    const secondary = [];
    try { await writeFile(join(directory, '.private-publication-error.json'), JSON.stringify(privateError(error), null, 2), { mode: 0o600 }); }
    catch (journalError) { secondary.push(journalError); }
    try { await rm(stage, { recursive: true, force: true }); }
    catch (cleanupError) { secondary.push(cleanupError); }
    if (secondary.length) throw new AggregateError([error, ...secondary], 'Publication rejection and private cleanup failed', { cause: error });
    try { checked = await prepare(failure()); }
    catch (summaryError) { throw new AggregateError([error, summaryError], 'Publication rejection and safe-summary preparation failed', { cause: error }); }
  }
  await rename(stage, destination);
  return { ...checked, status: rejected ? 'rejected' : 'published' };
}

async function exportPrivate(source, destination, values) {
  await mkdir(destination, { recursive: true });
  async function copy(from, to) {
    await mkdir(to, { recursive: true });
    const names = new Set();
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'public') continue;
      const name = redact(entry.name, values);
      if (names.has(name)) throw new Error('Redacted artifact filenames collide');
      names.add(name);
      const src = join(from, entry.name), dst = join(to, name);
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
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function update(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.artifacts)) {
      const artifacts = [];
      for (const artifact of value.artifacts) {
        // Step artifacts are IDs; only attempt artifacts describe files.
        if (typeof artifact === 'string') { artifacts.push(artifact); continue; }
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
  if (report) {
    await update(report);
    const exportedIds = new Set(report.run.results.flatMap(result => result.attempts ?? []).flatMap(attempt => attempt.artifacts.map(artifact => artifact.id)));
    for (const result of report.run.results) for (const attempt of result.attempts ?? []) {
      for (const step of attempt.steps) {
        step.artifacts = step.artifacts.filter(id => exportedIds.has(id));
      }
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return inspectPublic(destination, values);
}
