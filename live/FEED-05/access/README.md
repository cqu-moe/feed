# FEED-05 owner access revocation preparation

This is a separate single testerarmy case. The accepted subscription case and Auth admin tool stay unchanged. Preparation has not executed a cloud request, browser login, entitlement mutation or deployment.

The parent clarified that the reversible-write authorization includes restoring the **complete original semantic set** through Auth's existing full-set PUT. Admission is limited to exactly `feed.access=1` and `feed.sub_limit=3`. Only access is revoked; quota must remain the sole unchanged row. Immediately before PUT, re-read the complete set and require exactly that expected revoked semantic set; then submit exactly the original normalized `before.items`. Unknown grants, missing/changed quota or concurrent additions refuse PUT and retain the primary/restore errors. No baseline is modified to fit the test. The API rebuilds `updatedAt` for both rows; keep the original full raw snapshot and record this as semantic restoration, never byte-for-byte rollback.

From the live Feed checkout, the local-only check is:

```sh
node live/FEED-05/access/run.mjs --check
```

It runs seven boundary/failure tests, TypeScript, real framework discovery of exactly one test, and an exact collection-phase NO_TESTS/exit2 zero-selection control. Every local child preloads an HTTP/fetch/socket deny guard. No credential provider or real browser may run offline. Outputs are private, ignored `access/.offline/` files. These controls are harness proof, not live entitlement proof.

The separate runtime entry, **not run in preparation; parent review remains required**, is:

```sh
node live/FEED-05/access/run.mjs --run
```

No origin/identity/filter override is accepted. Execution requires Feed source a7316fbb8d383a7e2853d9464170dda32b218c92 ancestry and unchanged actual product paths; the reviewed Auth execution used 3c603a83db5564b6f8d02110082405ffad294c40, which remains a parent-review fact rather than a local Auth source dependency. Product source, dependencies and the existing safe browser provider are reused; account and admin material come only from task-local ignored inputs. Execution validates the existing isolated generated config and uses only the exact existing Feed/Auth origins. The provider enforces headless/basic/mock isolation and private profile/CDP cleanup. Telemetry is disabled, with other origins refused. There is no subscription write path.

## Inputs and actual contracts

- Owner email/password: task-local ignored `live/FEED-05/private/accounts.json`, selected by `intendedRole: owner` through the accepted account helper; owner identity is checked through real OAuth UI and Auth get-session, not guessed from array position.
- Dedicated admin: task-local ignored `live/FEED-05/private/access-admin.json` with `adminUserId`, `adminEmail`, `adminPassword`, and `readerUserIds`. The UI-proven owner must be in that reader set and must not be the admin.
- Existing TOTP: task-local ignored `live/FEED-05/private/auth-admin-totp.json`, `totpURI`. The standalone local `totp.mjs` implements the same RFC 6238 SHA-1 contract and is guarded by public reference vectors; no Auth bootstrap source or secret file enters Git. No factor enrollment, disable, role change, OAuth client edit, grant of another capability, mail or paid API exists in the allowlist. Files must be regular nonsymlinks, owned by the executing user, mode0600, and are opened lazily in execute mode only.
- Admin login: POST `/api/v1/auth/sign-in/email`, require the actual two-factor redirect, then POST `/api/v1/auth/two-factor/verify-totp`; GET `/api/v1/auth/get-session` must match the dedicated superAdmin with existing TOTP. Strong proof: POST `/api/v1/auth/security/challenge` `{password,purpose:"admin"}`, POST `/api/v1/auth/security/complete` `{challenge,method:"totp",code}`, GET `/api/v1/auth/security/status?purpose=admin` requires `strong && verified`.
- Baseline: GET `/api/v1/admin/users/:id/entitlements` returns `{data:[{userId,subsystem,capability,value,updatedAt}]}`. Capture the complete raw set privately. The existing access row must have value `"1"`. Exact two-row restore admissibility is checked before any revoke.
- Scoped revoke: the exact DELETE above returns204. Re-read the full set and require only the original `feed.sub_limit=3` row. Re-read again immediately before PUT. The full-set PUT body is exactly `{items:[{subsystem:"feed",capability:"access",value:"1"},{subsystem:"feed",capability:"sub_limit",value:"3"}]}` from the captured before set. Full semantic readback must match the original. `updatedAt` may be rebuilt for both rows; all raw before/after timestamps remain in the private journal. Any changed concurrent semantic row aborts PUT.
- The protected reading endpoint is verified in `worker/api.mjs`: `/api/articles` must be200 before the revoke. Denial must be permission-specific: Feed session remains authenticated but `entitled:false`; GET `/api/articles` returns403 with the actual access-required error, and a fresh UI request shows the access-denied heading. GET `/api/subscriptions` intentionally remains an authenticated management read, so it is not falsely required to return403.
- Recovery requires the same owner session entitled again, articles200, visible subscriptions UI and exact subscription-array/usage equality with baseline. Existing tombstones are accepted and retained; the test does not require an empty account.

## Journal, restoration and session cleanup

Execution artifacts use a new private `access-*` directory under the existing provider's `.e2e/live/feed05-browser/` root. Trace/video are off. `intent.jsonl` is 0600 and fsynced: full owner entitlements are recorded before revoke admission; each exact DELETE/PUT records its prestate and body before dispatch. A failed journal prevents dispatch. Full snapshots/IDs/emails, runner logs and failure artifacts stay private. The handoff summary is allowlisted booleans/counts and source hash only.

`withRevokedAccess` always reconciles after a dispatched/ambiguous DELETE, restores the exact admitted before semantic set in `finally`, and compares the complete semantic set. Unknown DELETE acknowledgement, wrong denial, and cleanup failure preserve primary plus restore causes. It never retries a write. Feed signout, owner Auth signout, and separate admin Auth signout are attempted independently after restoration, each with real unauthenticated readback. Browser release independently closes the owned context, verifies CDP refusal, and removes the temporary profile. Failure of any layer stays nonzero.

A network outage, disk failure or hard process termination can prevent restoration/signout; this remains a failed acceptance requiring parent recovery from the private durable journal through the same real APIs. No database fallback or generic admin restore tool is invoked. Current source is reviewable preparation, not successful live withdrawal evidence.

## Portable private input delivery

After parent review approves execution, copy the three already authorized 0600 inputs into this checkout. Do not print, commit, or otherwise copy their values:

```sh
mkdir -m 0700 -p live/FEED-05/private
install -m 0600 /Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/live/auth/.e2e/live/private/accounts.json \
  live/FEED-05/private/accounts.json
install -m 0600 /Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/live/auth/live/AUTH-06/admin/private.local.json \
  live/FEED-05/private/access-admin.json
install -m 0600 /Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/live/auth/.e2e/live/private/auth-admin-totp.json \
  live/FEED-05/private/auth-admin-totp.json
```
