# FEED-05 isolated live preparation

This worktree prepares isolated FEED-05 delivery against deployed Feed source `a7316fbb8d383a7e2853d9464170dda32b218c92`. The parent has already created the dedicated D1/R2/queues, applied migrations, completed Auth setup, and reviewed one prior subscription/access round. This delivery makes the nonsecret harness portable while preserving those prior resources; it executes no live mutation here. Evidence and failures are recorded under the workspace `docs/e2e/results/`; no production resources are used.

## Required fixed identities

- Cloudflare account: `a666c560407022706a52a703923548d5`
- Worker: `cqu-e2e-20261016-feed`
- Expected Feed origin: `https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev`
- Real isolated Auth origin: `https://cqu-e2e-20261016-auth.user-unauthorized.workers.dev`
- D1: `cqu-e2e-20261016-feed-db`, actual UUID required from parent readback
- R2: `cqu-e2e-20261016-feed-archive`
- Queues: `cqu-e2e-20261016-feed-jobs`, `-jobs-dlq`, `-events`, `-events-dlq`, `-mail`, and `-mail-dlq`
- Workflows: `cqu-e2e-20261016-feed-ingest`, `-pdf-ocr`, `-capture`, `-discovery`, and `-archive-ocr`

The generator requires the exact account and origins. It accepts only a UUID-shaped actual D1 ID and rejects production names, IDs, origins, routes/custom domains, Cron, the AI binding, vendor-on switches, secret values in vars, and `0` paid-provider caps. The code treats `budgetLimit("0")` as uncapped accounting, not disabled accounting.

Generated files are ignored under `generated/`. The actual isolated config uses D1 `2439e37f-6b2a-46ad-a83e-a3c7da6d6d11`. The reviewed current business state may contain legitimate prior soft-deleted tombstones; no run may reset or delete them to recreate an empty baseline.

## Parent-only resource and identity setup

1. Create/read back only the dedicated resources above in the E2E account. Do not reuse or rename production or T17 resources. Record the D1 UUID and empty-resource readbacks; R2, queues, and Workflows have no separate UUID to put in this config.
2. Build the config only after actual D1 readback. The command shape is:

   ```sh
   node live/FEED-05/generate-config.mjs \
     --account-id a666c560407022706a52a703923548d5 \
     --d1-database-id <actual-D1-UUID> \
     --feed-origin https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev \
     --auth-origin https://cqu-e2e-20261016-auth.user-unauthorized.workers.dev
   ```

   Supply `--browser-client-id` and `--rpc-client-id` only after actual isolated Auth client readback if a parent-owned ignored deployment manifest is also wanted. Never supply secret values.
3. In the isolated Auth environment only, register a confidential browser OAuth client:
   - callback exactly `https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev/auth/callback`
   - web/confidential Basic authentication, required PKCE, authorization-code and refresh grants
   - scopes exactly `openid profile offline_access`
   - `skip_consent=true` only as the approved first-party Feed setting
   - `metadata.subsystem="feed"`, with no RPC methods.
4. Register a separate confidential RPC client with `metadata.subsystem="feed"` and exactly `metadata.rpcMethods=["getFeedPolicy","getFeedRecipient"]`. The current Auth validator requires a redirect even when grants are empty: the actual client retains the exact isolated Feed callback, authorization-code/code, openid, forced PKCE and `skip_consent=false`. Auth RPC independently checks the hashed client secret, enabled status, subsystem and method allowlist. This compatibility concession is recorded in `AUTH-06-admin-execution.md`; it does not give the RPC client browser skip-consent.
5. Three dedicated accounts registered and verified through real email. The exact dedicated admin was promoted through guarded one-row bootstrap, then enrolled real TOTP and used public strong-authenticated APIs. Both ordinary readers now have only `feed.access="1"` and `feed.sub_limit="3"`; initial states and rollback are journaled. No email verification, session, factor, OAuth grant or business result was seeded.
6. Configure only these Worker secret names after clients and a reviewed encryption key exist: `FEED_AUTH_CLIENT_ID`, `FEED_AUTH_CLIENT_SECRET`, `FEED_SESSION_ENCRYPTION_KEY`, `FEED_AUTH_RPC_CLIENT_ID`, `FEED_AUTH_RPC_CLIENT_SECRET`. Add `ADMIN_TOKEN` only if the reversible internal administration path will actually be exercised. Secret values stay parent-owned and ignored.

## Default runtime boundary

The generated config leaves `CRAWL_ENABLED`, `TASK_RUNTIME_ENABLED`, `MAIL_ENABLED`, `PDF_OCR_ENABLED`, and `SOURCE_MANAGEMENT_ENABLED` false, omits Cron, omits AI, and provides no PostHog token, mail sender, or vendor key. Ordinary archive reads and version behavior remain enabled. Real OAuth login plus `feed.access`/`feed.sub_limit` can exercise reversible subscription create/edit/RSS rotation/revoke/read-back without a vendor call.

No default source/vendor hostname is called. If parent separately authorizes real public source reads, the fixed-source whitelist is only:

- `https://jwc.cqu.edu.cn`
- `https://intex.cqu.edu.cn`
- `https://civil.cqu.edu.cn`
- `https://xgb.cqu.edu.cn`
- `https://news.cqu.edu.cn`

Current source reads use `https://api.firecrawl.dev/v2/scrape`, so enabling `CRAWL_ENABLED`/`TASK_RUNTIME_ENABLED`, attaching `FIRECRAWL_API_KEY`, and permitting those origins require a separate explicit parent authorization. OCR/mail/AI remain unauthorized and must stay off.

## Parent validation and deployment sequence

1. Run the targeted generator tests from the repository root:

   ```sh
   node --test live/FEED-05/generate-config.test.mjs
   ```

2. Build the unchanged application with empty browser telemetry environment values:

   ```sh
   VITE_POSTHOG_PROJECT_TOKEN= VITE_POSTHOG_HOST= \
     ./node_modules/.bin/tsc --noEmit
   VITE_POSTHOG_PROJECT_TOKEN= VITE_POSTHOG_HOST= \
     ./node_modules/.bin/vite build
   node scripts/copy-pdf-assets.mjs
   ```

3. Generate the actual config, then perform a local dry run only against that ignored config. Keep Wrangler logs inside this worktree and use the project-local Wrangler 4.149.0:

   ```sh
   WRANGLER_SEND_METRICS=false \
   WRANGLER_LOG_PATH=live/FEED-05/generated/wrangler-dry-run.log \
   ./node_modules/.bin/wrangler deploy --dry-run --strict \
     --config live/FEED-05/generated/wrangler.json \
     --outdir live/FEED-05/generated/dry-run
   ```

4. Apply all existing D1 migrations to `cqu-e2e-20261016-feed-db`, configure the reviewed secret names, and deploy only after resource/client/entitlement readbacks match this plan. A dry run proves packaging and config shape, not runtime behavior or resource existence.
5. Validate login, subscription lifecycle, RSS rotation/rejection, reading, and revocation through the real deployed origins. Record pre-state and restore/remove test objects; do not claim mail, OCR, AI, paid source reads, school OAuth, or Learning acceptance while disabled/unauthorized.

## Recovery and cleanup

Export only dedicated-account evidence without secret values. Sign out/remove test sessions and subscriptions through real paths where possible, preserve before/after D1/R2 readbacks, then delete the Worker, Workflow state, queues and DLQs, R2 bucket, and D1 database only after parent confirms no retry/recovery need. Revoke only the dedicated OAuth/RPC clients and secrets. Production `cqu-feed`, `cqu-moe-auth`, their domains, D1/R2/queues, history T17 resources, and all production secrets must remain untouched.

## Delivery v2 offline regressions

Run separately from either live command, from this checkout with no live run in progress:

```sh
node --test --test-concurrency=1 live/FEED-05/controls/regressions.test.mjs
node live/FEED-05/browser/run.mjs --check
node live/FEED-05/access/run.mjs --check
```

The regression command exclusively creates and removes a synthetic ignored generated config (it refuses an existing generated directory). It invokes both real launchers under network/process/private-input denial and a browser dependency sentinel, never starting a browser. It temporarily mutates each real `.design` file dependency, restores the exact bytes in `finally`, and checks an ignored extra file and the actual hash inventory. Do not run this command concurrently with a build or another guard check. Synthetic subscription, access and provider fault controls run the actual callers with external browser/framework boundaries replaced, write real private files, and inject real file-descriptor write/fsync/close failures. They verify recursive private evidence and independent fallback recording. These offline controls are separate from the PR required gate and do not count as live rounds.

Both live launchers now reject nonempty isolation-validation errors before resolving Playwright. The product baseline includes the `.design` dependency tarballs. V1 source/evidence/review snapshots remain preserved in ignored `.offline/frozen-v1/`; new delivery evidence is under `.offline/v2/` and separately named root v2 reports.
