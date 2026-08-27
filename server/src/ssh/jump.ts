import type { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import { sha256Fingerprint } from './fingerprint.js';
import { detectKeyType, type HostKeyVerifier } from './client.js';

export interface JumpHop {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  verifyHostKey: HostKeyVerifier;
}

export interface JumpResult {
  /** a transport socket to the final host, tunnelled through every hop */
  sock: Duplex;
  /** tear down all bastion clients (call when the session ends) */
  dispose: () => void;
}

/**
 * Dial each bastion in `hops` in order, tunnelling every connection through the
 * previous one (`ProxyJump` / `ssh -J`). Resolves with a socket that reaches
 * `finalHost:finalPort` from the last hop — hand it to `SshSession({ sock })`.
 */
export function dialThroughJumps(hops: JumpHop[], finalHost: string, finalPort: number): Promise<JumpResult> {
  return new Promise((resolve, reject) => {
    const clients: Client[] = [];
    let settled = false;
    const dispose = () => {
      for (const c of clients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      dispose();
      reject(err);
    };

    const step = (i: number, viaSock: Duplex | undefined): void => {
      const hop = hops[i]!;
      const client = new Client();
      clients.push(client);

      client.on('error', (err) => fail(new Error(`${hop.host}:${hop.port} — ${err.message}`)));
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) =>
        finish(prompts.map((p) => (/password/i.test(p.prompt) && hop.password ? hop.password : ''))),
      );
      client.on('ready', () => {
        const last = i + 1 >= hops.length;
        const nextHost = last ? finalHost : hops[i + 1]!.host;
        const nextPort = last ? finalPort : hops[i + 1]!.port;
        client.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (err) return fail(new Error(`tunnel via ${hop.host} to ${nextHost}:${nextPort} — ${err.message}`));
          if (last) {
            if (settled) {
              stream.destroy();
              return;
            }
            settled = true;
            resolve({ sock: stream, dispose });
          } else {
            step(i + 1, stream);
          }
        });
      });

      client.connect({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        ...(viaSock ? { sock: viaSock } : {}),
        ...(hop.password ? { password: hop.password, tryKeyboard: true } : {}),
        ...(hop.privateKey ? { privateKey: hop.privateKey, passphrase: hop.passphrase } : {}),
        ...(!hop.password && !hop.privateKey ? { agent: process.env.SSH_AUTH_SOCK } : {}),
        readyTimeout: 20_000,
        keepaliveInterval: 20_000,
        hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => {
          hop
            .verifyHostKey({
              hostport: `${hop.host.toLowerCase()}:${hop.port}`,
              keyType: detectKeyType(key),
              fingerprint: sha256Fingerprint(key),
            })
            .then((ok) => cb(ok))
            .catch(() => cb(false));
        },
      });
    };

    step(0, undefined);
  });
}
