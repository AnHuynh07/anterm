import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { sha256Fingerprint } from './fingerprint.js';
import type { CloseInfo, TerminalBackend } from './backend.js';

export interface HostKeyInfo {
  hostport: string;
  keyType: string;
  fingerprint: string;
}

/** Return true to trust the presented host key, false to abort the connection. */
export type HostKeyVerifier = (info: HostKeyInfo) => Promise<boolean>;

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  command?: string;
  term?: string;
  cols?: number;
  rows?: number;
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  verifyHostKey: HostKeyVerifier;
  /** pre-established transport (e.g. a forwardOut stream from a jump host) */
  sock?: Duplex;
}

export type SshCloseInfo = CloseInfo;

interface SshEvents {
  ready: () => void;
  data: (chunk: Buffer) => void;
  close: (info: CloseInfo) => void;
  error: (err: Error) => void;
}

/**
 * One interactive SSH channel. Wraps ssh2's Client + shell/exec stream into a
 * small EventEmitter the WebSocket layer can pump bytes through.
 */
export class SshSession extends EventEmitter implements TerminalBackend {
  override on<E extends keyof SshEvents>(event: E, listener: SshEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof SshEvents>(event: E, ...args: Parameters<SshEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  private client: Client | null = null;
  private channel: ClientChannel | null = null;
  private closed = false;
  private closeReason = 'closed';

  constructor(private readonly opts: SshConnectOptions) {
    super();
  }

  connect(): void {
    const client = new Client();
    this.client = client;

    const config: ConnectConfig = {
      host: this.opts.host,
      port: this.opts.port,
      username: this.opts.username,
      ...(this.opts.sock ? { sock: this.opts.sock } : {}),
      readyTimeout: this.opts.readyTimeoutMs ?? 20_000,
      keepaliveInterval: this.opts.keepaliveIntervalMs ?? 20_000,
      keepaliveCountMax: 3,
      tryKeyboard: Boolean(this.opts.password),
      hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => {
        const info: HostKeyInfo = {
          hostport: `${this.opts.host.toLowerCase()}:${this.opts.port}`,
          keyType: detectKeyType(key),
          fingerprint: sha256Fingerprint(key),
        };
        this.opts
          .verifyHostKey(info)
          .then((ok) => cb(ok))
          .catch((err) => {
            this.closeReason = `host key check failed: ${(err as Error).message}`;
            cb(false);
          });
      },
    };

    if (this.opts.password) config.password = this.opts.password;
    if (this.opts.privateKey) {
      config.privateKey = this.opts.privateKey;
      if (this.opts.passphrase) config.passphrase = this.opts.passphrase;
    }
    if (!config.password && !config.privateKey) config.agent = process.env.SSH_AUTH_SOCK;

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      // Answer password-style prompts with the supplied password; blank otherwise.
      finish(prompts.map((p) => (/password/i.test(p.prompt) && this.opts.password ? this.opts.password : '')));
    });

    client.on('ready', () => {
      const onChannel = (err: Error | undefined, channel: ClientChannel) => {
        if (err) {
          this.fail(err);
          return;
        }
        this.channel = channel;
        channel.on('data', (d: Buffer) => this.emit('data', d));
        channel.stderr?.on('data', (d: Buffer) => this.emit('data', d));
        channel.on('close', (code: number | null, signal: string | null) => {
          this.finish(code ?? null, signal ?? null);
        });
        this.emit('ready');
      };

      const window = {
        rows: this.opts.rows ?? 24,
        cols: this.opts.cols ?? 80,
        height: 480,
        width: 640,
        term: this.opts.term ?? 'xterm-256color',
      };

      if (this.opts.command) {
        client.exec(this.opts.command, { pty: window }, onChannel);
      } else {
        client.shell(window, onChannel);
      }
    });

    client.on('error', (err) => this.fail(err));
    client.on('close', () => this.finish(null, null));
    client.on('end', () => {
      this.closeReason = 'remote closed connection';
    });

    client.connect(config);
  }

  write(data: Buffer | string): void {
    this.channel?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.channel?.setWindow(rows, cols, Math.max(rows * 20, 240), Math.max(cols * 8, 240));
  }

  close(reason = 'client disconnected'): void {
    if (this.closed) return;
    this.closeReason = reason;
    this.channel?.close();
    this.client?.end();
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.emit('error', err);
    this.closeReason = err.message;
    this.finish(null, null);
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.client?.end();
    } catch {
      /* ignore */
    }
    this.emit('close', { code, signal, reason: this.closeReason });
  }
}

export function detectKeyType(key: Buffer): string {
  const text = key.toString('utf8', 0, Math.min(key.length, 64));
  const m = text.match(/ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+/);
  if (m) return m[0];
  // binary SSH string: 4-byte length prefix then the type name
  const len = key.readUInt32BE(0);
  if (len > 0 && len < 32 && key.length >= 4 + len) return key.toString('ascii', 4, 4 + len);
  return 'unknown';
}
