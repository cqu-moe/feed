import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from './totp.mjs';

test('TOTP matches the public RFC 6238 SHA-1 vectors', () => {
  const uri = 'otpauth://totp/FEED05?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30';
  assert.equal(totp(uri, 59_000), '94287082');
  assert.equal(totp(uri, 1_111_111_109_000), '07081804');
  assert.equal(totp(uri, 1_234_567_890_000), '89005924');
  assert.equal(totp(uri, 2_000_000_000_000), '69279037');
});
