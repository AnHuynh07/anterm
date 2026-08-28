import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, totpCode, verifyTotp } from './totp.js';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const s of ['', 'a', 'hello world', '\x00\xff\x10']) {
      const buf = Buffer.from(s, 'binary');
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });
});

describe('TOTP', () => {
  // RFC 6238 test vector: secret "12345678901234567890", SHA-1, T=59s -> ...287082 (6 digits)
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 vector', () => {
    expect(totpCode(rfcSecret, 59_000)).toBe('287082');
    expect(totpCode(rfcSecret, 1_111_111_109_000)).toBe('081804');
  });

  it('verifies the current code and rejects a wrong one', () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
    expect(verifyTotp(secret, 'not-a-code', now)).toBe(false);
  });

  it('accepts a code from the adjacent 30s window (clock skew)', () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBe(false);
  });
});
