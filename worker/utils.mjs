import { Buffer } from 'node:buffer';
export const encoder = new TextEncoder();
export const json = (value, status = 200) => Response.json(value, { status, headers: {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'} });
export const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)).toString('hex');
export const cleanError = error => String(error?.message ?? error)
  .replace(/https?:\/\/\S+/g, '[URL]')
  .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi,'[token]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
  .replace(/\b((?:api[_-]?key|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|(?:client[_-]?)?secret|password|authorization))\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,'$1=[redacted]')
  .slice(0, 400);
export async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.subtle.timingSafeEqual(await crypto.subtle.digest('SHA-256',encoder.encode(a)), await crypto.subtle.digest('SHA-256',encoder.encode(b)));
}
export async function bounded(response, cap = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > cap) throw new Error('Response too large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const {done,value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > cap) { await reader.cancel(); throw new Error('Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
export async function put(env, prefix, name, value, contentType) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  if (bytes.byteLength > 12*1024*1024) throw new Error('Artifact exceeds 12 MiB');
  const key = `${prefix}/${name}`;
  const digest = await sha(bytes);
  await env.ARCHIVE.put(key, bytes, {httpMetadata:{contentType},customMetadata:{sha256:digest}});
  return {key,name,bytes:bytes.byteLength,sha256:digest,contentType};
}
export function fileKind(bytes) {
  const h = Buffer.from(bytes.subarray(0,8)).toString('hex');
  if (h.startsWith('255044462d')) return 'pdf';
  if (h === 'd0cf11e0a1b11ae1') return 'ole';
  if (h.startsWith('504b0304') || h.startsWith('504b0506')) return 'zip';
  if (h.startsWith('526172211a07')) return 'rar';
  if (h.startsWith('377abcaf271c')) return '7z';
  return null;
}
export function normalizedDate(value) {
  const m = String(value??'').match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})/);
  if (!m) return null;
  const date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().startsWith(date) ? date : null;
}
export function cutoffDate(now = Date.now()) { return new Date(now - 30*86400000).toISOString().slice(0,10); }
export const articleId = async url => (await sha(url)).slice(0,24);
export async function reserveBudget(env, kind, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid daily budget');
  const day = new Date().toISOString().slice(0,10);
  await env.DB.prepare('INSERT OR IGNORE INTO usage(day,kind,used) VALUES (?,?,0)').bind(day,kind).run();
  const row = await env.DB.prepare('UPDATE usage SET used=used+1 WHERE day=? AND kind=? AND (?=0 OR used<?) RETURNING used').bind(day,kind,limit,limit).first();
  if (!row) throw new Error(`${kind} daily budget reached (${limit})`);
  return row.used;
}
