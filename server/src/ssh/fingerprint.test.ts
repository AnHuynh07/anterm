import { describe, expect, it } from 'vitest';
import { normalizeHostport, sha256Fingerprint } from './fingerprint.js';

describe('fingerprint', () => {
  it('formats an OpenSSH-style SHA256 fingerprint', () => {
    const fp = sha256Fingerprint(Buffer.from('hello world'));
    expect(fp.startsWith('SHA256:')).toBe(true);
    expect(fp).not.toMatch(/=+$/); // padding stripped
    expect(fp).toBe(sha256Fingerprint(Buffer.from('hello world'))); // deterministic
    expect(fp).not.toBe(sha256Fingerprint(Buffer.from('other')));
  });

  it('lower-cases the host in hostport', () => {
    expect(normalizeHostport('Example.COM', 22)).toBe('example.com:22');
  });
});
