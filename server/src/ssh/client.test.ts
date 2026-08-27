import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';
import { SshSession } from './client.js';

let fx: SshFixture;
beforeAll(async () => {
  fx = await startSshFixture();
});
afterAll(async () => {
  await fx.close();
});

function trustAll() {
  return async () => true;
}

describe('SshSession', () => {
  it('authenticates and runs a command', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const ssh = new SshSession({
        host: fx.host,
        port: fx.port,
        username: fx.username,
        password: fx.password,
        command: 'echo hello-anterm',
        verifyHostKey: trustAll(),
      });
      ssh.on('data', (d) => (buf += d.toString()));
      ssh.on('close', () => resolve(buf));
      ssh.on('error', reject);
      ssh.connect();
    });
    expect(out).toContain('hello-anterm');
  });

  it('rejects a bad password', async () => {
    const err = await new Promise<Error>((resolve) => {
      const ssh = new SshSession({
        host: fx.host,
        port: fx.port,
        username: fx.username,
        password: 'wrong',
        command: 'true',
        verifyHostKey: trustAll(),
      });
      ssh.on('error', resolve);
      ssh.on('close', (i) => resolve(new Error(i.reason)));
      ssh.connect();
    });
    expect(err.message.toLowerCase()).toMatch(/auth|denied|fail/);
  });

  it('aborts when the host key is not trusted', async () => {
    const reason = await new Promise<string>((resolve) => {
      const ssh = new SshSession({
        host: fx.host,
        port: fx.port,
        username: fx.username,
        password: fx.password,
        command: 'true',
        verifyHostKey: async () => false,
      });
      ssh.on('close', (i) => resolve(i.reason));
      ssh.on('error', (e) => resolve(e.message));
      ssh.connect();
    });
    expect(reason.toLowerCase()).toMatch(/host|key|verification/);
  });

  it('delivers an interactive shell and accepts resize', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const ssh = new SshSession({
        host: fx.host,
        port: fx.port,
        username: fx.username,
        password: fx.password,
        cols: 80,
        rows: 24,
        verifyHostKey: trustAll(),
      });
      ssh.on('ready', () => {
        ssh.resize(120, 40);
        ssh.write('echo shell-ok\n');
        setTimeout(() => ssh.close('done'), 1000);
      });
      ssh.on('data', (d) => (buf += d.toString()));
      ssh.on('close', () => resolve(buf));
      ssh.on('error', reject);
      ssh.connect();
    });
    expect(out).toContain('shell-ok');
  });
});
