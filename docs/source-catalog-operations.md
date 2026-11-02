# Source Catalog Operations

The source catalog is provisioned from `worker/source-catalog.json`. The default command is a local dry run; it reads the catalog only and does not use credentials or the network.

```sh
node scripts/provision-sources.mjs
FEED_URL=https://feed.cqu.moe node scripts/provision-sources.mjs \
  --apply --credentials-file /absolute/path/to/production-secrets.json \
  --timeout-minutes 120
```

The credentials file is the existing JSON shape `{ "ADMIN_TOKEN": "..." }`; `FEED_ADMIN_TOKEN` may be used instead. Apply fetches sites and sources first, creates an absent site with `requestId: catalog-v1-<site-key>`, and creates absent columns as disabled drafts. Site reuse is by origin and source reuse is by list URL. Each column keeps its configured refresh interval, uses `Asia/Shanghai`, and uses the standard article pattern. Sites are processed sequentially and one validation is submitted at a time. Progress is written immediately to stderr; the JSON summary is written once to stdout.

A source is enabled only after the server reports `verified`. A running validation task is polled and resumed instead of submitted again. A failed validation is not retried unless `--retry-failed` is explicitly supplied. Failed entries are recorded, unrelated sources continue, and the command exits nonzero. HTTP 402 or an upstream quota/balance error stops the run.

The November 2026 catalog uses weekly checks (`604800` seconds). Existing catalog columns with a different name, interval, timezone, article pattern, or sample URL are paused, updated, and verified again before enablement. Verification waits for both the source and its task to succeed, with a ten-minute limit per column and the overall command deadline. Re-running resumes active validation tasks; `--retry-failed` permits one new attempt for a previously failed column.

`--restore-existing` additionally handles exactly `civil`, `intex`, `news`, and `xgb`. The first three are re-enabled only when already verified. For `xgb`, the command pauses it if enabled, patches only `sampleArticleUrl` when the catalog value differs, re-verifies with the existing article pattern, and enables it only after success. The command never changes subscriptions, mail, backfill, or manual scheduling.
