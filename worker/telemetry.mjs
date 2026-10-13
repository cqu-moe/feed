import { PostHog } from 'posthog-node/edge';

const workerEvents = new Set(['feed_revision_ready', 'feed_delivery_finalized', 'feed_pipeline_summary']);
const triggers = new Set(['user', 'automatic', 'scheduled', 'recovery']);
const operations = new Set(['archive_revision', 'mail_delivery', 'pipeline_summary']);
const flows = new Set(['collection', 'notification', 'pipeline']);
const stages = new Set(['ready', 'preflight', 'retry', 'provider_submission', 'provider_receipt', 'summary']);
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
]);
const pipelineKinds = new Set(['collection', 'ocr']);
const collectionTaskKinds = new Set(['discover', 'capture', 'recheck', 'backfill']);

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
  if (key === 'owner_sub') return safeCorrelationId(value) && !value.includes('@');
  if (key === 'capture_intent') return safeEnum(value, new Set(['live', 'backfill', 'migrated', 'recheck', 'unknown']));
  if (key === 'message_kind') return safeEnum(value, new Set(['immediate', 'daily_digest']));
  if (key === 'summary_kind') return safeEnum(value, pipelineKinds);
  if (key === 'state') return safeEnum(value, new Set([
    'accepted', 'delivered', 'bounced', 'complained', 'cancelled', 'rejected', 'submission_unknown', 'deferred',
  ]));
  if (key === 'error_code' || key === 'warning_code') return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value);
  if (key === 'duration_basis') return safeEnum(value, new Set([
    'observed_to_ready_commit', 'message_created_to_final_state', 'task_ledger_observation_window',
  ]));
  if (key === 'release') return typeof value === 'string' && value.length <= 128;
  if (
    key === 'history_only' || key === 'event_created' || key === 'provider_submission' ||
    key === 'delivered' || key === 'is_test'
  ) return typeof value === 'boolean';
  if (
    key === 'source_count' || key === 'requirement_count' || key === 'delivery_count' ||
    key === 'event_count' || key === 'attempt_count' || key === 'success_count' ||
    key === 'failure_count' || key === 'blocked_count' || key === 'canceled_count' ||
    key === 'active_count' || key === 'task_count'
  ) return integer(value, { max: 1_000_000 });
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
  return { distinctId, event, properties: captured };
}

function createClient(env) {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || !captureEnabled(env)) return null;
  return new PostHog(token, {
    host: env.POSTHOG_HOST?.trim() || 'https://p.cqu.moe',
    flushAt: 1,
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

export async function captureFeedPipelineSummaries(env, lifecycle, now = Date.now) {
  const token = typeof env.POSTHOG_PROJECT_TOKEN === 'string' ? env.POSTHOG_PROJECT_TOKEN.trim() : '';
  if (!token || !captureEnabled(env)) return;
  const windowDurationMs = 300_000;
  const windowEnd = Math.floor(now() / windowDurationMs) * windowDurationMs;
  const windowStart = windowEnd - windowDurationMs;
  const rows = await env.DB.prepare(`SELECT kind,state FROM tasks
    WHERE updated_at>? AND updated_at<=? AND kind IN ('discover','capture','recheck','backfill','ocr')`)
    .bind(windowStart, windowEnd).all();
  for (const properties of buildFeedPipelineSummaries(rows.results ?? [], windowStart, windowDurationMs)) {
    captureFeedWorkerEvent(
      env,
      lifecycle,
      'feed_pipeline_summary',
      `feed_pipeline:${properties.summary_kind}:${windowStart}`,
      properties,
    );
  }
}

export function captureFeedWorkerEvent(env, lifecycle, event, distinctId, properties = {}) {
  try {
    const message = buildFeedWorkerEvent(env, event, distinctId, properties);
    if (!message) return;
    const client = createClient(env);
    if (!client) return;
    client.capture(message);
    finish(client, lifecycle);
  } catch {
    // Product analytics is bounded and best-effort; it never changes a committed business result.
  }
}
