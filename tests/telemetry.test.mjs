import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedPipelineSummaries,
  buildFeedWorkerEvent,
} from '../worker/telemetry.mjs';

const revisionId = 'a11111111111111111111111';
const eventId = 'b22222222222222222222222';

test('worker telemetry stays disabled outside production unless acceptance capture is explicit', () => {
  const token = { POSTHOG_PROJECT_TOKEN: 'public-project-token' };
  assert.equal(buildFeedWorkerEvent(
    { ...token, ENVIRONMENT: 'development' },
    'feed_revision_ready',
    `feed_revision:${revisionId}`,
    { operation_id: revisionId },
  ), null);
  assert.equal(buildFeedWorkerEvent(
    { ...token, ENVIRONMENT: 'test' },
    'feed_revision_ready',
    `feed_revision:${revisionId}`,
    { operation_id: revisionId },
  ), null);

  const accepted = buildFeedWorkerEvent(
    { ...token, ENVIRONMENT: 'test', POSTHOG_TEST_CAPTURE: 'true' },
    'feed_revision_ready',
    `feed_revision:${revisionId}`,
    { operation_id: revisionId, revision_id: revisionId, event_id: eventId },
  );
  assert.equal(accepted.properties.is_test, true);
  assert.equal(accepted.properties.$process_person_profile, false);
});

test('worker event properties use a strict field allowlist', () => {
  const properties = buildFeedWorkerEvent(
    { POSTHOG_PROJECT_TOKEN: 'public-project-token', ENVIRONMENT: 'production' },
    'feed_revision_ready',
    `feed_revision:${revisionId}`,
    {
      operation_id: revisionId,
      revision_id: revisionId,
      event_id: eventId,
      query: '奖学金',
      title: '通知标题',
      url: 'https://jwc.cqu.edu.cn/info/1.htm',
      recipient: 'reader@example.test',
      error: 'raw exception with https://secret.example/path',
      token: 'private-rss-token',
    },
  ).properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    '$process_person_profile',
    'actor_type',
    'environment',
    'event_id',
    'operation_id',
    'product',
    'release',
    'revision_id',
    'surface',
    'telemetry_version',
  ]);
  assert.equal(JSON.stringify(properties).includes('reader@example.test'), false);
  assert.equal(JSON.stringify(properties).includes('jwc.cqu.edu.cn'), false);
});

test('pipeline summaries count logical task outcomes with stable window identities', () => {
  const windowStart = Date.UTC(2026, 9, 13, 0, 0);
  const summaries = buildFeedPipelineSummaries([
    { kind: 'capture', state: 'succeeded', id: '111111111111111111111111' },
    { kind: 'capture', state: 'blocked', id: '222222222222222222222222' },
    { kind: 'discover', state: 'running', id: '333333333333333333333333' },
    { kind: 'ocr', state: 'succeeded', id: '444444444444444444444444' },
  ], windowStart, 300_000);

  assert.deepEqual(summaries.map(summary => summary.summary_kind), ['collection', 'ocr']);
  assert.deepEqual(
    summaries.map(({ success_count, blocked_count, active_count, task_count, outcome }) => ({
      success_count,
      blocked_count,
      active_count,
      task_count,
      outcome,
    })),
    [
      { success_count: 1, blocked_count: 1, active_count: 1, task_count: 3, outcome: 'partial' },
      { success_count: 1, blocked_count: 0, active_count: 0, task_count: 1, outcome: 'success' },
    ],
  );
  for (const summary of summaries) {
    assert.equal(summary.operation_id, `pipeline:${summary.summary_kind}:${windowStart}`);
    assert.equal(summary.attempt_id, summary.operation_id);
    assert.equal(summary.duration_basis, 'task_ledger_observation_window');
    assert.equal(summary.duration_ms, 300_000);
  }
  const captured=buildFeedWorkerEvent(
    {POSTHOG_PROJECT_TOKEN:'public-project-token',ENVIRONMENT:'production'},
    'feed_pipeline_summary',
    'feed_pipeline:collection:'+windowStart,
    summaries[0],
  );
  assert.equal(captured.properties.telemetry_version,2);
  assert.equal(captured.properties.success_count,1);
  assert.equal(captured.properties.active_count,1);
  assert.equal(buildFeedPipelineSummaries([
    { kind: 'capture', state: 'deferred', id: '555555555555555555555555' },
  ], windowStart, 300_000).length, 0);
});
