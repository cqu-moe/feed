# Feed telemetry v2 contract

This document describes source behavior. A token placeholder or SDK dependency in Git does not mean collection is enabled in production.

## Principles

- Web events represent an authenticated user's observed reading or subscription operation. The server remains authoritative for subscription and delivery outcomes.
- Worker events are system events. They use one distinct ID per logical system object/window, disable person profile processing, and never create a shared `system` person.
- Every manual event passes an event-specific allowlist. Unknown keys and unsafe values are dropped. Search text, titles, bodies, recipient addresses, URLs, RSS tokens, cookies, raw exceptions, and business-object dumps are not allowed.
- Telemetry is optional and best effort. Missing configuration, network failure, proxy failure, or shutdown timeout cannot change a business result.
- Development and test default to no outbound event. Only production sends normal events. Explicit acceptance capture is required for a non-production Worker event and is marked `is_test:true`.

## Common fields

All events carry:

| Field | Values / type |
| --- | --- |
| `telemetry_version` | `2` |
| `product` | `feed` |
| `surface` | Web: `web`; Worker: `worker` |
| `environment` | `production` / `development` / `test` |
| `release` | Actual build/deployment identifier; `unconfigured` only means it was not injected |
| `actor_type` | Web: `user`; Worker: `system` |
| `trigger` | `user` / `automatic` / `scheduled` / `recovery` |
| `operation` / `flow` / `stage` | Limited per-event enums below |
| `outcome` | `success` / `failure` / `partial` / `canceled` / `needs_input` / `unverified` |
| `duration_ms` | Non-negative integer milliseconds where applicable |
| `duration_basis` | Limited enum below |
| `operation_id` | Stable logical operation/task ID |
| `attempt_id` | Stable identifier for one delivery/HTTP/recovery attempt |
| `is_test` | Boolean; normal production events omit it |

Optional `error_code` and `warning_code` use bounded machine codes. Web failures use `network_failed` or `http_<status>`.

Feed has no start/end event pair in this version. A terminal event may follow several silent HTTP or queue retries; those retries reuse `operation_id` and receive a different `attempt_id`. A retry is therefore not a new logical task.

## Web events

Web production initializes only when `VITE_POSTHOG_PROJECT_TOKEN` is present. The client uses `VITE_POSTHOG_HOST` (default `https://p.cqu.moe`), disables pageview/pageleave/autocapture/exceptions/heatmaps/performance/surveys/tours/flags, disables IP capture, and sets `person_profiles: 'identified_only'`.

### `app_session_ready`

Emitted at most once per browser app session after `/api/session` confirms an authenticated session. It does not replace or imply a new Auth login.

- `trigger`: `automatic`; `operation`: `app_session`; `flow`: `app`; `stage`: `ready`; `outcome`: `success`.
- `operation_id` / `attempt_id`: two independent random UUIDs for this one confirmation.
- `entitled`: boolean Feed access result.
- `duration_ms`: `/api/session` request start to confirmed authenticated session.
- `duration_basis`: `session_request_to_confirmed_session`.
- Logout resets telemetry identity and this one-shot guard. A later login in the same browser session can confirm a new app session.

### `feed_search_completed`

Emitted when an explicit search, source-filter change, pagination, clear, same-query search resubmit, or retry of that request produces a list result. Initial background list loading is not counted as a user search.

- `trigger`: `user`; `operation`: `search_filter`; `flow`: `reading`; `stage`: `result`.
- `outcome`: `success` or `failure`.
- `operation_id`: random UUID created at the explicit user action; retries reuse it.
- `attempt_id`: random UUID per HTTP attempt; user-initiated same-query resubmit creates a new logical operation and UUID.
- Success only: `result_count`, `zero_results`, `page`.
- `has_query`, `has_source_filter`: booleans; query/source values are never sent.
- Failure only: bounded `error_code`.
- `duration_ms`: explicit action (or first attempt) to authoritative list response.
- `duration_basis`: `user_action_to_search_result`.

### `feed_item_opened`

Emitted only when readable content actually opens: a ready article response is received, or a top-level protected PDF reader successfully loads a document. It is not a link click, download intent, or proof that the user understood the content. Embedded article PDF preview does not emit a second article-open event.

- `trigger`: `user`; `operation`: `article_read` or `pdf_read`; `flow`: `reading`; `stage`: `opened`; `outcome`: `success`.
- `operation_id`: random UUID for the logical content-open request; an article-detail retry reuses it.
- `attempt_id`: random UUID for the observed successful request/load attempt.
- `article_id`: internal article ID.
- `revision_id`: internal ready revision ID, or null when the API response has no revision object.
- `content_kind`: `article` or `pdf`.
- `ocr_used`: boolean derived from a non-empty OCR page list; it does not describe PDF attachments.
- `revision_state`: `ready` for this event; the schema also permits `assembling` and `blocked` for future explicit terminal use.
- `duration_ms`: content request/read start to readable response or PDF load.
- `duration_basis`: `content_request_to_readable_response`.

### `feed_subscription_finished`

The browser emits this only after the authoritative subscription API returns. The operation is not emitted at button click.

- `trigger`: `user`; `operation`: `create`, `update`, `delete`, `restore`, `rss_rotate`, or `rss_revoke`; `flow`: `subscription`; `stage`: `finished`.
- `outcome`: `success` or `failure`.
- `operation_id`: the server idempotency `requestId`. Replaying or retrying the same request keeps this ID.
- `attempt_id`: random UUID for each HTTP attempt.
- Success only: internal `subscription_id` and `no_op` (`true` for an idempotent replay that changed nothing).
- Failure only: bounded `error_code`, plus `subscription_id` when an existing subscription was targeted.
- `duration_ms`: current HTTP attempt start to authoritative response; retries keep the logical ID but have separate timing.
- `duration_basis`: `subscription_attempt_request_to_authoritative_response`.

## Worker events

Worker telemetry uses a short-lived `posthog-node/edge` client, flushes through `waitUntil`, has a two-second request timeout and one retry, and disables exception autocapture. Normal Worker events carry `$process_person_profile:false`.

### `feed_revision_ready`

Emitted only after the D1 batch that authoritatively commits a ready revision, readable projection, content event, source evidence, and ready outbox. An already-ready replay emits nothing.

- `trigger`: `automatic`; `operation`: `archive_revision`; `flow`: `collection`; `stage`: `ready`; `outcome`: `success`.
- `operation_id`: `revision_id`.
- `attempt_id`: `<capture_task_id>:ready`, a deterministic identifier for this first authoritative readiness commit. Queue replays of the same ready revision do not receive another event.
- `revision_id`, `event_id` (or null), `capture_intent` (`live` / `backfill` / `migrated` / `recheck` / `unknown`), `history_only`, `event_created`.
- `source_count`, `requirement_count`.
- `end_to_end_duration_ms`: source observation timestamp to authoritative ready commit.
- `duration_basis`: `observed_to_ready_commit`.

### `feed_delivery_finalized`

Emitted only after the authoritative mail ledger commit changes a message's material delivery state. Provider acceptance is not verified delivery.

- `trigger`: `automatic`; `operation`: `mail_delivery`; `flow`: `notification`.
- `stage`: `preflight`, `retry`, `provider_submission`, or `provider_receipt`.
- `operation_id` / `message_id`: stable mail message ID.
- `attempt_id`: `<message_id>:<attempt_count>`. A provider receipt uses the attempt count of the submission it reconciles and is not a new logical mail task.
- `owner_sub`: authenticated internal central user ID, included as an attribute only; the event still disables person processing.
- `message_kind`: `immediate` or `daily_digest`.
- `delivery_count`, `event_count`, `attempt_count`.
- `state` and outcome mapping:
  - `accepted` → `outcome:unverified`, `provider_submission:true`, `delivered:false`
  - `delivered` → `outcome:success`, `provider_submission:true`, `delivered:true`
  - `bounced`, `complained`, `rejected` → `outcome:failure`
  - `cancelled` → `outcome:canceled`
  - `submission_unknown` → `outcome:unverified`
  - `deferred` at exhausted automatic recovery → `outcome:partial`
- Ordinary provider deferral or Auth outage remains pending/deferred and emits no final event until a listed state is authoritative.
- `end_to_end_duration_ms`: message creation to authoritative state observation.
- `duration_basis`: `message_created_to_final_state`.

The same message may legitimately produce an `accepted` event and later a `delivered`, `bounced`, or `complained` event. Deduplicate the logical message by `operation_id`; analyze delivery success only from `state='delivered'`, never from accepted alone.

### `feed_pipeline_summary`

Every five minutes, the scheduled Worker reads the authoritative D1 task ledger for the previous fixed five-minute window and emits at most one summary per pipeline kind. A kind with no terminal task in the window emits nothing.

- `trigger`: `scheduled`; `operation`: `pipeline_summary`; `flow`: `pipeline`; `stage`: `summary`.
- `summary_kind`: `collection` (task kinds `discover`, `capture`, `recheck`, `backfill`) or `ocr`.
- `operation_id` and `attempt_id`: `pipeline:<summary_kind>:<window_start_epoch_ms>`. The deterministic window ID prevents retries/recomputations becoming new logical summaries.
- `window_start_epoch_ms`, `window_end_epoch_ms`: fixed half-open-before/end-inclusive ledger window.
- `success_count`, `failure_count`, `blocked_count`, `canceled_count`, `active_count`, `task_count`.
- `outcome`: `success` when terminal work succeeded and nothing failed/blocked; `partial` when both succeeded and failed/blocked work exists; `failure` when none succeeded and failed/blocked work exists; `canceled` when only cancellations occurred.
- `warning_code:blocked_tasks_present` when blocked work exists.
- `duration_ms`: `300000`; `duration_basis`: `task_ledger_observation_window`.

Counts are logical tasks from the task ledger, not workflow attempts or queue dispatches. `active_count` separates queued/starting/running/deferred work and must not be added to terminal success/failure rates. A task is counted in the window where its authoritative terminal state is observed.

## Identity, replay, and privacy

After `/api/session` confirms authentication, Web identifies only with the authenticated central `user.id` string. Logout and A→B account switching call `reset()` before identifying the new ID. Name, email, student ID, source credentials, and cookies are not telemetry identity.

Session Replay is manually gated. Recording can run only on `/` or `/subscriptions` with empty hash and either empty search or only the explicit `telemetry_test=1` acceptance marker. Route changes stop recording before paint; `$snapshot` events are also dropped unless the current gated location still qualifies. All inputs and text are masked, element attributes are masked, media/canvas/iframe/article lists/subscription layout/account and PDF regions are blocked, and network headers/body recording is disabled. Autocapture, pageview, pageleave, exceptions, heatmaps, performance, surveys, tours, and flags remain disabled.

No Feed event includes a search term, title, body, recipient, URL, RSS token, cookie, raw exception, or full business object. Recipients remain only in the private mail snapshot/recipient hash paths used by the existing business flow.

## Deployment configuration

Web build placeholders are in `.env.example`:

```text
VITE_POSTHOG_PROJECT_TOKEN=
VITE_POSTHOG_HOST=https://p.cqu.moe
VITE_RELEASE=
VITE_POSTHOG_TEST=false
```

Worker public configuration in `wrangler.jsonc` contains only `POSTHOG_HOST` and `ENVIRONMENT`. Set `POSTHOG_PROJECT_TOKEN` as a Workers secret ; Worker releases use the Cloudflare version metadata binding, with optional `RELEASE` override. For explicitly approved non-production acceptance only, also set `POSTHOG_TEST_CAPTURE=true`; ordinary development/test must not set it.

The SPA CSP allows `https://p.cqu.moe` for PostHog script/connect origins. The reader page retains its existing PDF wasm exception and does not gain broader worker permissions.

Local tests and builds do not call PostHog. Production receipt, proxy behavior, replay rendering, real account switching, and real mail delivery require separate parent-owned deployment and business acceptance.
