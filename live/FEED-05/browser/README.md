# FEED-05 isolated browser acceptance

Preparation only. Nothing here deploys, creates OAuth clients, grants entitlements, seeds sessions, or runs a cloud command. The offline check does not prove a business outcome.

Run from this `live/feed` checkout:

```sh
node live/FEED-05/browser/run.mjs --check
```

This runs nine local safety tests, TypeScript, actual testerarmy discovery (exactly one case), and a real zero-selection run (exit 2, exact collection `NO_TESTS`, zero selected/executed/results). Secret providers and the browser provider refuse offline access. It does not read the real accounts file or launch a browser.

## Parent prerequisites before execution

- Review these files. The launcher requires deployed Feed source `a7316fbb8d383a7e2853d9464170dda32b218c92` to be a Git ancestor, then verifies that every actual product path is unchanged from that base and records the working-file hashes. Harness-only future commits are allowed; product changes and tracked/untracked/ignored files under product paths are not. Install compatible existing-lock dependencies and the matching Playwright Chromium binary separately; the launcher never downloads a browser.
- Deploy and independently read back the isolated Feed/Auth origins below. The parent reports 17 migrations and dedicated D1/R2/six queues exist; this preparation has not remotely verified them. Validate the existing generated isolated config; keep crawling, task runtime, source management, OCR and mail disabled, without schedules or paid-provider bindings. The launcher validates local config shape, not the deployed Worker.
- Complete the real Auth OAuth client/resource/callback registration, service binding/secret setup, Feed access and subscription quota for both task accounts. If consent is required, approve it through the separately reviewed Auth setup; this case expects the existing approved-client login journey. Unexpected consent/MFA/captcha is a failure, never bypassed.
- Copy the authorized account input only when the parent has approved execution (values never enter Git):

  ```sh
  mkdir -m 0700 -p live/FEED-05/private
  install -m 0600 /Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/live/auth/.e2e/live/private/accounts.json \
    live/FEED-05/private/accounts.json
  ```

  The local file must be a regular, nonsymlink file owned by the executing user, mode 0600. Exactly one `intendedRole: owner` and one `other` with distinct emails are required; admin is ignored. No credentials go in argv, environment, configuration, or public reports. This file is opened lazily only while executing a real credential fill.
- Each account list may contain only zero-usage soft-deleted tombstones with email off and RSS revoked. The run records the exact owner and other before rows, requires their fingerprints to remain unchanged, permits no other-account rows, and preserves every existing tombstone. Do not delete or alter historical resources to meet this prerequisite; an active subscription or unknown concurrent row fails the run.
- Reserve this case exclusively; no concurrent subscription/account changes. Use a host permitted to reach these two isolated origins and open the local Chromium CDP listener. Request only that precise network/listener permission when required.

The only allowed remote origins are:

- `https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev`
- `https://cqu-e2e-20261016-auth.user-unauthorized.workers.dev`

After parent review/setup, the explicit execution command is:

```sh
node live/FEED-05/browser/run.mjs --run
```

**That command has not been executed during preparation.** Arbitrary flags/origin overrides are refused. One serial case, no framework retries, no mutation retries. Bounded polling only reads subscription state after a single write; HTTP/config failures remain failures. Browser navigation/requests outside the two origins are blocked and counted as failures. No school or mail journey is included.

## Actual planned business coverage

Real owner OAuth UI email/password login; create with email explicitly off and a unique round name; edit and reload readback; pause/resume; empty RSS XML read; rotate (old URL 404, new URL 200); revoke (old URL 404, owner readback null); real Feed/Auth signout and other login; owner-resource GET/DELETE denied 404; owner login and unchanged-state readback; soft-delete; UI restore and fresh RSS read; finally soft-delete only the owned round ID and read back active usage zero, RSS null and tombstone; Feed/Auth signout with authenticated API/session readback.

RSS is a bearer credential. Cross-account isolation is checked on subscription APIs, not by pretending an RSS holder must authenticate. No articles, ready state, sessions or entitlements are fabricated. Empty-archive article reading, ingestion, delivery, school login, paid providers, Firefox/WebKit and deployment acceptance are outside this case.

## Evidence and recovery

Each execution creates an exclusive `.e2e/live/feed05-browser/<time>-<random>/` with mode 0700, a disposable private profile and private HOME. Trace/video are disabled. Artifacts (including any framework failure screenshots), raw runner output, accounts, URLs and request snapshots must stay private. Output files are mode 0600; browser release checks context exit, CDP refusal and profile absence. Do not publish raw runner logs, `report.json`, `intent.jsonl`, screenshots or RSS links.

Only `shareable-summary.json` is designed for public handoff: fixed origins/source, command exit, whitelisted step names and pass/cleanup booleans/counts. It contains no account values, subscription IDs, RSS URLs or raw errors. Passing requires exactly one passed attempt with complete cleanup and no secondary errors, successful resource/session cleanup, and successful private-browser release. Exit 0 alone is insufficient.

Failure records retain recursive causes, aggregate members, stacks and filesystem details privately before the framework serializes errors. A write/fsync failure and a subsequent close failure are both retained. If the intent journal fails, an exclusive 0600 failure file records the original and logging failures; if all private storage fails, all causes remain in the thrown error and its message, captured by the launcher privately (durable storage cannot then be claimed).

The private fsynced intent journal records the exact observed baseline rows before the first mutation and dispatch intent before forwarding each write. Unique-name reconciliation handles an unknown create response only against this round while requiring the recorded baseline fingerprints to remain unchanged. Cleanup refuses unrelated rows, changed baseline rows, changed names, email-enabled resources or ambiguous ownership, preserves primary and cleanup failures together, and attempts both service signouts. Never retry a failed round simply to obtain green. Inspect private intent/evidence first; an interrupted process or unreachable service may require parent recovery using only the journaled round ID, current version and real owner APIs. Do not hard-delete D1 rows, wipe caches, alter historical resources or forge a session.

Cleanup soft-deletes only a row uniquely named for this run, requires every exact baseline row to remain unchanged, restores active usage to zero, and requires the new row to be an explicit email-off/RSS-revoked tombstone. A failed or interrupted signout/cleanup remains an acceptance failure even when the browser was closed. Discovery, local config validation and these safety checks are not remote acceptance.
