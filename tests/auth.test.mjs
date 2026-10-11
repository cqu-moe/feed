import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const feedOrigin = 'https://feed.test';
const authOrigin = 'https://auth.test';
const clientId = 'feed-test-client';
const clientSecret = 'feed-test-secret';
const encryptionKey = 'feed-test-session-encryption-key';
let miniflare;
let db;
let authWorker;

before(async () => {
  const app = await build({
    stdin: {
      contents: `
        import { authRoute, session } from './worker/auth.mjs';
        export default {
          async fetch(request, env) {
            const auth = await authRoute(request, env);
            if (auth) return auth;

            const url = new URL(request.url);
            if (!url.pathname.startsWith('/api/')) {
              return new Response('Not found', { status: 404 });
            }

            const state = await session(request, env);
            if (state.error === 'unavailable') {
              return Response.json({ error: state.error }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
            }
            if (url.pathname === '/api/session') return Response.json(state, { headers: { 'Cache-Control': 'no-store' } });
            if (!state.authenticated) {
              return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
            }
            if (!state.entitled) {
              return Response.json({ error: state.error }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
            }
            if (url.pathname !== '/api/files/article/attachment-1.pdf') {
              return Response.json({ error: 'not found' }, { status: 404 });
            }
            return new Response('saved-pdf', {
              headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
            });
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });

  const provider = await build({
    stdin: {
      contents: `
        import { exportJWK, generateKeyPair, SignJWT } from 'jose';

        const encoder = new TextEncoder();
        const state = { feedAccess: true, outage: false, codeCounter: 0, tokenCounter: 0 };
        const codes = new Map();
        const tokens = new Map();
        let keyPairPromise;

        function base64Url(bytes) {
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        }

        async function keys() {
          keyPairPromise ??= generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
          return keyPairPromise;
        }

        async function idToken(nonce, subject) {
          const { publicKey, privateKey } = await keys();
          const jwk = await exportJWK(publicKey);
          return {
            jwk: { ...jwk, kid: 'auth-test-key', alg: 'EdDSA', use: 'sig' },
            token: await new SignJWT({ nonce })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'auth-test-key' })
              .setIssuer('${authOrigin}/api/auth')
              .setAudience('${clientId}')
              .setSubject(subject)
              .setIssuedAt()
              .setExpirationTime('10m')
              .sign(privateKey),
          };
        }

        function json(body, status = 200) {
          return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
        }

        export default {
          async fetch(request) {
            const url = new URL(request.url);

            if (url.pathname === '/__test/state' && request.method === 'POST') {
              Object.assign(state, await request.json());
              return json(state);
            }
            if (state.outage) return new Response('auth unavailable', { status: 503 });

            if (url.pathname === '/api/v1/auth/jwks') {
              const { publicKey } = await keys();
              const jwk = await exportJWK(publicKey);
              return json({ keys: [{ ...jwk, kid: 'auth-test-key', alg: 'EdDSA', use: 'sig' }] });
            }

            if (url.pathname === '/api/v1/auth/oauth2/authorize' && request.method === 'GET') {
              if (url.searchParams.get('client_id') !== '${clientId}') return json({ error: 'invalid_client' }, 400);
              if (url.searchParams.get('redirect_uri') !== '${feedOrigin}/auth/callback') return json({ error: 'invalid_redirect_uri' }, 400);
              if (url.searchParams.get('response_type') !== 'code') return json({ error: 'unsupported_response_type' }, 400);
              if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) {
                return json({ error: 'invalid_request' }, 400);
              }
              const scope = new Set((url.searchParams.get('scope') ?? '').split(' '));
              for (const required of ['openid', 'profile', 'offline_access']) {
                if (!scope.has(required)) return json({ error: 'invalid_scope' }, 400);
              }

              const code = 'auth-code-' + ++state.codeCounter;
              codes.set(code, {
                nonce: url.searchParams.get('nonce'),
                state: url.searchParams.get('state'),
                challenge: url.searchParams.get('code_challenge'),
                redirectUri: url.searchParams.get('redirect_uri'),
              });
              const callback = new URL(url.searchParams.get('redirect_uri'));
              callback.searchParams.set('code', code);
              callback.searchParams.set('state', url.searchParams.get('state'));
              return new Response(null, { status: 302, headers: { Location: callback.href } });
            }

            if (url.pathname === '/api/v1/auth/oauth2/token' && request.method === 'POST') {
              const expected = 'Basic ' + btoa('${clientId}:${clientSecret}');
              if (request.headers.get('Authorization') !== expected) return json({ error: 'invalid_client' }, 401);

              const form = new URLSearchParams(await request.text());
              const code = codes.get(form.get('code'));
              if (
                form.get('grant_type') !== 'authorization_code' ||
                !code ||
                form.get('redirect_uri') !== code.redirectUri ||
                !form.get('code_verifier')
              ) return json({ error: 'invalid_grant' }, 400);

              const digest = await crypto.subtle.digest('SHA-256', encoder.encode(form.get('code_verifier')));
              if (base64Url(new Uint8Array(digest)) !== code.challenge) return json({ error: 'invalid_grant' }, 400);
              codes.delete(form.get('code'));

              const subject = 'user-uu';
              const accessToken = 'access-token-' + ++state.tokenCounter;
              const signed = await idToken(code.nonce, subject);
              tokens.set(accessToken, { sub: subject, sid: 'central-session-' + state.tokenCounter });
              return json({
                access_token: accessToken,
                refresh_token: 'refresh-token-' + state.tokenCounter,
                token_type: 'Bearer',
                expires_in: 3600,
                id_token: signed.token,
              });
            }

            if (url.pathname === '/api/v1/auth/oauth2/userinfo' && request.method === 'GET') {
              const authorization = request.headers.get('Authorization') ?? '';
              const token = tokens.get(authorization.replace(/^Bearer /, ''));
              if (!token) return json({ error: 'invalid_token' }, 401);
              return json({ sub: token.sub, name: 'UU', email: 'uu@401.moe' });
            }

            if (url.pathname === '/api/v1/auth/oauth2/introspect' && request.method === 'POST') {
              const expected = 'Basic ' + btoa('${clientId}:${clientSecret}');
              if (request.headers.get('Authorization') !== expected) return json({ error: 'invalid_client' }, 401);
              const form = new URLSearchParams(await request.text());
              const token = tokens.get(form.get('token'));
              if (!token) return json({ active: false });
              return json({
                active: true,
                client_id: '${clientId}',
                sub: token.sub,
                sid: token.sid,
                exp: Math.floor(Date.now() / 1000) + 600,
                caps: { feed: { access: state.feedAccess } },
              });
            }

            return json({ error: 'not found' }, 404);
          },
        };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });

  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: 'feed',
        modules: true,
        script: app.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          BASE_URL: feedOrigin,
          AUTH_BASE_URL: authOrigin,
          FEED_AUTH_CLIENT_ID: clientId,
          FEED_AUTH_CLIENT_SECRET: clientSecret,
          FEED_SESSION_ENCRYPTION_KEY: encryptionKey,
        },
        d1Databases: ['DB'],
        serviceBindings: { AUTH: 'auth' },
      },
      {
        name: 'auth',
        modules: true,
        script: provider.outputFiles[0].text,
        compatibilityDate: '2026-10-11',
        compatibilityFlags: ['nodejs_compat'],
      },
    ],
  }));
  db = await miniflare.getD1Database('DB', 'feed');
  authWorker = await miniflare.getWorker('auth');

  const migration = await readFile('migrations/0002_auth.sql', 'utf8');
  for (const statement of migration.split(/;\s*\n(?=CREATE|DROP|PRAGMA|$)/).filter((part) => part.trim())) {
    await db.prepare(statement).run();
  }
});

after(async () => {
  await miniflare?.dispose();
});

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function cookie(response, name) {
  return response.headers.getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(';')[0]?.slice(name.length + 1);
}

async function setProviderState(changes) {
  const response = await authWorker.fetch(`${authOrigin}/__test/state`, {
    method: 'POST',
    body: JSON.stringify(changes),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('OAuth BFF binds login transactions and enforces live entitlement', async () => {
  await setProviderState({ feedAccess: true, outage: false });
  const login = await miniflare.dispatchFetch(`${feedOrigin}/auth/login?next=/articles`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('Cache-Control') ?? '', /no-store/);

  const loginCookie = cookie(login, '__Host-feed_login');
  assert.ok(loginCookie);
  const loginCookieHeader = login.headers.getSetCookie().find((value) => value.startsWith('__Host-feed_login='));
  assert.match(loginCookieHeader, /Secure; HttpOnly; SameSite=Lax/);

  const authorize = new URL(login.headers.get('Location'));
  assert.equal(authorize.origin, authOrigin);
  assert.equal(authorize.pathname, '/api/v1/auth/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  assert.equal(authorize.searchParams.get('redirect_uri'), `${feedOrigin}/auth/callback`);
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('scope'), 'openid profile offline_access');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const state = authorize.searchParams.get('state');
  const nonce = authorize.searchParams.get('nonce');
  const challenge = authorize.searchParams.get('code_challenge');
  assert.ok(state && nonce && challenge);

  const loginRow = await db.prepare('SELECT state_hash, browser_hash, payload FROM feed_login').first();
  assert.equal(loginRow.state_hash, await sha256Base64Url(state));
  assert.equal(loginRow.browser_hash, await sha256Base64Url(loginCookie));
  assert.ok(!loginRow.payload.includes(state));
  assert.ok(!loginRow.payload.includes(loginCookie));
  assert.ok(!loginRow.payload.includes(nonce));

  const authorization = await authWorker.fetch(authorize.href, { redirect: 'manual' });
  assert.equal(authorization.status, 302);
  const callbackUrl = new URL(authorization.headers.get('Location'));
  assert.equal(callbackUrl.origin, feedOrigin);
  assert.equal(callbackUrl.pathname, '/auth/callback');
  assert.equal(callbackUrl.searchParams.get('state'), state);
  assert.ok(callbackUrl.searchParams.get('code'));

  const stolenBrowser = await miniflare.dispatchFetch(callbackUrl.href, {
    redirect: 'manual',
    headers: { Cookie: `__Host-feed_login=${await sha256Base64Url('wrong-browser')}` },
  });
  assert.equal(stolenBrowser.status, 303);
  assert.equal(new URL(stolenBrowser.headers.get('Location'), feedOrigin).pathname, '/login');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM feed_login').first('n'), 1);

  const callback = await miniflare.dispatchFetch(callbackUrl.href, {
    redirect: 'manual',
    headers: { Cookie: `__Host-feed_login=${loginCookie}` },
  });
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('Location'), feedOrigin).href, `${feedOrigin}/articles`);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM feed_login').first('n'), 0);

  const sessionCookie = cookie(callback, '__Host-feed_session');
  assert.ok(sessionCookie);
  const sessionCookieHeader = callback.headers.getSetCookie().find((value) => value.startsWith('__Host-feed_session='));
  assert.match(sessionCookieHeader, /Secure; HttpOnly; SameSite=Lax/);
  assert.match(cookie(callback, '__Host-feed_login'), /deleted/);

  const sessionRow = await db.prepare('SELECT token_hash, payload FROM feed_session').first();
  assert.equal(sessionRow.token_hash, await sha256Base64Url(sessionCookie));
  assert.ok(!sessionRow.payload.includes('access-token-'));
  assert.ok(!sessionRow.payload.includes('refresh-token-'));

  const protectedPath = '/api/files/article/attachment-1.pdf';
  const entitled = await miniflare.dispatchFetch(`${feedOrigin}${protectedPath}`, {
    headers: { Cookie: `__Host-feed_session=${sessionCookie}` },
  });
  assert.equal(entitled.status, 200);
  assert.equal(await entitled.text(), 'saved-pdf');

  await setProviderState({ feedAccess: false });
  const denied = await miniflare.dispatchFetch(`${feedOrigin}${protectedPath}`, {
    headers: { Cookie: `__Host-feed_session=${sessionCookie}` },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'access_denied');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM feed_session').first('n'), 1);

  await setProviderState({ outage: true });
  const unavailable = await miniflare.dispatchFetch(`${feedOrigin}${protectedPath}`, {
    headers: { Cookie: `__Host-feed_session=${sessionCookie}` },
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'unavailable');

  await setProviderState({ outage: false });
  const logout = await miniflare.dispatchFetch(`${feedOrigin}/auth/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: `__Host-feed_session=${sessionCookie}`, Origin: feedOrigin },
  });
  assert.equal(logout.status, 200);
  assert.match(cookie(logout, '__Host-feed_session'), /deleted/);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM feed_session').first('n'), 0);

  const afterLogout = await miniflare.dispatchFetch(`${feedOrigin}${protectedPath}`, {
    headers: { Cookie: `__Host-feed_session=${sessionCookie}` },
  });
  assert.equal(afterLogout.status, 401);
});
