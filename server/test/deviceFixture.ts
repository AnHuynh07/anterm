import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';

const { Server } = ssh2;

export interface DeviceFixture {
  port: number;
  host: string;
  sshUser: string;
  sshPass: string;
  loginUser: string;
  loginPass: string;
  enablePass: string;
  close: () => Promise<void>;
}

/**
 * In-process SSH server that behaves like a network device: SSH transport auth
 * succeeds, then the *session* presents `Username:` / `Password:` and an
 * `enable` flow before dropping to a `sw1#` prompt. Used to test AnTerm's
 * in-band login automation.
 */
export async function startDeviceFixture(
  opts?: Partial<Omit<DeviceFixture, 'host' | 'close'>>,
): Promise<DeviceFixture> {
  const sshUser = opts?.sshUser ?? 'svc';
  const sshPass = opts?.sshPass ?? 'svc';
  const loginUser = opts?.loginUser ?? 'netadmin';
  const loginPass = opts?.loginPass ?? 'l0gin';
  const enablePass = opts?.enablePass ?? 'en4ble';

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === sshUser && ctx.password === sshPass) return ctx.accept();
      return ctx.reject(['password'], false);
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (a) => a?.());
        session.on('window-change', (a) => a?.());
        session.on('shell', (accept) => {
          const stream = accept();
          let stage: 'user' | 'pass' | 'exec' | 'enable-pass' | 'priv' = 'user';
          let line = '';

          stream.write('\r\nUser Access Verification\r\n\r\nUsername: ');

          stream.on('data', (buf: Buffer) => {
            for (const ch of buf.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                const input = line;
                line = '';
                handleLine(input);
              } else if (ch === '\x7f' || ch === '\b') {
                line = line.slice(0, -1);
              } else {
                line += ch;
              }
            }
          });

          function handleLine(input: string) {
            switch (stage) {
              case 'user':
                stage = input === loginUser ? 'pass' : 'user';
                stream.write(input === loginUser ? '\r\nPassword: ' : '\r\n% Access denied\r\n\r\nUsername: ');
                return;
              case 'pass':
                if (input === loginPass) {
                  stage = 'exec';
                  stream.write('\r\nsw1>');
                } else {
                  stage = 'user';
                  stream.write('\r\n% Login invalid\r\n\r\nUsername: ');
                }
                return;
              case 'exec':
                if (input.trim() === 'enable') {
                  stage = 'enable-pass';
                  stream.write('\r\nPassword: ');
                } else {
                  stream.write(`\r\n${runCommand(input)}\r\nsw1>`);
                }
                return;
              case 'enable-pass':
                stage = input === enablePass ? 'priv' : 'exec';
                stream.write(input === enablePass ? '\r\nsw1#' : '\r\n% Bad secrets\r\nsw1>');
                return;
              case 'priv':
                stream.write(`\r\n${runCommand(input)}\r\nsw1#`);
                return;
            }
          }

          function runCommand(cmd: string): string {
            const c = cmd.trim();
            if (c === '') return '';
            if (/^show version/.test(c)) return 'Cisco IOS Software, Version 15.2(4)E, sw1 uptime is 3 weeks';
            if (/^terminal (length|width)/.test(c)) return '';
            if (/^show ip int/.test(c)) return 'Gi0/1  up  up\r\nGi0/2  down down';
            return `% Unknown command: ${c}`;
          }
        });
      });
    });

    client.on('error', () => {
      /* ignore */
    });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  return {
    port,
    host: '127.0.0.1',
    sshUser,
    sshPass,
    loginUser,
    loginPass,
    enablePass,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
