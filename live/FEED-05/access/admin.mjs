import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AUTH, PROJECT, account, journal, requireThat as check } from '../browser/state.mjs';
import { totp } from './totp.mjs';

const privateConfig = resolve(PROJECT, 'live/FEED-05/private/access-admin.json');
const totpFile = resolve(PROJECT, 'live/FEED-05/private/auth-admin-totp.json');

async function privateJson(path) {
  check(process.env.FEED05_MODE === 'execute', 'OFFLINE_PRIVATE_INPUT_FORBIDDEN');
  const info = await stat(path);
  check(info.isFile() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid()
    && await realpath(path) === path, 'PRIVATE_INPUT_PERMISSIONS');
  return JSON.parse(await readFile(path, 'utf8'));
}

export function entitlementItems(rows, owner) {
  check(Array.isArray(rows) && typeof owner === 'string' && owner.length > 0, 'ENTITLEMENT_SCHEMA');
  const seen = new Set();
  return rows.map(row => {
    check(row?.userId === owner && typeof row.subsystem === 'string'
      && typeof row.capability === 'string' && typeof row.value === 'string', 'ENTITLEMENT_SCHEMA');
    const key = `${row.subsystem}\0${row.capability}`;
    check(!seen.has(key), 'DUPLICATE_ENTITLEMENT'); seen.add(key);
    return { subsystem: row.subsystem, capability: row.capability, value: row.value };
  }).sort((a, b) => `${a.subsystem}\0${a.capability}`.localeCompare(`${b.subsystem}\0${b.capability}`));
}

export function restorePlan(rows, owner) {
  const items = entitlementItems(rows, owner);
  check(JSON.stringify(items) === JSON.stringify([
    { subsystem: 'feed', capability: 'access', value: '1' },
    { subsystem: 'feed', capability: 'sub_limit', value: '3' },
  ]), 'EXACT_TWO_ROW_BASELINE_REQUIRED');
  return { items };
}

export function adminRequestAllowed(owner, path, method, body) {
  const onlyKeys = keys => body && Object.keys(body).sort().join(',') === keys.sort().join(',');
  if (method === 'GET' && ['/auth/get-session', '/auth/security/status?purpose=admin'].includes(path)) return body === undefined;
  if (method === 'POST') {
    if (path === '/auth/sign-in/email') return onlyKeys(['email', 'password']) && typeof body.email === 'string' && typeof body.password === 'string';
    if (path === '/auth/two-factor/verify-totp') return onlyKeys(['code']) && /^\d{6,8}$/.test(body.code);
    if (path === '/auth/security/challenge') return onlyKeys(['password', 'purpose']) && body.purpose === 'admin' && typeof body.password === 'string';
    if (path === '/auth/security/complete') return onlyKeys(['challenge', 'method', 'code']) && body.method === 'totp'
      && typeof body.challenge === 'string' && /^\d{6,8}$/.test(body.code);
    if (path === '/auth/sign-out') return onlyKeys([]);
  }
  const endpoint = `/admin/users/${encodeURIComponent(owner)}/entitlements`;
  if (method === 'GET' && path === endpoint) return true;
  if (method === 'DELETE' && path === `${endpoint}/feed/access` && body === undefined) return true;
  return method === 'PUT' && path === endpoint && JSON.stringify(body) === JSON.stringify({
    items: [{ subsystem: 'feed', capability: 'access', value: '1' },
      { subsystem: 'feed', capability: 'sub_limit', value: '3' }],
  });
}

export async function createAdmin(owner) {
  check(process.env.FEED05_MODE === 'execute', 'OFFLINE_ADMIN_FORBIDDEN');
  check(/^[A-Za-z0-9_-]{10,128}$/.test(owner), 'OWNER_ID_REQUIRED');
  const config = await privateJson(privateConfig);
  const ownerAccount = await account('owner');
  check(Array.isArray(config.readerUserIds) && config.readerUserIds.includes(owner)
    && config.adminUserId !== owner && config.adminEmail !== ownerAccount.email, 'DEDICATED_IDENTITIES_REQUIRED');
  check(typeof config.adminPassword === 'string' && config.adminPassword.length >= 12, 'ADMIN_PASSWORD_REQUIRED');
  const material = await privateJson(totpFile);
  check(typeof material.totpURI === 'string' && material.totpURI.length > 0, 'EXISTING_TOTP_REQUIRED');
  const cookies = new Map();
  let mutationArmed = false;
  async function request(path, method = 'GET', body) {
    check(adminRequestAllowed(owner, path, method, body), 'ADMIN_REQUEST_OUT_OF_SCOPE');
    check(!['PUT', 'DELETE'].includes(method) || mutationArmed, 'ADMIN_WRITE_NOT_JOURNALED');
    const response = await fetch(new URL(`/api/v1${path}`, AUTH), {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { origin: AUTH, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0], index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    await journal({ phase: 'admin-response', method, status: response.status,
      operation: path.startsWith('/admin/users/') ? 'owner-entitlements' : path.split('?')[0] });
    check(response.ok, `AUTH_HTTP_${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const endpoint = `/admin/users/${encodeURIComponent(owner)}/entitlements`;
  return {
    async login() {
      await journal({ phase: 'intent', step: 'admin-login-existing-totp' });
      const signin = await request('/auth/sign-in/email', 'POST', { email: config.adminEmail, password: config.adminPassword });
      check(signin?.twoFactorRedirect === true, 'REAL_ADMIN_TOTP_CHALLENGE_REQUIRED');
      await request('/auth/two-factor/verify-totp', 'POST', { code: totp(material.totpURI) });
      const session = await request('/auth/get-session');
      check(session?.user?.id === config.adminUserId && session.user.role === 'superAdmin'
        && session.user.twoFactorEnabled === true && session.user.emailVerified === true && !session.user.banned, 'ADMIN_IDENTITY_REQUIRED');
      await journal({ phase: 'intent', step: 'admin-strong-proof' });
      const challenge = await request('/auth/security/challenge', 'POST', { password: config.adminPassword, purpose: 'admin' });
      check(typeof challenge?.challenge === 'string' && challenge.challenge.length > 0, 'STRONG_CHALLENGE_REQUIRED');
      await request('/auth/security/complete', 'POST', { challenge: challenge.challenge, method: 'totp', code: totp(material.totpURI) });
      const proof = await request('/auth/security/status?purpose=admin');
      check(proof?.strong === true && proof.verified === true, 'ADMIN_STRONG_PROOF_REQUIRED');
      await journal({ phase: 'complete', step: 'admin-strong-proof' });
    },
    async rows() { const response = await request(endpoint); entitlementItems(response?.data, owner); return response.data; },
    async write(step, before, method, body) {
      await journal({ phase: 'intent', step, owner, before, ...(body === undefined ? {} : { body }) });
      mutationArmed = true;
      try { return await request(method === 'DELETE' ? `${endpoint}/feed/access` : endpoint, method, body); }
      finally { mutationArmed = false; }
    },
    async signout() {
      await journal({ phase: 'intent', step: 'admin-signout' });
      await request('/auth/sign-out', 'POST', {});
      check(await request('/auth/get-session') === null, 'ADMIN_SIGNOUT_READBACK'); cookies.clear();
      await journal({ phase: 'complete', step: 'admin-signout' });
    },
  };
}

// Owner-boundary cleanup: persist intent before one DELETE, reconcile unknown
// responses, and restore the exact admitted semantic set even when verify fails.
export async function withRevokedAccess({ admin, owner, verify, record = journal }) {
  const before = await admin.rows();
  await record({ phase: 'baseline-entitlements', owner, before });
  const plan = restorePlan(before, owner);
  const original = JSON.stringify(plan.items);
  const expectedRevoked = JSON.stringify(plan.items.filter(row => row.capability !== 'access'));
  let primary;
  const cleanup = [];
  let dispatched = false;
  try {
    // Set before awaiting the dispatch journal: on an ambiguous response,
    // finally always reads current state; an unchanged row needs no write.
    dispatched = true;
    await admin.write('access-revoke', before, 'DELETE');
    const revoked = await admin.rows();
    check(JSON.stringify(entitlementItems(revoked, owner)) === expectedRevoked, 'EXACT_REVOKE_READBACK');
    await record({ phase: 'complete', step: 'access-revoke', owner, after: revoked });
    await verify();
  } catch (error) { primary = error; }
  finally {
    if (dispatched) {
      try {
        const current = await admin.rows();
        const items = entitlementItems(current, owner);
        if (JSON.stringify(items) !== original) {
          check(JSON.stringify(items) === expectedRevoked, 'RESTORE_CONCURRENT_CHANGE');
          await admin.write('access-restore', current, 'PUT', plan);
        }
        const restored = await admin.rows();
        check(JSON.stringify(entitlementItems(restored, owner)) === original, 'FULL_ENTITLEMENT_READBACK');
        await record({ phase: 'complete', step: 'access-restore', owner, before, after: restored,
          fullSemanticSetEqual: true, quotaValueUnchanged: true, updatedAtMayBeRebuilt: true });
      } catch (error) { cleanup.push(error); }
    }
  }
  if (primary || cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], 'ACCESS_PRIMARY_AND_RESTORE');
}
