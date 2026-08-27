import { createHash } from 'node:crypto';

/** OpenSSH-style key fingerprint: `SHA256:<base64 without padding>`. */
export function sha256Fingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function normalizeHostport(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}
