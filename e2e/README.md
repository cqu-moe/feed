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

Firefox/WebKit, real devices, production Auth, live school fetches, email delivery
and paid OCR are outside this ticket's local Chromium acceptance.

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

The fixed e2e engine was actually probed against local HTTPS: Firefox failed
with `SSL_ERROR_UNKNOWN`, WebKit with an invalid-server-certificate error.
It exposes no `ignoreHTTPSErrors`; its BrowserProvider/CDP interface requires
Chromium. Supplement only those engines with Playwright's supported isolated
persistent context and `ignoreHTTPSErrors: true`, using the same runner and
real services. No system trust/keychain change is needed. These supplemental
journeys cover both desktop and phone viewports, with disposable profiles and
explicit close/removal receipts. They do not replace the Chromium e2e tests.

```sh
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/reading-round-1 pnpm test:e2e
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/reading-round-2 pnpm test:e2e
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/reading-firefox FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=firefox pnpm test:e2e
FEED_E2E_AUTH_CHECKOUT=.e2e/auth-checkout FEED_E2E_OUTPUT=.e2e/reading-webkit FEED_E2E_CROSS_BROWSER=1 FEED_E2E_BROWSER=webkit pnpm test:e2e
```

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
