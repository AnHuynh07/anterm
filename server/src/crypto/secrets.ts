import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';

/**
 * Symmetric secret storage for SSH credentials.
 *
 * Format (base64):  v1 . <iv(12)> . <authTag(16)> . <ciphertext>
 * Key is derived from the app secret with scrypt + a fixed app salt so the same
 * secret always yields the same key (no per-value salt needed; IV provides
 * uniqueness). If the app secret is lost, stored credentials are unrecoverable.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;
let cachedFrom: string | null = null;

function deriveKey(appSecret: string): Buffer {
  if (cachedKey && cachedFrom === appSecret) return cachedKey;
  const salt = createHmac('sha256', 'anterm.secret.kdf.v1').update(appSecret).digest();
  cachedKey = scryptSync(appSecret, salt, 32);
  cachedFrom = appSecret;
  return cachedKey;
}

export function encryptSecret(plain: string, appSecret: string): string {
  const key = deriveKey(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string, appSecret: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('malformed secret payload');
  }
  const key = deriveKey(appSecret);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function maybeDecrypt(payload: string | null | undefined, appSecret: string): string | undefined {
  if (!payload) return undefined;
  return decryptSecret(payload, appSecret);
}
