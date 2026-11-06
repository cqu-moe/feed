import test from 'node:test';
import assert from 'node:assert/strict';
import { selectShard } from '../e2e/shard.mjs';

const definitions = Array.from({ length: 8 }, (_, index) => index);

test('control shards preserve every definition exactly once across every valid split', () => {
  assert.deepEqual(selectShard(definitions), definitions);
  for (let total = 1; total <= definitions.length; total += 1) {
    const shards = Array.from({ length: total }, (_, current) => selectShard(definitions, `${current + 1}/${total}`));
    const selected = shards.flat().sort();
    assert.deepEqual(selected, [...definitions].sort());
    assert.equal(new Set(selected).size, definitions.length);
    assert.ok(Math.max(...shards.map(shard => shard.length)) - Math.min(...shards.map(shard => shard.length)) <= 1);
  }
});

test('invalid control shard specifications fail instead of selecting no tests', () => {
  for (const specification of ['', '1', '1/0', '0/3', '4/3', '9/9', '1/9007199254740992', '/3', '3/', 'one/three', '1//3', ' 1/3']) {
    assert.throws(() => selectShard(definitions, specification), /^Error: (Invalid shard|Shard .* out of range)/);
  }
});
