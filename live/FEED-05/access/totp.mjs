import { createHmac } from 'node:crypto';

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function parseTotpUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:' || url.host.toLowerCase() !== 'totp') throw new Error('Unsupported TOTP URI type');
  const secret = url.searchParams.get('secret') ?? '';
  if (!/^[A-Z2-7]+=*$/i.test(secret)) throw new Error('Invalid TOTP secret encoding');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  if (![6, 8].includes(digits) || ![15, 30, 60].includes(period)) throw new Error('Unsupported TOTP parameters');
  return { secret: secret.toUpperCase().replace(/=+$/, ''), digits, period };
}

function base32Decode(value) {
  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const character of value.replace(/=+$/, '')) {
    const index = base32Alphabet.indexOf(character.toUpperCase());
    if (index < 0) throw new Error('Invalid Base32 character');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function totp(uri, timestamp = Date.now()) {
  const { secret, digits, period } = parseTotpUri(uri);
  const counter = Math.floor(timestamp / 1000 / period);
  let value = BigInt(counter);
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const digest = createHmac('sha1', base32Decode(secret)).update(bytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest[offset] & 0x7f) * 0x1000000 + digest[offset + 1] * 0x10000
    + digest[offset + 2] * 0x100 + digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}
