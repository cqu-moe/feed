import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('release check distinguishes a recovered source from a future plan and incomplete evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'feed-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sources.json');
  const at = '2026-11-03T19:33:00+08:00';
  const snapshot = { id: 'notices', siteId: 'school', name: '通知', url: 'https://example.test/',
    enabled: true, siteEnabled: true, validationState: 'verified', refreshIntervalSec: 86400,
    nextDiscoveryAt: Date.parse('2026-11-04T18:00:00+08:00'), articleCount: 0, error: null };
  const script = fileURLToPath(new URL('../scripts/check-release-sources.mjs', import.meta.url));
  for (const [overrides, expected, code, evidence] of [
    [{ lastRunAt: '2026-11-02T02:00:00Z' }, 1, 1, /notices.*检查已超期/],
    [{ lastRunAt: at }, 1, 0, /1\/1/],
    [{ lastRunAt: at }, 2, 2, /无法验收/],
    [{ lastRunAt: at, error: undefined }, 1, 2, /错误状态/],
  ]) {
    await writeFile(file, JSON.stringify({ sources: [{ ...snapshot, ...overrides }] }));
    const run = spawnSync(process.execPath, [script, file, at, String(expected)], { encoding: 'utf8' });
    assert.equal(run.status, code, run.stderr);
    assert.match(run.stdout + run.stderr, evidence);
  }
});
