import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: ['src/telemetry.ts'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['posthog-js'], define: { 'import.meta.env': JSON.stringify({ PROD: false, MODE: 'test' }) } });
const telemetry = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('browser events preserve SDK transport fields but drop person metadata and search text', () => {
  const source = { event: 'feed_search_completed', uuid: 'fixture', timestamp: '2026-10-14T00:00:00Z',
    $set: { email: 'private@example.test' }, $set_once: { $initial_current_url: 'https://feed.cqu.moe/?q=private' },
    properties: { token: 'public-key', distinct_id: 'central-user', $session_id: 'session', result_count: 0, zero_results: true, operation: 'search_filter', outcome: 'success', query: 'private query', $current_url: 'https://feed.cqu.moe/?q=private' } };
  const clean = telemetry.sanitizeFeedEvent(source);
  assert.equal(clean.properties.token, 'public-key');
  assert.equal(clean.properties.distinct_id, 'central-user');
  assert.equal(clean.properties.result_count, 0);
  assert.deepEqual(Object.keys(clean).sort(), ['event','properties','timestamp','uuid']);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.equal(telemetry.sanitizeFeedEvent({ event: '$autocapture', properties: {} }), null);
});
test('snapshot payloads require an approved route and retain the already-masked recorder payload', () => {
  const snapshot = { event: '$snapshot', $set: { email: 'private' }, properties: { token: 'public-key', distinct_id: 'central-user', $snapshot_data: [{ type: 2, data: 'opaque recorder payload' }], $snapshot_bytes: 24, $session_id: 'session', $window_id: 'window', email: 'private' } };
  assert.equal(telemetry.sanitizeFeedEvent(snapshot), null);
  telemetry.syncFeedReplay({ pathname: '/', search: '', hash: '' });
  const clean = telemetry.sanitizeFeedEvent(snapshot);
  assert.equal(clean.properties.$snapshot_data, snapshot.properties.$snapshot_data);
  assert.equal(clean.properties.token, 'public-key');
  assert.equal(JSON.stringify(clean).includes('private'), false);
  telemetry.syncFeedReplay({ pathname: '/reader/private/revisions/id/file.pdf', search: '', hash: '' });
  assert.equal(telemetry.sanitizeFeedEvent(snapshot), null);
});

test('subscription operation survives the allowlist and approval-only replay marker is safe', () => {
  const event = telemetry.buildFeedEvent('feed_subscription_finished', { operation: 'create', outcome: 'success', duration_basis: 'subscription_attempt_request_to_authoritative_response' });
  assert.equal(event.operation, 'create');
  assert.equal(event.duration_basis, 'subscription_attempt_request_to_authoritative_response');
  assert.equal(telemetry.isReplayAllowed('/', '?telemetry_test=1'), true);
  assert.equal(telemetry.isReplayAllowed('/', '?telemetry_test=1&q=private'), false);
});
