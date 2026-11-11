import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/** 256-bit random token, URL-safe. Used for sessions, share links and invitations. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const hmac = (value: string) =>
  createHmac('sha256', Buffer.from(env().SESSION_SECRET, 'base64')).update(value).digest('hex');
export const randomDigits = (n = 6) => Array.from({ length: n }, () => randomInt(0, 10)).join('');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Field-level encryption (AES-256-GCM) for bank account numbers and 2FA secrets (NFR-6).
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url). The version prefix allows key rotation.
 */
export function encrypt(plain: string): string {
  const key = Buffer.from(env().DATA_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  const key = Buffer.from(env().DATA_ENCRYPTION_KEY, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** RFC 9562 UUIDv7: time-ordered, so new rows index well. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
