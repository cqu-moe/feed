import { open, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const FEED = 'https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev';
export const AUTH = 'https://cqu-e2e-20261016-auth.user-unauthorized.workers.dev';
export const BASE = 'a7316fbb8d383a7e2853d9464170dda32b218c92';
export const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
export const ACCOUNTS = resolve(PROJECT, 'live/FEED-05/private/accounts.json');
export const ROOT = resolve(PROJECT, '.e2e/live/feed05-browser');
export function requireThat(ok, code) { if (!ok) throw new Error(code); }
export function output() {
  if (process.env.FEED05_MODE !== 'execute') return resolve(PROJECT, 'live/FEED-05/browser/.offline/collection');
  const path = resolve(process.env.FEED05_OUTPUT || `${ROOT}/discovery`);
  requireThat(path.startsWith(`${ROOT}/`) && path !== ROOT, 'PRIVATE_OUTPUT_REQUIRED');
  return path;
}
export function mode(args) {
  requireThat(args.length === 1 && ['--check', '--run'].includes(args[0]), 'USE_CHECK_OR_RUN_ONLY');
  return args[0];
}
export function rssAddress(value) {
  requireThat(typeof value === 'string', 'RSS_REQUIRED');
  let url;
  try { url = new URL(value, FEED); } catch { throw new Error('RSS_ORIGIN'); }
  requireThat(url.origin === FEED && !url.username && !url.password && !url.hash
    && url.pathname === '/rss' && url.searchParams.getAll('token').length === 1
    && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('token') ?? '') && [...url.searchParams].length === 1, 'RSS_ORIGIN');
  return url.href;
}
export function selectAccounts(value) {
  const result = {};
  requireThat(Array.isArray(value?.accounts), 'ACCOUNT_SCHEMA');
  for (const role of ['owner', 'other']) {
    const matches = value.accounts.filter(a => a.intendedRole === role);
    requireThat(matches.length === 1 && typeof matches[0].email === 'string'
      && typeof matches[0].password === 'string' && matches[0].password.length >= 6, 'ACCOUNT_SCHEMA');
    result[role] = matches[0];
  }
  requireThat(result.owner.email !== result.other.email, 'DISTINCT_ACCOUNTS_REQUIRED');
  return result;
}
let accounts;
export async function account(role) {
  requireThat(process.env.FEED05_MODE === 'execute', 'EXECUTION_REQUIRED_FOR_SECRETS');
  if (!accounts) {
    const info = await stat(ACCOUNTS);
    requireThat(info.isFile() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid()
      && await realpath(ACCOUNTS) === ACCOUNTS, 'TASK_ACCOUNT_FILE_PERMISSIONS');
    accounts = selectAccounts(JSON.parse(await readFile(ACCOUNTS, 'utf8')));
  }
  requireThat(role === 'owner' || role === 'other', 'ACCOUNT_ROLE');
  return accounts[role];
}
async function appendRecord(path, record, flags = 'a') {
  const handle = await open(path, flags, 0o600);
  const errors = [];
  try { await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'); await handle.sync(); }
  catch (error) { errors.push(error); }
  try { await handle.close(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'JOURNAL_WRITE_AND_CLOSE');
}
export async function journal(record) {
  requireThat(process.env.FEED05_MODE === 'execute', 'EXECUTION_REQUIRED');
  await appendRecord(`${output()}/intent.jsonl`, record);
}
function describeError(error, seen = new Set()) {
  if (!(error instanceof Error)) return { name: 'ThrownValue', message: String(error) };
  if (seen.has(error)) return { name: error.name, message: '[circular error reference]' };
  seen.add(error);
  const value = { name: error.name, message: error.message, stack: error.stack,
    ...Object.fromEntries(['code', 'errno', 'syscall', 'path'].filter(key => key in error).map(key => [key, error[key]])),
    ...('cause' in error ? { cause: describeError(error.cause, seen) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(item => describeError(item, seen)) } : {}) };
  seen.delete(error);
  return value;
}
export async function preserveFailure(label, errors) {
  let failure = new AggregateError(errors, label);
  try { await journal({ phase: 'failure', error: describeError(failure) }); }
  catch (journalError) {
    failure = new AggregateError([...failure.errors, journalError], label);
    try {
      // An independent private file retains even a broken intent journal's
      // write/fsync AND close errors, before the framework flattens aggregates.
      requireThat(process.env.FEED05_MODE === 'execute', 'EXECUTION_REQUIRED');
      await appendRecord(`${output()}/failure-${randomUUID()}.jsonl`, { phase: 'failure', error: describeError(failure) }, 'wx');
    } catch (fallbackError) {
      failure = new AggregateError([...failure.errors, fallbackError], label);
      // If all private storage fails, keep the entire chain in the exception
      // too. The launcher captures framework stdout/stderr privately.
      failure.message += '\n' + JSON.stringify(describeError(failure));
    }
  }
  return failure;
}
export async function finishRun(label, { primary, cleanup, ...result }) {
  const errors = [...(primary ? [primary] : []), ...cleanup];
  try {
    await journal({ phase: 'result', ...result, primaryFailed: Boolean(primary), cleanupFailures: cleanup.length,
      ...(primary ? { primary: describeError(primary) } : {}), cleanup: cleanup.map(error => describeError(error)) });
  } catch (error) { errors.push(error); }
  if (errors.length) throw await preserveFailure(label, errors);
}
export function ownedRows(rows, baselineIds, names) {
  return rows.filter(row => !baselineIds.includes(row.id) && names.includes(row.name)
    && row.emailMode === 'off' && /^[a-f0-9]{24}$/.test(row.id));
}

function rowFingerprint(row) {
  if (Array.isArray(row)) return row.map(rowFingerprint);
  if (!row || typeof row !== 'object') return row;
  return Object.fromEntries(Object.keys(row).sort().map(key => [key, rowFingerprint(row[key])]));
}

function equalFingerprint(left, right) {
  return JSON.stringify(rowFingerprint(left)) === JSON.stringify(rowFingerprint(right));
}

export function admissibleBaseline(list) {
  requireThat(list && Array.isArray(list.subscriptions), 'BASELINE_SCHEMA');
  requireThat(list.usage === 0, 'BASELINE_ACTIVE_USAGE_MUST_BE_ZERO');
  const rows = list.subscriptions;
  const ids = new Set(rows.map(row => row.id));
  requireThat(ids.size === rows.length, 'BASELINE_DUPLICATE_ID');
  for (const row of rows) {
    requireThat(typeof row?.id === 'string' && /^[a-f0-9]{24}$/.test(row.id), 'BASELINE_ID_REQUIRED');
    requireThat(row.deletedAt !== null, 'BASELINE_MUST_BE_SOFT_DELETED');
    requireThat(row.emailMode === 'off', 'BASELINE_EMAIL_MUST_BE_OFF');
    requireThat(row.rssStatus === 'rss_revoked', 'BASELINE_RSS_MUST_BE_REVOKED');
    requireThat(row.rssUrl === null, 'BASELINE_RSS_MUST_BE_NULL');
  }
  return { usage: list.usage, rows, ids: [...ids], fingerprints: new Map(rows.map(row => [row.id, rowFingerprint(row)])) };
}

function currentRows(list, baseline) {
  requireThat(list && Array.isArray(list.subscriptions), 'BASELINE_READBACK_SCHEMA');
  return new Map(list.subscriptions.map(row => [row?.id, row]));
}

export function baselineUnchanged(list, baseline) {
  const rows = currentRows(list, baseline);
  for (const [id, before] of baseline.fingerprints) {
    const after = rows.get(id);
    requireThat(after !== undefined, 'BASELINE_ROW_MISSING');
    requireThat(equalFingerprint(before, after), 'BASELINE_ROW_CHANGED');
  }
  return true;
}

export function baselineOnly(list, baseline) {
  baselineUnchanged(list, baseline);
  requireThat(list.usage === baseline.usage, 'BASELINE_USAGE_CHANGED');
  requireThat(list.subscriptions.every(row => baseline.ids.includes(row.id)), 'BASELINE_UNKNOWN_ROW');
  return true;
}

export function cleanupCandidates(list, baseline, names) {
  baselineUnchanged(list, baseline);
  const candidates = ownedRows(list.subscriptions, baseline.ids, names);
  const candidateIds = new Set(candidates.map(row => row.id));
  requireThat(list.subscriptions.every(row => baseline.ids.includes(row.id) || candidateIds.has(row.id)),
    'CLEANUP_UNKNOWN_ROW');
  requireThat(candidates.length <= 1, 'CLEANUP_OWNED_AMBIGUITY');
  return candidates;
}

export function finalCleanupReadback(list, baseline, ownedIds) {
  baselineUnchanged(list, baseline);
  requireThat(list.usage === 0, 'CLEANUP_ACTIVE_USAGE_MUST_BE_ZERO');
  const owned = new Set(ownedIds);
  const rowsById = new Map(list.subscriptions.map(row => [row.id, row]));
  for (const id of owned) requireThat(rowsById.has(id), 'CLEANUP_OWNED_ROW_MISSING');
  requireThat(list.subscriptions.every(row => baseline.ids.includes(row.id) || owned.has(row.id)),
    'CLEANUP_UNKNOWN_ROW');
  for (const row of list.subscriptions) {
    if (!owned.has(row.id)) continue;
    requireThat(row.deletedAt !== null, 'FINAL_TOMBSTONE_REQUIRED');
    requireThat(row.emailMode === 'off', 'FINAL_TOMBSTONE_REQUIRED');
    requireThat(row.rssStatus === 'rss_revoked' && row.rssUrl === null, 'FINAL_TOMBSTONE_REQUIRED');
  }
  return true;
}
