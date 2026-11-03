import {readFile} from 'node:fs/promises';

// Explicit operator input only: never read browser profiles or production secrets.
export async function readAdminSession({cookie = process.env.FEED_SESSION_COOKIE, credentialsFile} = {}) {
  if (!cookie && credentialsFile) {
    cookie = JSON.parse(await readFile(credentialsFile, 'utf8')).FEED_SESSION_COOKIE;
  }
  if (typeof cookie !== 'string' || !/^__Host-feed_session=[A-Za-z0-9_-]+$/.test(cookie)) {
    throw new Error('An authenticated administrator FEED_SESSION_COOKIE is required (__Host-feed_session=…); shared ADMIN_TOKEN credentials are retired');
  }
  return cookie;
}

export function adminHeaders(baseUrl, cookie) {
  const target = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    throw new Error('FEED_URL must use HTTPS (HTTP is allowed only for loopback testing)');
  }
  return {Cookie: cookie, Origin: target.origin};
}
