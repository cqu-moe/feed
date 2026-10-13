type EventLike = {
  event: string;
  uuid?: unknown;
  timestamp?: unknown;
  properties: Record<string, unknown>;
};

type PostHogClient = typeof import('posthog-js/dist/module.no-external')['default'];
type DeferredCapture = { event: FeedEvent; properties: Record<string, unknown> };

export type FeedEvent =
  | 'app_session_ready'
  | 'feed_search_completed'
  | 'feed_item_opened'
  | 'feed_subscription_finished';

const feedEvents = new Set<FeedEvent>([
  'app_session_ready',
  'feed_search_completed',
  'feed_item_opened',
  'feed_subscription_finished',
]);
const triggers = new Set(['user', 'automatic', 'scheduled', 'recovery']);
const operations = new Set(['app_session', 'search_filter', 'article_read', 'pdf_read', 'create', 'update', 'delete', 'restore', 'rss_rotate', 'rss_revoke']);
const flows = new Set(['app', 'reading', 'subscription']);
const stages = new Set(['ready', 'result', 'opened', 'finished']);
const outcomes = new Set(['success', 'failure', 'partial', 'canceled', 'needs_input', 'unverified']);
const contentKinds = new Set(['article', 'pdf']);
const revisionStates = new Set(['ready', 'assembling', 'blocked']);

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
  'duration_basis',
  'operation_id',
  'attempt_id',
  'is_test',
]);

const eventProperties = new Map<FeedEvent, Set<string>>([
  ['app_session_ready', new Set(['entitled'])],
  ['feed_search_completed', new Set(['result_count', 'zero_results', 'has_query', 'has_source_filter', 'page'])],
  ['feed_item_opened', new Set(['article_id', 'revision_id', 'content_kind', 'ocr_used', 'revision_state'])],
  ['feed_subscription_finished', new Set(['subscription_id', 'no_op'])],
]);

const durationBases = new Set([
  'session_request_to_confirmed_session',
  'user_action_to_search_result',
  'content_request_to_readable_response',
  'subscription_attempt_request_to_authoritative_response',
]);

const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || 'https://p.cqu.moe';
const isProduction = import.meta.env.PROD;
const environment = isProduction ? 'production' : import.meta.env.MODE === 'test' ? 'test' : 'development';
const release = import.meta.env.VITE_RELEASE?.trim() || 'unconfigured';
const isTestEvent = !isProduction || import.meta.env.VITE_POSTHOG_TEST === 'true' || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('telemetry_test') === '1');

let client: PostHogClient | null = null;
let initialization: Promise<boolean> | null = null;
let initializationFailed = false;
let activeUserId: string | null = null;
let identityRequest: { userId: string | null } | null = null;
let replayLocation: { pathname: string; search: string; hash: string } | null = null;
let deferredCaptures: DeferredCapture[] = [];
let sessionReadyOperationId: string | null = null;

function safeId(value: unknown, length = 24): boolean {
  return typeof value === 'string' && value.length === length && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeEnum<T extends string>(value: unknown, allowed: Set<T>): value is T {
  return typeof value === 'string' && allowed.has(value as T);
}

function validProperty(key: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (key === 'telemetry_version') return value === 2;
  if (key === 'product') return value === 'feed';
  if (key === 'surface') return value === 'web';
  if (key === 'environment') return safeEnum(value, new Set(['production', 'development', 'test']));
  if (key === 'actor_type') return value === 'user';
  if (key === 'trigger') return safeEnum(value, triggers);
  if (key === 'operation') return safeEnum(value, operations);
  if (key === 'flow') return safeEnum(value, flows);
  if (key === 'stage') return safeEnum(value, stages);
  if (key === 'outcome') return safeEnum(value, outcomes);
  if (key === 'content_kind') return safeEnum(value, contentKinds);
  if (key === 'revision_state') return safeEnum(value, revisionStates);
  if (key === 'operation_id') return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
  if (key === 'attempt_id') return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
  if (key === 'article_id' || key === 'subscription_id') return safeId(value);
  if (key === 'revision_id') return value === null || safeId(value);
  if (key === 'duration_basis') return safeEnum(value, durationBases);
  if (key === 'duration_ms') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (key === 'error_code' || key === 'warning_code') return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value);
  if (key === 'release') return typeof value === 'string' && value.length <= 128;
  if (key === 'page') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 500;
  if (key === 'result_count') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (
    key === 'entitled' || key === 'zero_results' || key === 'has_query' || key === 'has_source_filter' ||
    key === 'ocr_used' || key === 'no_op' || key === 'is_test'
  ) return typeof value === 'boolean';
  return typeof value === 'string' && value.length <= 64;
}

export function buildFeedEvent(event: FeedEvent, properties: Record<string, unknown>): Record<string, unknown> {
  const source: Record<string, unknown> = {
    telemetry_version: 2,
    product: 'feed',
    surface: 'web',
    environment,
    release,
    actor_type: 'user',
    trigger: 'user',
    ...properties,
    ...(isTestEvent ? { is_test: true } : {}),
  };
  const allowed = new Set([...commonProperties, ...(eventProperties.get(event) ?? [])]);
  const captured: Record<string, unknown> = {};
  for (const key of allowed) {
    if (validProperty(key, source[key])) captured[key] = source[key];
  }
  return captured;
}

const systemProperties = new Set([
  'token', 'distinct_id', '$lib', '$lib_version', '$device_id', '$user_id',
  '$session_id', '$window_id', '$process_person_profile',
]);
const snapshotProperties = new Set([...systemProperties, '$snapshot_data', '$snapshot_bytes', '$snapshot_host']);
const identifyProperties = new Set([...systemProperties, '$anon_distinct_id']);

export function sanitizeFeedEvent<T extends EventLike>(event: T | null): T | null {
  if (!event) return null;
  const source = event.properties ?? {};
  let properties: Record<string, unknown>;
  if (event.event === '$snapshot') {
    if (!replayLocation || !isReplayAllowed(replayLocation.pathname, replayLocation.search, replayLocation.hash)) return null;
    properties = Object.fromEntries(Object.entries(source).filter(([key]) => snapshotProperties.has(key)));
  } else if (event.event === '$identify') {
    properties = Object.fromEntries(Object.entries(source).filter(([key]) => identifyProperties.has(key)));
  } else {
    if (!feedEvents.has(event.event as FeedEvent)) return null;
    properties = {
      ...buildFeedEvent(event.event as FeedEvent, source),
      ...Object.fromEntries(Object.entries(source).filter(([key]) => systemProperties.has(key))),
    };
  }
  Object.assign(properties, { $geoip_disable: true, telemetry_version: 2, product: 'feed', surface: 'web', environment, release, ...(isTestEvent ? { is_test: true } : {}) });
  // Never retain SDK-generated person updates, which may include original URLs.
  return { event: event.event, ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }), properties } as T;
}

export function isReplayAllowed(pathname: string, search = '', hash = ''): boolean {
  const params = new URLSearchParams(search);
  const safeSearch = params.size === 0 || (params.size === 1 && params.get('telemetry_test') === '1');
  return (pathname === '/' || pathname === '/subscriptions') && safeSearch && hash === '';
}

function applyIdentity(posthog: PostHogClient, userId: string | null): void {
  const persistedUserId = posthog.get_property("$user_id");
  if (typeof persistedUserId === "string" && persistedUserId !== userId) posthog.reset();
  if (!userId) {
    if (activeUserId && persistedUserId === undefined) posthog.reset();
    activeUserId = null;
    return;
  }
  if (activeUserId && activeUserId !== userId && persistedUserId === undefined) posthog.reset();
  posthog.identify(userId);
  activeUserId = userId;
}

function syncReplay(posthog: PostHogClient, location: { pathname: string; search: string; hash: string }): void {
  if (window.location.origin === "https://feed.cqu.moe" && isReplayAllowed(location.pathname, location.search, location.hash)) posthog.startSessionRecording(true);
  else posthog.stopSessionRecording();
}

export function initFeedTelemetry(): Promise<boolean> {
  if (client) return Promise.resolve(true);
  if (!isProduction) return Promise.resolve(false);
  if (!token) {
    if (import.meta.env.DEV) {
      console.info('VITE_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_PROJECT_TOKEN is configured');
    }
    return Promise.resolve(false);
  }
  if (initializationFailed) return Promise.resolve(false);
  if (initialization) return initialization;

  initialization = (async (): Promise<boolean> => {
    try {
      const [{ default: loadedPostHog }] = await Promise.all([
        import('posthog-js/dist/module.no-external'),
        import('posthog-js/dist/posthog-recorder'),
      ]);
      loadedPostHog.init(token, {
        api_host: host,
        asset_host: host,
        persistence: 'localStorage',
        cross_subdomain_cookie: false,
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_performance: false,
        capture_dead_clicks: false,
        save_referrer: false,
        save_campaign_params: false,
        disable_scroll_properties: true,
        logs: { captureConsoleLogs: false },
        disable_surveys: true,
        disable_product_tours: true,
        advanced_disable_feature_flags: true,
        advanced_disable_toolbar_metrics: true,
        disable_session_recording: true,
        session_recording: {
          sampleRate: 1,
          slimDOMOptions: "all",
          collectFonts: false,
          captureJsonLd: false,
          recordCrossOriginIframes: false,
          streamNetworkBody: false,
          captureCanvas: { recordCanvas: false },
          maskTextFn: () => "[masked]",
          maskCapturedNetworkRequestFn: request => Object.keys(request).length === 1
            ? { ...request, name: "https://feed.cqu.moe/" } : null,
          maskAllInputs: true,
          maskTextSelector: '*',
          maskAllElementAttributes: true,
          blockSelector: [
            'iframe',
            'img',
            'canvas',
            'svg',
            'video',
            'audio',
            '[data-feed-sensitive]',
            '.feed-article-list',
            '.feed-subscription-layout',
            '.feed-account-card',
            '.feed-pdf-frame',
          ].join(', '),
          recordHeaders: false,
          recordBody: false,
        },
        before_send: event => event?.event === "$snapshot" && window.location.origin !== "https://feed.cqu.moe" ? null : sanitizeFeedEvent(event),
        person_profiles: 'identified_only',
        ip: false,
      });
      client = loadedPostHog;
      if (identityRequest) applyIdentity(client, identityRequest.userId);
      const captures = deferredCaptures;
      deferredCaptures = [];
      for (const capture of captures) client.capture(capture.event, capture.properties);
      if (replayLocation) syncReplay(client, replayLocation);
      initialization = null;
      return true;
    } catch {
      client = null;
      initializationFailed = true;
      initialization = null;
      identityRequest = null;
      replayLocation = null;
      deferredCaptures = [];
      return false;
    }
  })();
  return initialization;
}

export function syncFeedIdentity(userId: string | null): void {
  if (identityRequest?.userId !== userId) sessionReadyOperationId = null;
  identityRequest = { userId };
  if (client) applyIdentity(client, userId);
}

export function resetFeedTelemetryIdentity(): void {
  identityRequest = { userId: null };
  activeUserId = null;
  sessionReadyOperationId = null;
  if (client) client.reset();
}

export function syncFeedReplay(location: { pathname: string; search: string; hash: string }): void {
  replayLocation = location;
  if (client) syncReplay(client, location);
}

export function captureFeedEvent(event: FeedEvent, properties: Record<string, unknown>): void {
  if (!isProduction || !token || initializationFailed) return;
  const capture = { event, properties: buildFeedEvent(event, properties) };
  if (client) {
    client.capture(capture.event, capture.properties);
    return;
  }
  deferredCaptures = [...deferredCaptures.slice(-49), capture];
}

export function markFeedSessionReady(entitled: boolean, durationMs: number): void {
  if (sessionReadyOperationId) return;
  sessionReadyOperationId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  captureFeedEvent('app_session_ready', {
    trigger: 'automatic',
    operation: 'app_session',
    flow: 'app',
    stage: 'ready',
    outcome: 'success',
    operation_id: sessionReadyOperationId,
    attempt_id: attemptId,
    entitled,
    duration_ms: durationMs,
    duration_basis: 'session_request_to_confirmed_session',
  });
}
