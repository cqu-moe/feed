import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRequestAllowed, createAdmin, restorePlan, withRevokedAccess } from './admin.mjs';
const owner = 'synthetic_owner_0001';
const access = { userId: owner, subsystem: 'feed', capability: 'access', value: '1', updatedAt: 'fixture-before' };
const quota = { userId: owner, subsystem: 'feed', capability: 'sub_limit', value: '3', updatedAt: 'fixture-before' };
const baseline = [access, quota];
const endpoint = `/admin/users/${owner}/entitlements`;
const forbidden = async () => { throw new Error('Unexpected verification'); };

test('only the exact existing two-row owner baseline is admitted, with full raw snapshot before any write', async () => {
  assert.deepEqual(restorePlan(baseline, owner), { items: [
    { subsystem: 'feed', capability: 'access', value: '1' },
    { subsystem: 'feed', capability: 'sub_limit', value: '3' },
  ] });
  for (const rows of [[access], [quota], [access, { ...quota, value: '4' }],
    [...baseline, { ...quota, capability: 'unrelated' }], [access, { ...quota, userId: 'other' }]]) {
    const records = []; let writes = 0;
    await assert.rejects(withRevokedAccess({ owner, record: async r => records.push(r), verify: forbidden,
      admin: { rows: async () => rows, write: async () => { writes++; } } }), /EXACT_TWO_ROW_BASELINE_REQUIRED|ENTITLEMENT_SCHEMA/);
    assert.equal(writes, 0); assert.deepEqual(records[0].before, rows);
  }
});

test('an unknown DELETE result restores exact before items and preserves the original error', async () => {
  let rows = baseline; const writes = [], records = [];
  const admin = { rows: async () => rows, write: async (step, before, method, body) => {
    writes.push(method);
    if (method === 'DELETE') { rows = [quota]; throw new Error('delete-ack-lost'); }
    assert.deepEqual(before, [quota]); assert.deepEqual(body, restorePlan(baseline, owner));
    rows = baseline.map(row => ({ ...row, updatedAt: 'fixture-restored' }));
  } };
  await assert.rejects(withRevokedAccess({ admin, owner, verify: forbidden, record: async r => records.push(r) }), error => {
    assert.equal(error.errors[0].message, 'delete-ack-lost'); assert.equal(error.errors.length, 1); return true;
  });
  assert.deepEqual(writes, ['DELETE', 'PUT']); assert.equal(rows[1].value, '3');
  assert.deepEqual(records.at(-1).before, baseline); assert.equal(records.at(-1).updatedAtMayBeRebuilt, true);
});

test('primary denial failure and restore failure both survive', async () => {
  let rows = baseline;
  const admin = { rows: async () => rows, write: async (step, before, method) => {
    if (method === 'DELETE') rows = [quota]; else throw new Error('restore-unreachable');
  } };
  await assert.rejects(withRevokedAccess({ admin, owner, record: async () => {}, verify: async () => { throw new Error('wrong-403-reason'); } }), error => {
    assert.deepEqual(error.errors.map(x => x.message), ['wrong-403-reason', 'restore-unreachable']); return true;
  });
});

test('unknown or concurrently changed remaining grants prevent restore PUT and preserve both causes', async () => {
  for (const changed of [[{ ...quota, value: '4' }], [quota, { ...quota, capability: 'unrelated' }], []]) {
    let rows = baseline; const writes = [];
    const admin = { rows: async () => rows, write: async (step, before, method) => { writes.push(method); rows = [quota]; } };
    await assert.rejects(withRevokedAccess({ admin, owner, record: async () => {}, verify: async () => {
      rows = changed; throw new Error('primary-proof-failed');
    } }), error => {
      assert.deepEqual(error.errors.map(x => x.message), ['primary-proof-failed', 'RESTORE_CONCURRENT_CHANGE']); return true;
    });
    assert.deepEqual(writes, ['DELETE']); assert.deepEqual(rows, changed);
  }
});

test('success preserves quota semantics, reconciles complete readback, and admits rebuilt timestamps', async () => {
  let rows = baseline; const writes = []; let observed = false;
  const admin = { rows: async () => rows, write: async (step, before, method, body) => {
    writes.push(method);
    if (method === 'DELETE') rows = [quota];
    else { assert.deepEqual(before, [quota]); assert.deepEqual(body, restorePlan(baseline, owner)); rows = baseline.map(row => ({ ...row, updatedAt: 'later' })); }
  } };
  await withRevokedAccess({ admin, owner, record: async () => {}, verify: async () => { assert.deepEqual(rows, [quota]); observed = true; } });
  assert.ok(observed); assert.deepEqual(writes, ['DELETE', 'PUT']);
  assert.deepEqual(restorePlan(rows, owner), restorePlan(baseline, owner));
});

test('admin boundary admits only the exact owner DELETE and exact before-set PUT, not changed grants/factors/roles/clients', () => {
  assert.ok(adminRequestAllowed(owner, `${endpoint}/feed/access`, 'DELETE'));
  assert.ok(adminRequestAllowed(owner, endpoint, 'PUT', restorePlan(baseline, owner)));
  for (const [path, method, body] of [
    [endpoint, 'PUT', { items: [{ subsystem: 'feed', capability: 'access', value: '1' }] }],
    [endpoint, 'PUT', { items: [{ subsystem: 'feed', capability: 'access', value: '1' }, { subsystem: 'feed', capability: 'sub_limit', value: '4' }] }],
    [`${endpoint}/feed/sub_limit`, 'DELETE'], ['/admin/users/another/entitlements/feed/access', 'DELETE'],
    ['/auth/two-factor/enable', 'POST', {}], ['/admin/set-role', 'POST', {}], ['/admin/oauth-clients', 'POST', {}],
    ['/auth/security/challenge', 'POST', { password: 'fixture', purpose: 'mfa' }],
  ]) assert.equal(adminRequestAllowed(owner, path, method, body), false);
});

test('offline admin refuses before opening private credentials or starting a session', async () => {
  assert.notEqual(process.env.FEED05_MODE, 'execute');
  await assert.rejects(createAdmin(owner), /OFFLINE_ADMIN_FORBIDDEN/);
});
