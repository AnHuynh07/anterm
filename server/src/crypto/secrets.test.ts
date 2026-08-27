import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maybeDecrypt } from './secrets.js';

const SECRET = 'test-app-secret-test-app-secret-01';

describe('secrets', () => {
  it('round-trips a value', () => {
    const enc = encryptSecret('hunter2', SECRET);
    expect(enc).not.toContain('hunter2');
    expect(decryptSecret(enc, SECRET)).toBe('hunter2');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptSecret('x', SECRET)).not.toBe(encryptSecret('x', SECRET));
  });

  it('fails to decrypt with the wrong secret', () => {
    const enc = encryptSecret('x', SECRET);
    expect(() => decryptSecret(enc, 'a-different-secret-of-sufficient-len')).toThrow();
  });

  it('rejects a tampered payload', () => {
    const enc = encryptSecret('x', SECRET).split('.');
    enc[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(enc.join('.'), SECRET)).toThrow();
  });

  it('maybeDecrypt passes through nullish', () => {
    expect(maybeDecrypt(null, SECRET)).toBeUndefined();
    expect(maybeDecrypt(undefined, SECRET)).toBeUndefined();
  });
});
