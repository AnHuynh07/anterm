import { describe, expect, it, vi } from 'vitest';
import { AutoLogin, type AutoLoginConfig } from './autologin.js';

function harness(cfg: Partial<AutoLoginConfig> = {}) {
  const sent: string[] = [];
  const secrets: string[] = [];
  const auto = new AutoLogin(
    { setupCommands: [], ...cfg },
    (s) => sent.push(s),
    (s) => secrets.push(s),
  );
  const feed = (s: string) => auto.feed(Buffer.from(s));
  return { auto, sent, secrets, feed };
}

describe('AutoLogin', () => {
  it('answers username then password then runs setup commands', async () => {
    const h = harness({
      loginUsername: 'netadmin',
      loginPassword: 's3cret',
      setupCommands: ['terminal length 0', 'terminal width 0'],
    });
    h.feed('\r\nUser Access Verification\r\n\r\nUsername: ');
    expect(h.sent).toEqual(['netadmin\r']);
    h.feed('netadmin\r\nPassword: ');
    expect(h.sent).toEqual(['netadmin\r', 's3cret\r']);
    expect(h.secrets).toEqual(['s3cret']);
    h.feed('\r\nsw1>');
    // ready prompt -> setup commands (paced via timers)
    await vi.waitFor(() => expect(h.sent).toContain('terminal length 0\r'));
    await vi.waitFor(() => expect(h.sent).toContain('terminal width 0\r'));
    await vi.waitFor(() => expect(h.auto.done).toBe(true));
  });

  it('handles a prompt split across chunks', () => {
    const h = harness({ loginUsername: 'x', loginPassword: 'y' });
    h.feed('Userna');
    h.feed('me: ');
    expect(h.sent).toEqual(['x\r']);
    h.feed('Pass');
    h.feed('word: ');
    expect(h.sent).toEqual(['x\r', 'y\r']);
  });

  it('enters enable mode when an enable password is set', async () => {
    const h = harness({
      loginUsername: 'a',
      loginPassword: 'b',
      enablePassword: 'en4ble',
      setupCommands: ['show version'],
    });
    h.feed('Username: ');
    h.feed('Password: ');
    h.feed('\r\nsw1>'); // user-exec -> send `enable`
    expect(h.sent).toContain('enable\r');
    h.feed('\r\nPassword: '); // enable password prompt
    expect(h.sent).toContain('en4ble\r');
    expect(h.secrets).toContain('en4ble');
    h.feed('\r\nsw1#'); // priv-exec -> setup
    await vi.waitFor(() => expect(h.sent).toContain('show version\r'));
  });

  it('does not resend when the device repeats the prompt (bad credentials)', () => {
    const h = harness({ loginUsername: 'a', loginPassword: 'bad' });
    h.feed('Username: ');
    h.feed('a\r\nPassword: ');
    h.feed('\r\n% Login invalid\r\n\r\nUsername: '); // repeats, but we're past that state
    expect(h.sent).toEqual(['a\r', 'bad\r']);
  });

  it('strips ANSI before matching', () => {
    const h = harness({ loginUsername: 'a', loginPassword: 'b' });
    h.feed('\x1b[2J\x1b[HUsername: \x1b[0m');
    expect(h.sent).toEqual(['a\r']);
  });

  it('is a no-op when nothing is configured', () => {
    const h = harness({});
    h.feed('Username: ');
    h.feed('Password: ');
    expect(h.sent).toEqual([]);
  });

  it('runs setup commands even without a login (key auth straight to shell)', async () => {
    const h = harness({ setupCommands: ['export PAGER=cat'] });
    h.feed('user@host:~$ ');
    await vi.waitFor(() => expect(h.sent).toContain('export PAGER=cat\r'));
  });
});
