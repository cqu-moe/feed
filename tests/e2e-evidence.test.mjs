import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublic } from '../e2e/evidence.mjs';

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
