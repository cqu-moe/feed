import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('CI path routing skips only documentation changes and fails closed on an empty diff', () => {
  for (const [paths, expected] of [
    [['README.md', 'docs/guide.md', 'docs/images/example.png'], false],
    [['README.md', 'worker/index.mjs'], true],
    [['app.mjs', 'docs/app.mjs'], true],
    [['.github/workflows/ci.yml'], true],
    [['tests/fixtures/notice.md'], true],
    [['src/a\nb.ts'], true],
    [[], true],
  ]) {
    const output = execFileSync(process.execPath, ['scripts/ci-changes.mjs'], {
      input: paths.join('\0') + '\0', encoding: 'utf8',
    });
    assert.equal(output.trim(), `code=${expected}`, JSON.stringify(paths));
  }
});
