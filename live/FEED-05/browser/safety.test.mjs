import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  account, admissibleBaseline, baselineOnly, baselineUnchanged, cleanupCandidates,
  finalCleanupReadback, mode, ownedRows, rssAddress, selectAccounts, FEED,
} from './state.mjs';

test('account roles use the declared owner/other schema and ignore admin authority', () => {
  const values = { accounts: [
    { intendedRole: 'admin', email: 'admin@example.test', password: 'fixture-admin' },
    { intendedRole: 'owner', email: 'owner@example.test', password: 'fixture-owner' },
    { intendedRole: 'other', email: 'other@example.test', password: 'fixture-other' },
  ] };
  const selected = selectAccounts(values);
  assert.deepEqual(Object.keys(selected).sort(), ['other', 'owner']);
  assert.throws(() => selectAccounts({ accounts: [values.accounts[1], values.accounts[1], values.accounts[2]] }), /ACCOUNT_SCHEMA/);
  assert.throws(() => selectAccounts({ accounts: [values.accounts[1], { ...values.accounts[2], email: values.accounts[1].email }] }), /DISTINCT_ACCOUNTS_REQUIRED/);
});
test('offline secret provider refuses before accessing the real account file', async () => {
  delete process.env.FEED05_MODE;
  await assert.rejects(account('owner'), /EXECUTION_REQUIRED_FOR_SECRETS/);
});
test('cleanup reconciliation excludes baseline, unrelated names and mail-enabled rows', () => {
  const row = { id: 'a'.repeat(24), name: 'FEED05-run', emailMode: 'off' };
  assert.deepEqual(ownedRows([row, { ...row, id: 'b'.repeat(24), name: 'older' },
    { ...row, id: 'c'.repeat(24), emailMode: 'daily_digest' }], [], ['FEED05-run']), [row]);
  assert.deepEqual(ownedRows([row], [row.id], ['FEED05-run']), []);
});
test('baseline admits only zero-usage soft-deleted email-off revoked-RSS tombstones', () => {
  const tombstone = {
    id: 'a'.repeat(24), name: 'prior-round', emailMode: 'off', deletedAt: '2026-10-15T00:00:00.000Z',
    rssStatus: 'rss_revoked', rssUrl: null,
  };
  const baseline = admissibleBaseline({ usage: 0, subscriptions: [tombstone] });
  assert.deepEqual([...baseline.ids], [tombstone.id]);
  assert.equal(admissibleBaseline({ usage: 0, subscriptions: [] }).rows.length, 0);
  for (const changed of [
    { usage: 1, subscriptions: [tombstone] },
    { usage: 0, subscriptions: [{ ...tombstone, deletedAt: null }] },
    { usage: 0, subscriptions: [{ ...tombstone, emailMode: 'daily_digest' }] },
    { usage: 0, subscriptions: [{ ...tombstone, rssStatus: 'active' }] },
    { usage: 0, subscriptions: [{ ...tombstone, rssUrl: `${FEED}/rss?token=${'x'.repeat(43)}` }] },
    { usage: 0, subscriptions: [{ ...tombstone, id: 'short' }] },
  ]) assert.throws(() => admissibleBaseline(changed), /BASELINE_/);
});
test('baseline preservation compares exact row fingerprints while allowing ordered new rows', () => {
  const tombstone = {
    id: 'a'.repeat(24), name: 'prior-round', version: 4, emailMode: 'off', deletedAt: 'fixture',
    rssStatus: 'rss_revoked', rssUrl: null,
  };
  const baseline = admissibleBaseline({ usage: 0, subscriptions: [tombstone] });
  const created = { id: 'b'.repeat(24), name: 'FEED05-run', version: 1, deletedAt: null };
  assert.equal(baselineUnchanged({ usage: 1, subscriptions: [created, tombstone] }, baseline), true);
  assert.equal(baselineOnly({ usage: 0, subscriptions: [tombstone] }, baseline), true);
  assert.throws(() => baselineOnly({ usage: 1, subscriptions: [tombstone] }, baseline), /BASELINE_USAGE_CHANGED/);
  for (const changed of [
    { usage: 0, subscriptions: [] },
    { usage: 0, subscriptions: [{ ...tombstone, version: 5 }] },
    { usage: 0, subscriptions: [{ ...tombstone, name: 'changed' }] },
  ]) {
    assert.throws(() => baselineUnchanged(changed, baseline), /BASELINE_ROW_CHANGED|BASELINE_ROW_MISSING/);
    assert.throws(() => baselineOnly(changed, baseline), /BASELINE_ROW_CHANGED|BASELINE_ROW_MISSING|BASELINE_UNKNOWN_ROW/);
  }
});
test('cleanup admission refuses unknown concurrent rows, changed baseline, and owned ambiguity', () => {
  const tombstone = {
    id: 'a'.repeat(24), name: 'prior-round', emailMode: 'off', deletedAt: 'fixture',
    rssStatus: 'rss_revoked', rssUrl: null,
  };
  const baseline = admissibleBaseline({ usage: 0, subscriptions: [tombstone] });
  const owned = { ...tombstone, id: 'b'.repeat(24), name: 'FEED05-run', deletedAt: null, rssStatus: 'active' };
  assert.deepEqual(cleanupCandidates({ usage: 1, subscriptions: [tombstone, owned] }, baseline, ['FEED05-run']), [owned]);
  const unknown = { ...owned, id: 'c'.repeat(24), name: 'concurrent' };
  for (const rows of [
    [tombstone, unknown],
    [tombstone, owned, { ...owned, id: 'd'.repeat(24) }],
    [{ ...tombstone, version: 5 }, owned],
  ]) assert.throws(() => cleanupCandidates({ usage: 1, subscriptions: rows }, baseline, ['FEED05-run']),
    /BASELINE_ROW_CHANGED|BASELINE_ROW_MISSING|CLEANUP_UNKNOWN_ROW|CLEANUP_OWNED_AMBIGUITY/);
});
test('final cleanup requires every existing row unchanged and each new row an explicit revoked tombstone', () => {
  const prior = {
    id: 'a'.repeat(24), name: 'prior-round', emailMode: 'off', deletedAt: 'fixture',
    rssStatus: 'rss_revoked', rssUrl: null, version: 4,
  };
  const baseline = admissibleBaseline({ usage: 0, subscriptions: [prior] });
  const owned = { ...prior, id: 'b'.repeat(24), name: 'FEED05-run', version: 2 };
  assert.equal(finalCleanupReadback({ usage: 0, subscriptions: [prior, owned] }, baseline, [owned.id]), true);
  for (const rows of [
    [prior, { ...owned, deletedAt: null, rssStatus: 'active' }],
    [prior, { ...owned, rssUrl: `${FEED}/rss?token=${'x'.repeat(43)}` }],
    [prior, { ...owned, emailMode: 'daily_digest' }],
    [{ ...prior, version: 5 }, owned],
    [prior, owned, { ...owned, id: 'c'.repeat(24), name: 'concurrent' }],
  ]) assert.throws(() => finalCleanupReadback({ usage: rows.some(row => row.deletedAt === null) ? 1 : 0, subscriptions: rows },
    baseline, [owned.id]), /BASELINE_ROW_CHANGED|CLEANUP_ACTIVE_USAGE|CLEANUP_UNKNOWN_ROW|FINAL_TOMBSTONE_REQUIRED/);
});
test('RSS origin, credentials and duplicate token selectors fail closed without revealing input', () => {
  const token = 'x'.repeat(43);
  assert.equal(rssAddress(`/rss?token=${token}`), `${FEED}/rss?token=${token}`);
  for (const input of [`https://feed.cqu.moe/rss?token=${token}`, `/rss?token=${token}&token=${token}`, '/rss?token=short',
    'https://[malformed-fixture',
    `${FEED.replace('https://', 'https://user:fixture@')}/rss?token=${token}`, `/rss?token=${token}#fragment`]) {
    assert.throws(() => rssAddress(input), /RSS_ORIGIN/);
  }
});
test('launcher rejects arbitrary flags, alternate origins and accidental execution', () => {
  assert.equal(mode(['--check']), '--check');
  assert.equal(mode(['--run']), '--run');
  for (const args of [[], ['--run', '--feed', 'https://feed.cqu.moe'], ['--grep', 'anything']]) {
    assert.throws(() => mode(args), /USE_CHECK_OR_RUN_ONLY/);
  }
});
