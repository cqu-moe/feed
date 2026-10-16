# Feed / Auth browser E2E

Run from the Feed checkout with Node 22.22.3 and pnpm 11.19.0. These tests use
`e2e@0.21.0` / `@e2e-dev/web@0.15.0` for deterministic browser operations.
The existing Playwright reading/PDF regressions remain separate and unchanged.

## Prepare

Create a clean Auth checkout **inside this worktree's `.e2e/` directory** at
`d9bf0c5e6d5cc459029da6a345991b8d0f13f514`. Install its root dependencies
with its npm lockfile, and its frontend dependencies with its pnpm lockfile.
Do not symlink writable `node_modules` from another checkout: Auth's TypeScript
build stores incremental caches there. The runner rebuilds both applications.

```sh
pnpm install --frozen-lockfile
git clone --no-checkout https://github.com/cqu-moe/auth.git .e2e/auth-checkout
git -C .e2e/auth-checkout checkout --detach d9bf0c5e6d5cc459029da6a345991b8d0f13f514
npm --prefix .e2e/auth-checkout ci
pnpm --dir .e2e/auth-checkout/frontend install --frozen-lockfile
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout pnpm test:e2e
```

Every invocation builds real Feed and Auth bundles, applies all their migrations,
prepares verified `example.test` accounts using Auth signup/verification, and
runs Chromium desktop (1440×900) then phone viewport (390×844) in separate
Workers, stores, clients/callbacks, ports and browser contexts. A second invocation
is a fresh round. Feed HEAD must descend from the ticket's pinned base; the
manifest records the actual HEAD, dirty state, source digest and both bundles.
Auth must be the exact clean pinned commit. An existing output directory is an
error, protecting earlier evidence.

Only the external verification-mail provider is substituted. The browser OAuth
client is administrator-approved (`skipConsent=1`, subsystem `feed`), matching
Auth's capability-disclosure contract. The rejection case switches to a separate
unapproved client. The backend RPC client is separate and has no browser grants.
All client seed fields are independently read back before login. No internal
session or business response is fulfilled by browser routes.

The fixed historical notification/R2 bytes exercise authenticated reading and
RSS identity. They are **preloaded reading data, not evidence of discovery,
capture, OCR, Queue/Workflow execution or delivery** (FEED-03/04). Refresh faults
expire already-issued credentials in private storage; actual Auth still issues
all initial and refreshed tokens. The test reads back BFF revision and token
fingerprints to prove a refresh, without shortening product token settings.

Default outbound Worker requests are rejected except synthetic verification
mail. Browser requests outside the two current loopback origins fail the test.
Telemetry/model credentials are absent; models are not configured. Local HTTPS
uses e2e's BrowserProvider API because stock e2e 0.15 Chromium rejects the
self-signed certificate. Playwright supplies only standard isolated launch and
shutdown; the test steps and assertions stay in e2e.

## Evidence and failures

`.e2e/<run>/public/` contains redacted reports, traces, logs and cleanup receipts.
Only this directory is uploaded by CI. Raw reports/builds/runtime data are never
uploaded. e2e withholds screenshots after credential fills; any exported failure
pixels are from the public page before login. Text export redacts structured JSON
values and updates artifact size/hash metadata. Original runner evidence remains
intact. Browser CDP closure, profile removal, all three Worker/control ports and
runtime-directory removal are independently read back.

`FEED_E2E_OUTPUT` selects a **fresh** child of `.e2e/`; `FEED_E2E_VARIANT=desktop`
or `mobile` narrows local diagnostics. Other CLI arguments go to e2e (for example
`--grep 'real OAuth'`). CI passes no filters and runs both viewports twice.
Public Auth checkout in GitHub Actions uses the default read-only workflow token;
no additional cross-repository secret is required. Runtime Workers receive no cloud
or developer credentials. CI does not deploy anything.

Negative controls, each expected to exit nonzero (use distinct output paths):

- Omit `FEED_E2E_AUTH_CHECKOUT`: required dependency configuration fails.
- `--grep '__no_feed01_test__'`: no selected/executed tests fail.
- `FEED_E2E_BREAK_ASSERTION=1`: wrong visible-heading assertion fails before login.
- `FEED_E2E_FAIL_STARTUP=1`: fail after real startup and verify teardown.
- `FEED_E2E_FAIL_CLEANUP=1`: report cleanup failure after physical teardown.
- Combine startup/cleanup controls: retain both causes and return nonzero.
- `FEED_E2E_STOCK_BROWSER=1`: reproduce the stock-engine HTTPS certificate failure.

The original ticket acceptance is Chromium. The release Web gate below adds
Firefox/WebKit over the original journeys. Real devices, production Auth, live
school fetches, real email delivery and paid OCR remain separate acceptance.

## FEED-03 native ingestion

```sh
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout pnpm test:e2e:ingestion
```

This selects `ingestion.e2e.ts` instead of the preloaded reader suite. Each
viewport starts empty articles/tasks/revisions/events/derived outputs and R2,
with all migrations applied. Existing catalogue sources are disabled. The
existing administrator HTTP routes create a synthetic `school.example.test`
site, verify two columns, enable and schedule discovery, capture, backfill,
recover failed attempts, recheck versions and replay Queue handoffs. Native
Miniflare consumers start the unmodified `DiscoveryWorkflow`, `CaptureWorkflow`
and `ArchiveOcrWorkflow`; no direct handler/step calls or ready-state inserts.
Auth signup, verification, OAuth, RPC and the reader remain real.

Only Firecrawl's school/article response and TextIn's OCR response are synthetic.
The provider ledger records requests independently from product accounting.
Synthetic PDFs reuse the existing mixed-PDF fixture. This suite owns ingestion
completeness, source/pagination deduplication, task/receipt reuse, failure recovery,
history-only and presentation-only event semantics. Detailed reader/PDF controls
remain owned by FEED-02 and the existing Playwright suite.

The DLQ case uses a real R2 deletion/restoration: while OCR is held at the vendor
boundary, remove the new revision's saved snapshot; after OCR succeeds, native
readiness consumption must fail object verification and reach the native DLQ.
A separate observer consumes only that DLQ into an observation table. It never
replaces the product consumer. Local consumer `maxRetries=0` intentionally
shortens platform delivery retries; the product's minimum 60-second replay window
is still waited in real time. The admin diagnostics/replay route must recover
from the original payload after the exact snapshot bytes are restored. No D1
success or receipt state is changed by the fixture.

Recheck coverage advances only an existing article's schedule deadline, then
uses the real `/internal/rechecks` entry point. It does not claim to wait the
production seven-day cadence. A malformed TextIn response retains raw/request
receipts, blocks another paid attempt, and cannot publish its new observation.
`MAIL_ENABLED=false`; content-event assertions do not claim email delivery.

The shared runner's empty/assertion/startup/cleanup controls also apply to this
suite. `FEED_E2E_DISABLE_CONSUMERS=1` removes the local native consumers; source
verification must time out nonzero with no Workflow attempts or ready records.
CI runs reader and ingestion in separate jobs, each twice with desktop
and phone viewports. All browser isolation and evidence-export rules above
apply. `public/<variant>/ingestion.json` records independent D1/R2/provider/DLQ
readback, and `ingestion-checkpoints.json` lists completed behavior checks.
Local native emulation proves the installed runtime path; remote Cloudflare
scheduling, retry timing/concurrency, real schools/vendors and paid OCR remain
independent acceptance boundaries.

## FEED-02 reading acceptance

`reading.e2e.ts` adds real Auth/BFF/D1/R2 journeys over historical synthetic
archives. These fixtures are reading inputs; they do not prove capture, OCR,
Queue/Workflow, readiness production, or delivery. The two tests cover Chinese
search, source filtering, pagination/back, complete versus blocked revisions,
ordinary attachments, historical bodies/snapshots/screenshots, original PDFs,
actual canvas pixels, wheel scrolling, page/link navigation, zoom, downloads,
HEAD/Range/416, snapshot sanitization, retries and immediate entitlement denial.
Keyboard snapshot/history actions and both themes run in both viewport variants.
`reading-evidence.json` records observed hashes, geometry and protocol results;
`reading-failure-evidence.json` records recovery and revoked-response results.

## Complete Firefox/WebKit release gate

The fixed e2e engine was actually probed against local HTTPS: Firefox failed
with `SSL_ERROR_UNKNOWN`, WebKit with an invalid-server-certificate error.
It exposes no `ignoreHTTPSErrors`; its BrowserProvider/CDP interface requires
Chromium. Only those engines use the supported Playwright TLS context. The
original `journey.e2e.ts` (2), `reading.e2e.ts` (2), `ingestion.e2e.ts` (1),
and `mail.e2e.ts` (1) execute directly through a small operation adapter;
no weaker copied reader supplement remains. All existing business assertions
remain in their original owners. Reader adds unique-result barriers and checks
URL/visible-page/paint readiness before the next internal-link action. Native
engines use three actual wheel gestures with observed progress and the same
total distance (Firefox bounds a large event); Chromium keeps its single wheel.
Default Chromium still uses e2e and its original provider.

`FEED_E2E_SUITE=reader|ingestion|mail` selects the same original owners in both
runners. Each command runs desktop 1440×900 and phone viewport 390×844, sequentially.
For each round, run the three suites for each engine, one command at a time:

```sh
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/release-firefox-reader-round-1 FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=firefox FEED_E2E_SUITE=reader node e2e/run.mjs
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/release-firefox-ingestion-round-1 FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=firefox FEED_E2E_SUITE=ingestion node e2e/run.mjs
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/release-firefox-mail-round-1 FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=firefox FEED_E2E_SUITE=mail node e2e/run.mjs
```

Repeat with `webkit` and fresh output names, then use fresh `round-2` names
for the second independent round after review. Each full round is 24 business
attempts (6 original journeys × 2 engines × 2 viewports). A filtered run, list,
or partial supplement is never complete release coverage. No retries are enabled.
The gate compares full/selected discovery and actual IDs, the original suite
files/count, a single native attempt, engine-bound cleanup receipts and actual
window dimensions. `clearState` recreates the browser with a new disposable
profile, preserving only attempt-owned routes. All internal app/platform paths
stay real; context TLS trust is local, not a system/keychain change.

`native-discovery.json`, `native-selected-discovery.json`, original
`playwright-report.json` and per-test browser cleanup receipts bind actual IDs,
attempt UUIDs, dimensions, profile deletion and browser disconnection. The runner
retains its source digest and native bundle hashes. Public copies retain a count
of known synthetic values and text files verified after redaction. Raw original
reports stay private. Trace/screenshots/video are off for these native engines;
original download/byte, pixel and business assertions still run in the journeys.

Export copies are built in a private sibling staging directory and fully scanned
(including parsed JSON keys) before promotion. The runner stages the entire
public tree, adds redacted runtime/manifest metadata, scans it again with every
variant's known synthetic values, then promotes it once. A rejected export
discards the owned staging tree and publishes only a fixed safe failure summary;
raw originals and detailed errors stay in dot-prefixed private files. Child
stdout/stderr is retained only in `.private-child.log`, never replayed to console
or exported as `runner.log`; control reasons are checked against that private
file. Native `--list` discovery also captures both streams through explicit pipes
in `.private-native-*.stdout.log` / `.stderr.log`, including successful discovery.
Final publication journals recursively retain `AggregateError.errors`, `cause`,
stacks and filesystem details. A private journal is reserved before publication
so failure of the normal journal path can retain both the original error chain
and the journal failure. If even the reserved file cannot be written, the runner
fails with a fixed diagnostic explicitly saying retention may be incomplete.
Unknown error text is not copied into public metadata. Native platform
ERROR logs keep their original stacks/causes in mode600 `.private-platform.log`
through the runtime-owned logger, with no global console hook. Empty native
selection also rejects framework errors rather than treating collection faults
as a valid zero-test control. Publication rejection is nonzero
even when the browser itself passed; existing public destinations are rejected.

Run the existing eight mail controls once per engine with fresh exclusive roots:

```sh
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=firefox FEED_E2E_CONTROL_OUTPUT=.e2e/release-firefox-controls node e2e/mail-controls.mjs
```

Repeat for WebKit. They verify the exact assertion/oracle, zero-selection,
startup/cleanup and disabled-mail-consumer failures against actual attempts;
none count as the 24 required positive business slots. Ingestion's existing
`FEED_E2E_DISABLE_CONSUMERS=1` control must also fail at source verification.
All outputs require a fresh directory; old success is never reusable.

For the native-engine limitation probe, omit `FEED_E2E_CROSS_BROWSER`, set
`FEED_E2E_STOCK_BROWSER=1`, and select `FEED_E2E_BROWSER=firefox` or `webkit`.
Never select stock Chromium: the normal provider verifies the required basic
password-store, mock-keychain and headless flags from its actual command line.

`FEED_E2E_CORRUPT_PDF=1` appends bytes to the current PDF in actual R2 after
seeding without changing the archive descriptor. Its valid PDF still renders;
the original-download checksum must fail. Use a fresh output and
`--grep 'FEED02 real archive'`, and expect exit 1. The fixture's expected hash
remains unchanged, so this proves the file-byte check detects storage corruption.
Binary downloads stay in raw local results. Public exports omit them and prune
references, while retaining verified hashes and sanitized text artifacts. The
artifact-export tests independently verify raw preservation, secret redaction,
ID resolution, omission and recomputed size/SHA256. Run them with
`node --test tests/e2e-evidence.test.mjs`.

Each Chromium test sends its own reserved synthetic client IP to the real Auth
origin through the browser network route. This supplies the missing local edge
`CF-Connecting-IP` header used by the Cloudflare Auth adapter and keeps rate limits enabled; the combined FEED-01/02 suite must
not share the no-trusted-IP login bucket. Internal responses remain untouched.

## FEED-04 native mail

```sh
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout pnpm test:e2e:mail
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout node e2e/mail-controls.mjs
```

The mail suite starts with empty articles, events, mail/delivery/receipt tables
and R2. Real source verification and Discovery/Capture Workflows produce ready
revisions. Real OAuth and subscription UI/API commands create two overlapping
subscriptions. Native event/matching and mail Queues execute the built product;
there is no separate MailWorkflow in the product architecture. Administrator
HTTP recovery dispatches committed outbox work. The fixture never inserts ready,
message, delivery, receipt, acceptance or completion facts into product storage.

Only the external school/Firecrawl responses and Resend boundary are synthetic.
The mail provider ledger accepts only synthetic credentials, sender and
`example.test` recipients, and enforces stable key/payload identity. Auth's
verification email is separate from Feed's delivery ledger. Callbacks use HMAC
Svix envelopes sent to the product `/webhooks/resend` route. Bad/stale signatures,
wrong recipients, exact replays and late receipts exercise its real verifier and
state transitions. A provider-accepted request with an interrupted response body
must remain unknown; a signed identity and provider lookup recover it without
inventing a completed message. An in-window retry reuses the original key and
bytes. Outside the safe window, recovery leaves manual reconciliation pending.

A test-only entry module forwards the compiled product exports and handlers.
It advances **Feed `Date.now()`** for digest cutoffs and application retry
windows, and can delay a native mail batch before forwarding it unchanged.
It does not replace Queue consumers, Workflows, Auth RPC, mail assessment,
rendering, storage or receipt application. Auth and platform timers retain real
time. Explicit clock readbacks are exported; this does not prove remote Cron
scheduling or the passage of a real day. The shared synthetic school's publication dates
use its declared Asia/Shanghai calendar day, including the UTC midnight boundary.

Before first submission the suite changes actual Auth entitlement/recipient
facts and subscription settings, then releases the held native batch. It checks
access, running quota, verification, address, pause and RPC credential failure.
A separate outage binds the real Auth bundle without its database and reads back
preserved backlog with no mail request. Daily digests, 429 recovery, unknown
submission, callback-before-response and bounce suppression have independent
D1/R2, provider-ledger and admin readbacks. Initial email revision links are read
through the authenticated reader after later revisions exist.

`public/<variant>/mail.json` contains sanitized ledger and D1/R2 snapshot hashes;
`mail-checkpoints.json` records business checks. Both desktop and phone viewports
run in each fresh round, twice in CI. The control runner requires the intended
failure and physical cleanup for missing config, zero tests, a wrong delivered
oracle, a disabled **mail-only** native consumer, a wrong heading, startup,
cleanup, and combined startup/cleanup. It checks that the disabled mail consumer
still leaves real ready events and prepared messages with zero provider calls.
Only per-control `public/` directories and the bounded `controls.json` summary
are suitable for sharing. Real Resend sending/billing, mailbox receipt or reading,
remote Cloudflare resources, and production rollout remain unverified.

### CI release entry

The existing manual CI workflow runs all three suites in Chromium, Firefox and WebKit, each in two fresh jobs. PR/push checks retain Chromium. Each browser has separate business and negative-control artifact names; only the runner-verified public directory is uploaded. Trigger the manual workflow on the reviewed PR branch to run the 48 Firefox/WebKit business attempts before release.
