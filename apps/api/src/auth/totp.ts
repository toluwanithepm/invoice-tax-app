import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the variant every authenticator app supports. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32-encoded. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

/** Accepts the current code and one step either side, for clock drift. */
export function verifyTotp(secret: string, code: string, timeMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const given = Buffer.from(code);
  return [-1, 0, 1].some((w) => timingSafeEqual(Buffer.from(totpAt(secret, timeMs + w * STEP_SECONDS * 1000)), given));
}

export function totpUri(secret: string, label: string, issuer: string): string {
  const l = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${l}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
