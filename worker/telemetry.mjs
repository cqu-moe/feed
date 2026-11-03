import { PostHog } from 'posthog-node/edge';

const workerEvents = new Set([
  'feed_revision_ready',
  'feed_delivery_finalized',
  'feed_pipeline_summary',
  'feed_collection_attempt_finished',
  'feed_collection_backlog_snapshot',
]);
const triggers = new Set(['user', 'automatic', 'scheduled', 'recovery']);
const operations = new Set([
  'archive_revision',
  'mail_delivery',
  'pipeline_summary',
  'collection_attempt',
  'pipeline_backlog',
]);
const flows = new Set(['collection', 'notification', 'pipeline']);
const stages = new Set([
  'ready',
  'preflight',
  'retry',
  'provider_submission',
  'provider_receipt',
  'summary',
  'finished',
]);
const outcomes = new Set(['success', 'failure', 'partial', 'canceled', 'unverified']);
const commonProperties = new Set([
  'telemetry_version',
  'product',
  'surface',
  'environment',
  'release',
  'actor_type',
  'trigger',
  'operation',
  'flow',
  'stage',
  'outcome',
  'error_code',
  'warning_code',
  'duration_ms',
  'end_to_end_duration_ms',
  'duration_basis',
  'is_test',
  'operation_id',
  'attempt_id',
]);
const eventProperties = new Map([
  ['feed_revision_ready', new Set([
    'revision_id',
    'event_id',
    'capture_intent',
    'history_only',
    'event_created',
    'source_count',
    'requirement_count',
  ])],
  ['feed_delivery_finalized', new Set([
    'message_id',
    'owner_sub',
    'message_kind',
    'delivery_count',
    'event_count',
    'attempt_count',
    'state',
    'provider_submission',
    'delivered',
  ])],
  ['feed_pipeline_summary', new Set([
    'summary_kind',
    'window_start_epoch_ms',
    'window_end_epoch_ms',
    'success_count',
    'failure_count',
    'blocked_count',
    'canceled_count',
    'active_count',
    'task_count',
  ])],
  ['feed_collection_attempt_finished', new Set([
    'task_id',
    'source_id',
    'task_kind',
    'state',
    'attempt_count',
  ])],
  ['feed_collection_backlog_snapshot', new Set([
    'snapshot_kind',
    'window_start_epoch_ms',
    'window_end_epoch_ms',
    'failed_count',
    'blocked_count',
    'deferred_count',
    'active_count',
    'task_count',
    'max_attempt_count',
    'enabled_source_count',
    'failed_source_count',
    'overdue_source_count',
    'oldest_active_age_ms',
    'oldest_deferred_age_ms',
  ])],
]);
const pipelineKinds = new Set(['collection', 'ocr']);
const collectionTaskKinds = new Set(['discover', 'capture', 'recheck', 'backfill']);
const collectionAttemptStates = new Set(['succeeded', 'failed', 'blocked', 'deferred', 'cancelled']);

function environment(env) {
  return env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'test' ? env.ENVIRONMENT : 'development';
}

function captureEnabled(env) {
  return environment(env) === 'production' || env.POSTHOG_TEST_CAPTURE === 'true';
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function safeId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
}

function safeEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value);
}

function safeCorrelationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function validProperty(key, value) {
  if (value === undefined) return false;
  if (key === 'telemetry_version') return value === 2;
  if (key === 'product') return value === 'feed';
  if (key === 'surface') return value === 'worker';
  if (key === 'environment') return safeEnum(value, new Set(['production', 'development', 'test']));
  if (key === 'actor_type') return value === 'system';
  if (key === 'trigger') return safeEnum(value, triggers);
  if (key === 'operation') return safeEnum(value, operations);
  if (key === 'flow') return safeEnum(value, flows);
  if (key === 'stage') return safeEnum(value, stages);
  if (key === 'outcome') return safeEnum(value, outcomes);
  if (key === 'operation_id' || key === 'attempt_id') return safeCorrelationId(value);
  if (key === 'revision_id' || key === 'event_id' || key === 'message_id') return value === null || safeId(value);
  if (key === 'task_id') return safeId(value);
  if (key === 'source_id') return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value));
  if (key === 'owner_sub') return safeCorrelationId(value) && !value.includes('@');
  if (key === 'capture_intent') return safeEnum(value, new Set(['live', 'backfill', 'migrated', 'recheck', 'unknown']));
  if (key === 'message_kind') return safeEnum(value, new Set(['immediate', 'daily_digest']));
  if (key === 'summary_kind' || key === 'snapshot_kind') return safeEnum(value, pipelineKinds);
  if (key === 'state') return safeEnum(value, new Set([
    'accepted', 'delivered', 'bounced', 'complained', 'cancelled', 'rejected', 'submission_unknown', 'deferred',
    'succeeded', 'failed', 'blocked',
  ]));
  if (key === 'task_kind') return safeEnum(value, collectionTaskKinds);
  if (key === 'error_code' || key === 'warning_code') return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value);
  if (key === 'duration_basis') return safeEnum(value, new Set([
    'observed_to_ready_commit',
    'message_created_to_final_state',
    'task_ledger_observation_window',
    'task_attempt_started_to_ended',
    'task_created_to_backlog_observation',
  ]));
  if (key === 'release') return typeof value === 'string' && value.length <= 128;
  if (
    key === 'history_only' || key === 'event_created' || key === 'provider_submission' ||
    key === 'delivered' || key === 'is_test'
  ) return typeof value === 'boolean';
  if (
    key === 'source_count' || key === 'requirement_count' || key === 'delivery_count' ||
    key === 'event_count' || key === 'attempt_count' || key === 'success_count' ||
    key === 'failure_count' || key === 'blocked_count' || key === 'deferred_count' || key === 'canceled_count' ||
    key === 'active_count' || key === 'task_count' || key === 'max_attempt_count' ||
    key === 'failed_count' || key === 'enabled_source_count' ||
    key === 'failed_source_count' || key === 'overdue_source_count'
  ) return integer(value, { max: 1_000_000 });
  if (key === 'oldest_active_age_ms' || key === 'oldest_deferred_age_ms') return integer(value);
  if (key === 'window_start_epoch_ms' || key === 'window_end_epoch_ms') return integer(value, { min: 1 });
  if (key === 'duration_ms' || key === 'end_to_end_duration_ms') return integer(value);
  return typeof value === 'string' && value.length <= 64;
}

export function buildFeedWorkerEvent(env, event, distinctId, properties = {}) {
  const token = typeof env.POSTHOG_PROJECT_TOKEN === 'string' ? env.POSTHOG_PROJECT_TOKEN.trim() : '';
  if (!token || !captureEnabled(env) || !workerEvents.has(event) || typeof distinctId !== 'string' || !distinctId) return null;

  const allowed = new Set([...commonProperties, ...(eventProperties.get(event) ?? [])]);
  const source = {
    telemetry_version: 2,
    product: 'feed',
    surface: 'worker',
    environment: environment(env),
    release: typeof env.RELEASE === 'string' && env.RELEASE.trim() ? env.RELEASE.trim().slice(0, 128) : env.CF_VERSION_METADATA?.id ?? 'unconfigured',
    actor_type: 'system',
    ...properties,
    ...(environment(env) !== 'production' ? { is_test: true } : {}),
    $process_person_profile: false,
  };
  const captured = {};
  for (const key of allowed) {
    if (validProperty(key, source[key])) captured[key] = source[key];
  }
  captured.$process_person_profile = false;
  captured.$geoip_disable = true;
  return { distinctId, event, properties: captured };
}

function createClient(env) {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !captureEnabled(env)) return null;
  return new PostHog(token, {
    host: env.POSTHOG_HOST?.trim() || 'https://p.cqu.moe',
    flushAt: 1000,
    flushInterval: 0,
    requestTimeout: 2_000,
    fetchRetryCount: 1,
    privacyMode: true,
    enableExceptionAutocapture: false,
    before_send: message => buildFeedWorkerEvent(
      env,
      message?.event,
      message?.distinctId ?? '',
      message?.properties ?? {},
    ),
  });
}

function finish(client, lifecycle) {
  const closing = client.shutdown(2_000).catch(() => undefined);
  try {
    lifecycle?.waitUntil(closing);
  } catch {
    void closing;
  }
}

export function buildFeedPipelineSummaries(tasks, windowStart, windowDurationMs) {
  const groups = new Map([
    ['collection', []],
    ['ocr', []],
  ]);
  for (const task of tasks) {
    if (collectionTaskKinds.has(task?.kind)) groups.get('collection').push(task);
    else if (task?.kind === 'ocr') groups.get('ocr').push(task);
  }

  const summaries = [];
  for (const [summaryKind, rows] of groups) {
    const counts = { succeeded: 0, failed: 0, blocked: 0, cancelled: 0, active: 0 };
    for (const task of rows) {
      if (task.state === 'succeeded' || task.state === 'failed' || task.state === 'blocked' || task.state === 'cancelled') {
        counts[task.state] += 1;
      } else if (task.state === 'queued' || task.state === 'starting' || task.state === 'running' || task.state === 'deferred') {
        counts.active += 1;
      }
    }
    const terminalCount = counts.succeeded + counts.failed + counts.blocked + counts.cancelled;
    if (!terminalCount) continue;
    const degradedCount = counts.failed + counts.blocked;
    const outcome = counts.succeeded && degradedCount ? 'partial' : counts.succeeded ? 'success' : degradedCount ? 'failure' : 'canceled';
    const operationId = `pipeline:${summaryKind}:${windowStart}`;
    summaries.push({
      trigger: 'scheduled',
      operation: 'pipeline_summary',
      flow: 'pipeline',
      stage: 'summary',
      outcome,
      warning_code: counts.blocked ? 'blocked_tasks_present' : undefined,
      duration_ms: windowDurationMs,
      duration_basis: 'task_ledger_observation_window',
      operation_id: operationId,
      attempt_id: operationId,
      summary_kind: summaryKind,
      window_start_epoch_ms: windowStart,
      window_end_epoch_ms: windowStart + windowDurationMs,
      success_count: counts.succeeded,
      failure_count: counts.failed,
      blocked_count: counts.blocked,
      canceled_count: counts.cancelled,
      active_count: counts.active,
      task_count: terminalCount + counts.active,
    });
  }
  return summaries;
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : 'unknown';
}

export function buildFeedCollectionAttemptEvents(attempts) {
  const events = [];
  for (const attempt of attempts.slice(0, 1000)) {
    if (!safeId(attempt?.task_id) || !safeEnum(attempt?.task_kind, collectionTaskKinds)) continue;
    if (!safeEnum(attempt?.state, collectionAttemptStates)) continue;
    const attemptCount = Number(attempt?.attempt_count);
    if (!integer(attemptCount, { min: 1, max: 1000 })) continue;
    const duration = integer(attempt?.started_at) && integer(attempt?.ended_at) && attempt.ended_at >= attempt.started_at
      ? attempt.ended_at - attempt.started_at
      : undefined;
    events.push({
      trigger: 'scheduled',
      operation: 'collection_attempt',
      flow: 'collection',
      stage: 'finished',
      outcome: attempt.state === 'succeeded' ? 'success'
        : attempt.state === 'cancelled' ? 'canceled'
        : attempt.state === 'deferred' || attempt.state === 'blocked' ? 'partial'
        : 'failure',
      error_code: attempt.state === 'succeeded' ? undefined : safeErrorCode(attempt?.error_code),
      ...(duration === undefined ? {} : {
        duration_ms: duration,
        duration_basis: 'task_attempt_started_to_ended',
      }),
      operation_id: attempt.task_id,
      attempt_id: `${attempt.task_id}:${attemptCount}`,
      task_id: attempt.task_id,
      source_id: attempt.source_id ?? null,
      task_kind: attempt.task_kind,
      state: attempt.state,
      attempt_count: attemptCount,
    });
  }
  return events;
}

export function buildFeedCollectionBacklogSnapshot(aggregate, sourceHealth, windowEnd, windowDurationMs) {
  const count = value => integer(value) ? value : 0;
  const counts = {
    failed: count(aggregate?.failed_count),
    blocked: count(aggregate?.blocked_count),
    deferred: count(aggregate?.deferred_count),
    active: count(aggregate?.active_count),
  };
  const taskCount = counts.failed + counts.blocked + counts.deferred + counts.active;
  const degradedCount = counts.failed + counts.blocked;
  const age = value => integer(value) && windowEnd >= value ? windowEnd - value : undefined;
  const oldestBacklogAge = age(aggregate?.oldest_backlog_created_at);
  const oldestActiveAge = age(aggregate?.oldest_active_created_at);
  const oldestDeferredAge = age(aggregate?.oldest_deferred_created_at);
  return {
    trigger: 'scheduled',
    operation: 'pipeline_backlog',
    flow: 'pipeline',
    stage: 'summary',
    outcome: degradedCount ? 'failure' : counts.deferred || counts.active ? 'partial' : 'success',
    warning_code: taskCount ? 'backlog_present' : undefined,
    end_to_end_duration_ms: oldestBacklogAge,
    duration_basis: oldestBacklogAge === undefined ? undefined : 'task_created_to_backlog_observation',
    operation_id: `pipeline:backlog:${windowEnd - windowDurationMs}`,
    attempt_id: `pipeline:backlog:${windowEnd - windowDurationMs}`,
    snapshot_kind: 'collection',
    window_start_epoch_ms: windowEnd - windowDurationMs,
    window_end_epoch_ms: windowEnd,
    failed_count: counts.failed,
    blocked_count: counts.blocked,
    deferred_count: counts.deferred,
    active_count: counts.active,
    task_count: taskCount,
    max_attempt_count: count(aggregate?.max_attempt_count),
    enabled_source_count: count(sourceHealth?.enabled_count),
    failed_source_count: count(sourceHealth?.failed_count),
    overdue_source_count: count(sourceHealth?.overdue_count),
    oldest_active_age_ms: oldestActiveAge,
    oldest_deferred_age_ms: oldestDeferredAge,
  };
}

export async function captureFeedPipelineSummaries(env, lifecycle, now = Date.now) {
  const token = typeof env.POSTHOG_PROJECT_TOKEN === 'string' ? env.POSTHOG_PROJECT_TOKEN.trim() : '';
  if (!token || !captureEnabled(env)) return;
  const windowDurationMs = 300_000;
  const windowEnd = Math.floor(now() / windowDurationMs) * windowDurationMs;
  const windowStart = windowEnd - windowDurationMs;
  const [summaryRows, attemptRows, backlogAggregate, sourceHealth] = await Promise.all([
    env.DB.prepare(`SELECT kind,state FROM tasks
      WHERE updated_at>? AND updated_at<=? AND kind IN ('discover','capture','recheck','backfill','ocr')`)
      .bind(windowStart, windowEnd).all(),
    env.DB.prepare(`SELECT t.id AS task_id,t.source_id,t.kind AS task_kind,a.attempt_no AS attempt_count,
        a.state,a.error_code,a.started_at,a.ended_at
      FROM tasks t JOIN task_attempts a ON a.task_id=t.id
      WHERE a.ended_at>? AND a.ended_at<=? AND t.kind IN ('discover','capture','recheck','backfill')
        AND a.state IN ('succeeded','failed','blocked','deferred','cancelled')
      ORDER BY a.ended_at,t.id,a.attempt_no LIMIT 1000`)
      .bind(windowStart, windowEnd).all(),
    env.DB.prepare(`SELECT
        SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN state='blocked' THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN state='deferred' THEN 1 ELSE 0 END) AS deferred_count,
        SUM(CASE WHEN state IN ('queued','starting','running') THEN 1 ELSE 0 END) AS active_count,
        MAX(attempt_no) AS max_attempt_count,
        MIN(created_at) AS oldest_backlog_created_at,
        MIN(CASE WHEN state IN ('queued','starting','running') THEN created_at END) AS oldest_active_created_at,
        MIN(CASE WHEN state='deferred' THEN created_at END) AS oldest_deferred_created_at
      FROM tasks WHERE kind IN ('discover','capture','recheck','backfill')
        AND state IN ('failed','blocked','deferred','queued','starting','running')`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS enabled_count,
        SUM(CASE WHEN s.validation_state='failed' OR s.error IS NOT NULL AND TRIM(s.error)<>'' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN s.validation_state='verified' AND s.next_discovery_at>0 AND s.next_discovery_at<=?
          THEN 1 ELSE 0 END) AS overdue_count
      FROM sources s JOIN sites st ON st.id=s.site_id
      WHERE s.enabled=1 AND st.enabled=1`).bind(windowEnd - 3_600_000).first(),
  ]);
  const messages = [];
  for (const properties of buildFeedPipelineSummaries(summaryRows.results ?? [], windowStart, windowDurationMs)) {
    messages.push(buildFeedWorkerEvent(
      env,
      'feed_pipeline_summary',
      `feed_pipeline:${properties.summary_kind}:${windowStart}`,
      properties,
    ));
  }
  for (const properties of buildFeedCollectionAttemptEvents(attemptRows.results ?? [])) {
    messages.push(buildFeedWorkerEvent(
      env,
      'feed_collection_attempt_finished',
      `feed_task:${properties.operation_id}:${properties.attempt_count}`,
      properties,
    ));
  }
  messages.push(buildFeedWorkerEvent(
    env,
    'feed_collection_backlog_snapshot',
    `feed_backlog:collection:${windowStart}`,
    buildFeedCollectionBacklogSnapshot(backlogAggregate, sourceHealth ?? {}, windowEnd, windowDurationMs),
  ));
  captureFeedWorkerEvents(env, lifecycle, messages.filter(Boolean));
}

export function captureFeedWorkerEvent(env, lifecycle, event, distinctId, properties = {}) {
  captureFeedWorkerEvents(env, lifecycle, [buildFeedWorkerEvent(env, event, distinctId, properties)].filter(Boolean));
}

function captureFeedWorkerEvents(env, lifecycle, messages) {
  try {
    if (!messages.length) return;
    const client = createClient(env);
    if (!client) return;
    for (const message of messages) client.capture(message);
    finish(client, lifecycle);
  } catch {
    // Product analytics is bounded and best-effort; it never changes a committed business result.
  }
}
