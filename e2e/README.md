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
