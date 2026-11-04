import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  buildFeedCollectionAttemptEvents,
  buildFeedCollectionBacklogSnapshot,
  buildFeedPipelineSummaries,
  buildFeedWorkerEvent,
  captureFeedPipelineSummaries,
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
    '$geoip_disable', '$process_person_profile',
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

test('collection attempt telemetry preserves task-attempt identity and machine errors', () => {
  const taskId = 'c33333333333333333333333';
  const attempts = buildFeedCollectionAttemptEvents([
    {
      task_id: taskId,
      source_id: 'jwc',
      task_kind: 'discover',
      state: 'failed',
      attempt_count: 2,
      error_code: 'provider_error',
      started_at: 1_000,
      ended_at: 61_000,
      other_current_attempt: 3,
      last_error: 'Browser Origin did not become ready (HTTP 200)',
    },
    {
      task_id: taskId,
      source_id: 'intex',
      task_kind: 'capture',
      state: 'succeeded',
      attempt_count: 3,
      started_at: 2_000,
      ended_at: 32_000,
    },
    { task_id: 'invalid', task_kind: 'discover', state: 'succeeded', attempt_count: 1 },
    { task_id: 'd44444444444444444444444', task_kind: 'discover', state: 'starting', attempt_count: 1 },
  ]);

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(({ outcome, error_code, duration_ms, attempt_id }) => ({
    outcome,
    error_code,
    duration_ms,
    attempt_id,
  })), [
    { outcome: 'failure', error_code: 'provider_error', duration_ms: 60_000, attempt_id: `${taskId}:2` },
    { outcome: 'success', error_code: undefined, duration_ms: 30_000, attempt_id: `${taskId}:3` },
  ]);
  const captured = buildFeedWorkerEvent(
    { POSTHOG_PROJECT_TOKEN: 'public-project-token', ENVIRONMENT: 'production' },
    'feed_collection_attempt_finished',
    `feed_task:${taskId}:2`,
    attempts[0],
  ).properties;
  assert.equal(captured.source_id, 'jwc');
  assert.equal(captured.task_kind, 'discover');
  assert.equal(captured.attempt_count, 2);
  assert.equal(JSON.stringify(captured).includes('Browser Origin'), false);
  assert.equal(JSON.stringify(captured).includes('HTTP 200'), false);
});

test('collection backlog snapshots remain present when no work terminates', () => {
  const windowEnd = Date.UTC(2026, 10, 3, 0, 5);
  const snapshot = buildFeedCollectionBacklogSnapshot({
    failed_count: 44,
    blocked_count: 1,
    deferred_count: 1,
    active_count: 1,
    max_attempt_count: 3,
    oldest_backlog_created_at: windowEnd - 86_400_000,
    oldest_active_created_at: windowEnd - 600_000,
    oldest_deferred_created_at: windowEnd - 3_600_000,
    invalid_created_at: null,
  }, { enabled_count: 56, failed_count: 2, overdue_count: 2 }, windowEnd, 300_000);
  const captured = buildFeedWorkerEvent(
    { POSTHOG_PROJECT_TOKEN: 'public-project-token', ENVIRONMENT: 'production' },
    'feed_collection_backlog_snapshot',
    `feed_backlog:collection:${windowEnd - 300_000}`,
    snapshot,
  ).properties;

  assert.deepEqual(captured, {
    $geoip_disable: true,
    $process_person_profile: false,
    actor_type: 'system',
    attempt_id: `pipeline:backlog:${windowEnd - 300_000}`,
    blocked_count: 1,
    deferred_count: 1,
    end_to_end_duration_ms: 86_400_000,
    environment: 'production',
    enabled_source_count: 56,
    failed_count: 44,
    failed_source_count: 2,
    active_count: 1,
    flow: 'pipeline',
    max_attempt_count: 3,
    operation: 'pipeline_backlog',
    operation_id: `pipeline:backlog:${windowEnd - 300_000}`,
    outcome: 'failure',
    product: 'feed',
    release: 'unconfigured',
    snapshot_kind: 'collection',
    stage: 'summary',
    surface: 'worker',
    task_count: 47,
    telemetry_version: 2,
    trigger: 'scheduled',
    duration_basis: 'task_created_to_backlog_observation',
    warning_code: 'backlog_present',
    overdue_source_count: 2,
    oldest_active_age_ms: 600_000,
    oldest_deferred_age_ms: 3_600_000,
    window_end_epoch_ms: windowEnd,
    window_start_epoch_ms: windowEnd - 300_000,
  });
  assert.equal(
    buildFeedCollectionBacklogSnapshot({}, { enabled_count: 0, failed_count: 0, overdue_count: 0 }, windowEnd, 300_000).task_count,
    0,
  );
});

test('scheduled collection telemetry sends persisted attempts and whole backlog in one batch', async t => {
  const windowEnd = Date.UTC(2026, 10, 3, 10, 15);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default {}', compatibilityDate: '2026-10-11', d1Databases: ['DB'],
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const name of ['0001_feed.sql', '0005_task_runtime.sql', '0006_sources.sql']) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    for (const statement of sql.split(/;\s*\n(?=CREATE|ALTER|WITH|PRAGMA|$)/)
      .map(value => value.trim()).filter(value => value && !/^PRAGMA\b/i.test(value))) {
      await db.prepare(statement).run();
    }
  }
  await db.prepare(`INSERT INTO sources(id,site_id,name,url,enabled,validation_state,error,next_discovery_at)
    VALUES ('jwc','7fd03676e5751e9b6dd95ecb','教务处','https://jwc.cqu.edu.cn/',1,'verified',
      'Browser Origin did not become ready (HTTP 200)',?)`).bind(windowEnd - 7_200_000).run();
  await db.prepare(`INSERT INTO sources(id,site_id,name,url,enabled,validation_state,next_discovery_at)
    VALUES ('intex','1922681dab068aba5ab31dd8','国际处','https://intex.cqu.edu.cn/',0,'failed',0)`).run();
  for (const [id, enabled, age] of [['stale', 1, 32 * 3_600_000], ['fresh', 1, 86_400_000 + 65 * 60_000], ['paused', 0, 32 * 3_600_000]]) {
    await db.prepare(`INSERT INTO sources(id,site_id,name,url,enabled,validation_state,refresh_interval_sec,next_discovery_at,last_run_at)
      VALUES (?,'7fd03676e5751e9b6dd95ecb',?,'https://jwc.cqu.edu.cn/',?,'verified',86400,?,?)`)
      .bind(id, id, enabled, windowEnd + 3_600_000, new Date(windowEnd - age).toISOString()).run();
  }
  // 09:01 became due, the 10:00 scan selected 10:48; observe at 10:15.
  const hour=Date.UTC(2026,10,3,10);
  const scheduledCases=[
    {id:'planned',plan:hour+48*60_000},
    {id:'processing',plan:hour+12*60_000},
    {id:'first-planned',plan:hour+48*60_000,first:true},
    {id:'first-expired',plan:hour+4*60_000,first:true},
    {id:'grace-expired',plan:hour+4*60_000},
    {id:'workflow-backoff',plan:hour+54*60_000,original:hour+4*60_000,state:'running'},
    {id:'missed-previous',plan:hour+48*60_000,age:2*86_400_000+74*60_000},
    {id:'old-config',plan:hour+48*60_000,version:2},
    {id:'retry-plan',plan:hour+48*60_000,attempt:2},
    {id:'failed-plan',plan:hour+48*60_000,state:'failed'},
    {id:'failed-send',plan:hour+48*60_000,launchError:'send failed'},
    {id:'existing-error',plan:hour+48*60_000,error:'origin error'},
    {id:'out-of-hour',plan:hour+3_600_000},
    {id:'pagination',plan:hour+48*60_000,page:2},
    {id:'no-launch',plan:hour+48*60_000,noLaunch:true},
  ];
  for(const row of scheduledCases){
    await db.prepare(`INSERT INTO sources(id,site_id,name,url,enabled,validation_state,refresh_interval_sec,next_discovery_at,last_run_at,error)
      VALUES (?,'7fd03676e5751e9b6dd95ecb',?,'https://jwc.cqu.edu.cn/',1,'verified',86400,?,?,?)`)
      .bind(row.id,row.id,windowEnd+86_400_000,row.first?null:new Date(windowEnd-(row.age??86_400_000+74*60_000)).toISOString(),row.error??null).run();
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,state,attempt_no,due_at,payload_json,created_at,updated_at)
      VALUES (?,'discover',?,?,?, ?,?,?,?,?)`)
      .bind(row.id,'discover:'+row.id,row.id,row.state??'queued',row.attempt??1,row.plan,JSON.stringify({
        source:{siteId:'7fd03676e5751e9b6dd95ecb',configVersion:row.version??1},page:row.page??1,scheduledHour:hour,scheduledStartAt:row.original??row.plan,
      }),hour,hour).run();
    if(!row.noLaunch)await db.prepare(`INSERT INTO outbox(id,topic,dedupe_key,payload_json,available_at,last_error,created_at,updated_at)
      VALUES (?,'feed-jobs',?,'{}',?,?,?,?)`)
      .bind(row.id,'start:'+row.id+':a1',hour,row.launchError??null,hour,hour).run();
  }
  const taskId = 'e55555555555555555555555';
  for (const [id, state, attempt, age] of [
    [taskId, 'failed', 3, 86_400_000],
    ['f66666666666666666666666', 'deferred', 2, 3_600_000],
    ['a77777777777777777777777', 'running', 1, 7_200_000],
  ]) {
    await db.prepare(`INSERT INTO tasks(id,kind,business_key,source_id,state,attempt_no,due_at,created_at,updated_at)
      VALUES (?,'discover',?,'jwc',?,?,0,?,?)`)
      .bind(id, `discover:${id}`, state, attempt, windowEnd - age, windowEnd - 260_000).run();
  }
  for (const [attempt, endedAt] of [[1, windowEnd - 260_000], [2, windowEnd], [3, windowEnd + 1]]) {
    await db.prepare(`INSERT INTO task_attempts(task_id,attempt_no,workflow_instance_id,state,started_at,ended_at,error_code)
      VALUES (?,?,?,'failed',?,?,'provider_error')`)
      .bind(taskId, attempt, `task-${taskId}-a${attempt}`, endedAt - 60_000, endedAt).run();
  }
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'posthog.test');
    const body = Buffer.from(await request.arrayBuffer());
    requests.push(JSON.parse((request.headers.get('content-encoding') === 'gzip' ? gunzipSync(body) : body).toString()));
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const closing = [];
  await captureFeedPipelineSummaries(
    { DB: db, POSTHOG_PROJECT_TOKEN: 'public-project-token', POSTHOG_HOST: 'https://posthog.test',
      ENVIRONMENT: 'test', POSTHOG_TEST_CAPTURE: 'true' },
    { waitUntil(promise) { closing.push(promise); } },
    () => windowEnd,
  );
  await Promise.all(closing);
  assert.equal(requests.length, 1);
  const events = requests[0].batch;
  assert.equal(events.length, 4);
  const attempts = events.filter(event => event.event === 'feed_collection_attempt_finished');
  assert.deepEqual(attempts.map(event => event.properties.attempt_id), [`${taskId}:1`, `${taskId}:2`]);
  for (const event of attempts) {
    assert.equal(event.properties.source_id, 'jwc');
    assert.equal(event.properties.error_code, 'provider_error');
    assert.equal(event.properties.duration_ms, 60_000);
    assert.equal(event.properties.is_test, true);
  }
  const snapshot = events.find(event => event.event === 'feed_collection_backlog_snapshot').properties;
  assert.equal(snapshot.failed_count, 2);
  assert.equal(snapshot.deferred_count, 1);
  assert.equal(snapshot.active_count, 15);
  assert.equal(snapshot.enabled_source_count, 18);
  assert.equal(snapshot.failed_source_count, 2);
  assert.equal(snapshot.overdue_source_count, 14, 'only valid current-round plans suppress overdue checks within their own processing grace');
  assert.equal(snapshot.oldest_active_age_ms, 7_200_000);
  assert.equal(snapshot.oldest_deferred_age_ms, 3_600_000);
  assert.equal(events.find(event => event.event === 'feed_pipeline_summary').properties.failure_count, 1);
  assert.equal(JSON.stringify(requests).includes('Browser Origin'), false);
});
