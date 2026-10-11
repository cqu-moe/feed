import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

const SESSION_COOKIE = "__Host-feed_session";
const LOGIN_COOKIE = "__Host-feed_login";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_LIFETIME_SECONDS = 10 * 60;
const REFRESH_LEASE_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class AuthUnavailableError extends Error {}
class InvalidTokenError extends Error {}
class OAuthRequestError extends Error {
  constructor(status, code) {
    super(code || `oauth_http_${status}`);
    this.code = code || `oauth_http_${status}`;
  }
}

function pickEnv(env, clearName, compatibleName) {
  return env?.[clearName] ?? env?.[compatibleName];
}

function oauthConfig(env) {
  const baseUrlValue = pickEnv(env, "BASE_URL", "PUBLIC_URL");
  const authBaseUrlValue = pickEnv(env, "AUTH_BASE_URL", "AUTH_ORIGIN");
  const clientId = pickEnv(env, "FEED_AUTH_CLIENT_ID", "AUTH_CLIENT_ID");
  const clientSecret = pickEnv(env, "FEED_AUTH_CLIENT_SECRET", "AUTH_CLIENT_SECRET");
  const encryptionKey = pickEnv(
    env,
    "FEED_SESSION_ENCRYPTION_KEY",
    "SESSION_ENCRYPTION_KEY",
  );

  if (!baseUrlValue || !authBaseUrlValue || !clientId || !clientSecret || !encryptionKey) {
    throw new AuthUnavailableError("missing_oauth_configuration");
  }

  let baseUrl;
  let authBaseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
    authBaseUrl = new URL(authBaseUrlValue);
  } catch {
    throw new AuthUnavailableError("invalid_oauth_origin");
  }

  return {
    baseUrl,
    authBaseUrl,
    clientId,
    clientSecret,
    encryptionKey,
    issuer: new URL("/api/auth", authBaseUrl).href,
    authorizationEndpoint: new URL("/api/v1/auth/oauth2/authorize", authBaseUrl).href,
    tokenEndpoint: new URL("/api/v1/auth/oauth2/token", authBaseUrl).href,
    introspectionEndpoint: new URL("/api/v1/auth/oauth2/introspect", authBaseUrl).href,
    userinfoEndpoint: new URL("/api/v1/auth/oauth2/userinfo", authBaseUrl).href,
    jwksUrl: new URL("/api/v1/auth/jwks", authBaseUrl),
    redirectUri: new URL("/auth/callback", baseUrl).href,
  };
}

function base64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashToken(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function sessionKey(secret) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`feed-session-v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env, secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

async function unseal(env, secret, value) {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new Error("invalid_encrypted_payload");
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(parts[1]) },
    await sessionKey(secret),
    fromBase64Url(parts[2]),
  );
  return JSON.parse(decoder.decode(decrypted));
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") ?? "";
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function response(body, status, cookies = []) {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  const result = body === null
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
  for (const cookie of cookies) result.headers.append("Set-Cookie", cookie);
  return result;
}

function redirect(location, cookies = []) {
  const result = response(null, 303, cookies);
  result.headers.set("Location", location);
  return result;
}

function safeReturnTo(value, baseUrl) {
  const fallback = "/";
  if (typeof value !== "string" || !value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  try {
    const url = new URL(value, baseUrl);
    return url.origin === baseUrl.origin ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}

async function authFetch(env, url, init = {}) {
  const target = String(url);
  if (typeof env.AUTH?.fetch === "function") {
    return env.AUTH.fetch(target, init);
  }
  return fetch(target, init);
}

async function requestJson(env, url, init) {
  let response;
  try {
    response = await authFetch(env, url, init);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AuthUnavailableError("auth_timeout");
    }
    throw new AuthUnavailableError("auth_network_error");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new OAuthRequestError(response.status, body && typeof body === "object" ? body.error : null);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AuthUnavailableError("invalid_auth_response");
  }
  return body;
}

function basicAuthorization(clientId, clientSecret) {
  const raw = encoder.encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function oauthHeaders(config, bearer) {
  const headers = new Headers();
  headers.set(
    "Authorization",
    bearer ?? basicAuthorization(config.clientId, config.clientSecret),
  );
  if (bearer) headers.set("Accept", "application/json");
  else headers.set("Content-Type", "application/x-www-form-urlencoded");
  return headers;
}

async function verifyIdToken(env, config, idToken, expectedNonce) {
  if (typeof idToken !== "string" || !idToken) throw new InvalidTokenError("missing_id_token");
  const JWKS = createRemoteJWKSet(config.jwksUrl, {
    timeoutDuration: 10_000,
    cacheMaxAge: 5 * 60_000,
    [customFetch]: (url, init) => authFetch(env, url, init),
  });

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, JWKS, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["EdDSA"],
      clockTolerance: 30,
    }));
  } catch (error) {
    if (error instanceof AuthUnavailableError) throw error;
    throw new InvalidTokenError("invalid_id_token");
  }

  if (typeof claims.sub !== "string" || !claims.sub) throw new InvalidTokenError("missing_subject");
  if (expectedNonce !== undefined && claims.nonce !== expectedNonce) {
    throw new InvalidTokenError("nonce_mismatch");
  }
  return claims;
}

async function tokenRequest(env, config, parameters) {
  const body = new URLSearchParams(parameters);
  let result;
  try {
    result = await requestJson(env, config.tokenEndpoint, {
      method: "POST",
      headers: oauthHeaders(config),
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof AuthUnavailableError) throw error;
    if (error instanceof OAuthRequestError && error.code === "invalid_grant") {
      throw new InvalidTokenError("invalid_grant");
    }
    throw error;
  }

  if (
    typeof result.access_token !== "string" || !result.access_token ||
    typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer" ||
    typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0
  ) {
    throw new AuthUnavailableError("invalid_token_response");
  }
  return result;
}

async function fetchUserInfo(env, config, accessToken, sub) {
  const profile = await requestJson(env, config.userinfoEndpoint, {
    headers: oauthHeaders(config, `Bearer ${accessToken}`),
    signal: AbortSignal.timeout(10_000),
  });
  if (profile.sub !== sub) throw new InvalidTokenError("userinfo_subject_mismatch");
  return {
    id: sub,
    name: typeof profile.name === "string" && profile.name ? profile.name : undefined,
    email: typeof profile.email === "string" && profile.email ? profile.email : undefined,
  };
}

function validCredentials(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.accessToken === "string" && value.accessToken &&
    typeof value.accessExpiresAt === "number" && Number.isFinite(value.accessExpiresAt) &&
    typeof value.sub === "string" && value.sub &&
    value.user && typeof value.user === "object" && typeof value.user.id === "string",
  );
}

async function introspect(env, config, credentials) {
  let result;
  try {
    result = await requestJson(env, config.introspectionEndpoint, {
      method: "POST",
      headers: oauthHeaders(config),
      body: new URLSearchParams({
        token: credentials.accessToken,
        token_type_hint: "access_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof OAuthRequestError) throw new AuthUnavailableError("introspection_client_failed");
    throw error;
  }

  if (result.active !== true) return null;
  if (
    result.client_id !== config.clientId ||
    result.sub !== credentials.sub ||
    typeof result.sid !== "string" || !result.sid ||
    typeof result.exp !== "number" || !Number.isFinite(result.exp) ||
    result.exp * 1000 <= Date.now()
  ) {
    throw new InvalidTokenError("invalid_introspection");
  }
  return result;
}

function hasFeedAccess(introspection) {
  return introspection?.caps?.feed?.access === true;
}

async function deleteSession(env, tokenHash) {
  await env.DB.prepare("DELETE FROM feed_session WHERE token_hash = ?").bind(tokenHash).run();
}

async function releaseRefreshLease(env, tokenHash, revision) {
  await env.DB
    .prepare("UPDATE feed_session SET refresh_until = 0 WHERE token_hash = ? AND revision = ?")
    .bind(tokenHash, revision)
    .run();
}

async function refreshCredentials(env, config, tokenHash, credentials) {
  if (!credentials.refreshToken) throw new InvalidTokenError("missing_refresh_token");

  const now = Date.now();
  const lease = await env.DB.prepare(`
    UPDATE feed_session
       SET refresh_until = ?, revision = revision + 1
     WHERE token_hash = ? AND revision = ? AND refresh_until <= ? AND expires_at > ?
     RETURNING revision
  `).bind(now + REFRESH_LEASE_MS, tokenHash, credentials.revision, now, now).first();
  if (!lease) throw new AuthUnavailableError("session_refresh_in_progress");

  let tokens;
  try {
    tokens = await tokenRequest(env, config, {
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });
    if (tokens.id_token) {
      const claims = await verifyIdToken(env, config, tokens.id_token, undefined);
      if (claims.sub !== credentials.sub) throw new InvalidTokenError("refresh_subject_mismatch");
    }
  } catch (error) {
    if (error instanceof InvalidTokenError && error.message === "invalid_grant") {
      await env.DB
        .prepare("DELETE FROM feed_session WHERE token_hash = ? AND revision = ?")
        .bind(tokenHash, lease.revision)
        .run();
      return null;
    }
    await releaseRefreshLease(env, tokenHash, lease.revision);
    throw error;
  }

  const nextCredentials = {
    ...credentials,
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token
      ? tokens.refresh_token
      : credentials.refreshToken,
    accessExpiresAt: Date.now() + tokens.expires_in * 1000,
    revision: lease.revision,
  };
  const saved = await env.DB.prepare(`
    UPDATE feed_session
       SET payload = ?, revision = revision + 1, refresh_until = 0
     WHERE token_hash = ? AND revision = ?
     RETURNING revision
  `).bind(await seal(env, config.encryptionKey, nextCredentials), tokenHash, lease.revision).first();
  if (!saved) return null;
  return { ...nextCredentials, revision: saved.revision };
}

function unauthenticated(error) {
  return { authenticated: false, entitled: false, ...(error ? { error } : {}) };
}

export async function session(request, env) {
  const cookieToken = parseCookies(request).get(SESSION_COOKIE);
  if (!cookieToken) return unauthenticated();

  let config;
  let tokenHash;
  let knownUser;
  try {
    config = oauthConfig(env);
    tokenHash = await hashToken(cookieToken);
    const row = await env.DB.prepare(
      "SELECT payload, expires_at, revision FROM feed_session WHERE token_hash = ?",
    ).bind(tokenHash).first();
    if (!row || row.expires_at <= Date.now()) {
      if (row) await deleteSession(env, tokenHash);
      return unauthenticated("session_expired");
    }

    let credentials = await unseal(env, config.encryptionKey, row.payload);
    if (!validCredentials(credentials)) {
      await deleteSession(env, tokenHash);
      return unauthenticated("invalid_session");
    }
    credentials.revision = row.revision;
    knownUser = credentials.user;

    if (credentials.accessExpiresAt <= Date.now() + 30_000) {
      credentials = await refreshCredentials(env, config, tokenHash, credentials);
      if (!credentials) return unauthenticated("session_expired");
      knownUser = credentials.user;
    }

    const authority = await introspect(env, config, credentials);
    if (!authority) {
      await deleteSession(env, tokenHash);
      return unauthenticated("session_expired");
    }
    if (!hasFeedAccess(authority)) {
      return {
        authenticated: true,
        entitled: false,
        user: credentials.user,
        error: "access_denied",
      };
    }

    return {
      authenticated: true,
      entitled: true,
      user: credentials.user,
    };
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      try {
        if (tokenHash) await deleteSession(env, tokenHash);
      } catch {
        // The next request will retry cleanup after an infrastructure failure.
      }
      return unauthenticated("session_expired");
    }

    console.warn(JSON.stringify({
      message: "feed_auth_unavailable",
      detail: error instanceof Error ? error.message : "unknown",
    }));
    return {
      authenticated: Boolean(knownUser),
      entitled: false,
      ...(knownUser ? { user: knownUser } : {}),
      error: "unavailable",
    };
  }
}

export async function authRoute(request, env) {
  const url = new URL(request.url);

  try {
    if (request.method === "GET" && (url.pathname === "/auth/login" || url.pathname === "/api/auth/login")) {
      const config = oauthConfig(env);
      const state = randomToken();
      const browserToken = randomToken();
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
      const nonce = randomToken();
      const transaction = {
        verifier,
        nonce,
        returnTo: safeReturnTo(url.searchParams.get("returnTo") ?? url.searchParams.get("next"), config.baseUrl),
      };
      const now = Date.now();

      await env.DB
        .prepare("DELETE FROM feed_login WHERE expires_at <= ?")
        .bind(now)
        .run();
      await env.DB
        .prepare("DELETE FROM feed_session WHERE expires_at <= ?")
        .bind(now)
        .run();
      await env.DB.prepare(`
        INSERT INTO feed_login(state_hash, browser_hash, payload, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        await hashToken(state),
        await hashToken(browserToken),
        await seal(env, config.encryptionKey, transaction),
        now + LOGIN_LIFETIME_SECONDS * 1000,
      ).run();

      const authorizeUrl = new URL(config.authorizationEndpoint);
      authorizeUrl.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: "openid profile offline_access",
        state,
        nonce,
        code_challenge: base64Url(new Uint8Array(await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(verifier),
        ))),
        code_challenge_method: "S256",
      }).toString();

      return redirect(authorizeUrl.href, [
        cookieHeader(LOGIN_COOKIE, browserToken, LOGIN_LIFETIME_SECONDS),
      ]);
    }

    if (request.method === "GET" && (url.pathname === "/auth/callback" || url.pathname === "/api/auth/callback")) {
      const config = oauthConfig(env);
      const cookies = parseCookies(request);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const browserToken = cookies.get(LOGIN_COOKIE);
      const clearLogin = cookieHeader(LOGIN_COOKIE, "deleted", 0);

      if (!state || !code || !browserToken || url.searchParams.get("error")) {
        return redirect("/login?auth=invalid", [clearLogin]);
      }

      const row = await env.DB.prepare(`
        DELETE FROM feed_login
         WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
         RETURNING payload
      `).bind(await hashToken(state), await hashToken(browserToken), Date.now()).first();
      if (!row) return redirect("/login?auth=invalid", [clearLogin]);

      const transaction = await unseal(env, config.encryptionKey, row.payload);
      const tokens = await tokenRequest(env, config, {
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: transaction.verifier,
      });
      const claims = await verifyIdToken(env, config, tokens.id_token, transaction.nonce);
      const user = await fetchUserInfo(env, config, tokens.access_token, claims.sub);
      let credentials = {
        version: 1,
        accessToken: tokens.access_token,
        refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
        accessExpiresAt: Date.now() + tokens.expires_in * 1000,
        sub: claims.sub,
        user,
        revision: 0,
      };
      const authority = await introspect(env, config, credentials);
      if (!authority) return redirect("/login?auth=invalid", [clearLogin]);

      const sessionToken = randomToken();
      const oldToken = cookies.get(SESSION_COOKIE);
      if (oldToken) {
        await env.DB
          .prepare("DELETE FROM feed_session WHERE token_hash = ?")
          .bind(await hashToken(oldToken))
          .run();
      }
      await env.DB.prepare(`
        INSERT INTO feed_session(token_hash, payload, expires_at, revision, refresh_until)
        VALUES (?, ?, ?, 0, 0)
      `).bind(
        await hashToken(sessionToken),
        await seal(env, config.encryptionKey, credentials),
        Date.now() + SESSION_LIFETIME_SECONDS * 1000,
      ).run();

      if (!hasFeedAccess(authority)) {
        return redirect("/access?reason=feed_access", [
          clearLogin,
          cookieHeader(SESSION_COOKIE, sessionToken, SESSION_LIFETIME_SECONDS),
        ]);
      }

      return redirect(transaction.returnTo, [
        clearLogin,
        cookieHeader(SESSION_COOKIE, sessionToken, SESSION_LIFETIME_SECONDS),
      ]);
    }

    if (request.method === "POST" && (url.pathname === "/auth/logout" || url.pathname === "/api/auth/logout")) {
      const config = oauthConfig(env);
      if (request.headers.get("Origin") !== config.baseUrl.origin) {
        return response({ error: "invalid_origin" }, 403);
      }
      const sessionToken = parseCookies(request).get(SESSION_COOKIE);
      if (sessionToken) {
        await env.DB
          .prepare("DELETE FROM feed_session WHERE token_hash = ?")
          .bind(await hashToken(sessionToken))
          .run();
      }
      return response({ authenticated: false }, 200, [
        cookieHeader(SESSION_COOKIE, "deleted", 0),
        cookieHeader(LOGIN_COOKIE, "deleted", 0),
      ]);
    }

    return null;
  } catch (error) {
    console.warn(JSON.stringify({
      message: "feed_auth_route_failed",
      detail: error instanceof Error ? error.message : "unknown",
    }));
    return response({ error: "unavailable" }, 503);
  }
}
