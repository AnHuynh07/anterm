import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect as tcpConnect } from 'node:net';
import ssh2, { type Connection } from 'ssh2';

const { Server } = ssh2;

export interface SshFixture {
  port: number;
  host: string;
  username: string;
  password: string;
  close: () => Promise<void>;
}

/**
 * A throwaway in-process SSH server for integration tests. Accepts a single
 * password credential and backs shells/execs with `/bin/sh` (no real PTY, but
 * enough for `echo` round-trips and window-change signalling).
 */
export async function startSshFixture(opts?: {
  username?: string;
  password?: string;
  port?: number;
  /** honour direct-tcpip (forwardOut) requests — needed to act as a jump host */
  allowForward?: boolean;
}): Promise<SshFixture> {
  const username = opts?.username ?? 'demo';
  const password = opts?.password ?? 'demo';

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const server = new Server({ hostKeys: [privateKey] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) return ctx.accept();
      if (ctx.method === 'none') return ctx.reject(['password'], false);
      return ctx.reject(['password'], false);
    });

    client.on('ready', () => {
      if (opts?.allowForward) {
        client.on('tcpip', (accept, reject, info) => {
          const upstream = tcpConnect(info.destPort, info.destIP, () => {
            const channel = accept();
            channel.pipe(upstream).pipe(channel);
          });
          upstream.on('error', () => reject?.());
        });
      }
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept?.());
        session.on('window-change', (accept) => accept?.());

        session.on('shell', (accept) => {
          const stream = accept();
          const sh = spawn('/bin/sh', ['-i'], { env: { ...process.env, PS1: '$ ' } });
          stream.pipe(sh.stdin);
          sh.stdout.pipe(stream);
          sh.stderr.pipe(stream);
          sh.on('exit', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });

        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          const child = spawn('/bin/sh', ['-c', info.command]);
          child.stdout.pipe(stream);
          child.stderr.pipe(stream.stderr);
          child.on('exit', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
      });
    });

    client.on('error', () => {
      /* ignore fixture-side connection errors */
    });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  return {
    port,
    host: '127.0.0.1',
    username,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
