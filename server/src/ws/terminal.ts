import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import type { User } from '../db/schema.js';
import { AuditLog } from '../audit.js';
import { ConnectionRepo } from '../connections/repo.js';
import { SshSession } from '../ssh/client.js';
import { LocalSession } from '../ssh/local.js';
import type { TerminalBackend } from '../ssh/backend.js';
import { makeHostKeyVerifier, type HostKeyPrompt } from '../ssh/hostkeys.js';
import { clientMessage, encodeServer, type ServerMessage } from './protocol.js';
import { SID_COOKIE } from '../auth/session.js';

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
    if (first) return first.trim();
  }
  return req.socket.remoteAddress ?? undefined;
}

export function attachTerminalWs(server: HttpServer, ctx: AppContext): () => void {
  const { config, log } = ctx;
  const wss = new WebSocketServer({ noServer: true });
  const wsPath = `${config.base === '/' ? '' : config.base}/ws/terminal`;
  const repo = new ConnectionRepo(ctx.db, config.appSecret);
  const audit = new AuditLog(ctx.db);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== wsPath) return; // let other upgrade handlers have it

    const sid = parseCookies(req.headers.cookie)[SID_COOKIE];
    ctx.sessions
      .resolve(sid)
      .then((resolved) => {
        if (!resolved) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          new TerminalBridge(ws, req, ctx, repo, audit, resolved.user).start();
        });
      })
      .catch((err) => {
        log.error({ err }, 'ws upgrade auth failed');
        socket.destroy();
      });
  };

  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    wss.close();
  };
}

class TerminalBridge {
  private backend: TerminalBackend | null = null;
  private auditId: string | null = null;
  private bytesIn = 0;
  private bytesOut = 0;
  private opened = false;
  private finished = false;
  private pendingHostKey: ((accept: boolean) => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly req: IncomingMessage,
    private readonly ctx: AppContext,
    private readonly repo: ConnectionRepo,
    private readonly audit: AuditLog,
    private readonly user: User,
  ) {}

  start(): void {
    this.ws.binaryType = 'nodebuffer';
    this.send({ t: 'status', state: 'connecting' });
    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on('close', () => this.teardown('websocket closed'));
    this.ws.on('error', () => this.teardown('websocket error'));
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeServer(msg));
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.bytesIn += buf.length;
      this.bumpIdle();
      this.backend?.write(buf);
      return;
    }

    let parsed;
    try {
      parsed = clientMessage.parse(JSON.parse(data.toString()));
    } catch {
      this.send({ t: 'error', message: 'invalid control message' });
      return;
    }

    switch (parsed.t) {
      case 'ping':
        this.send({ t: 'pong' });
        return;
      case 'resize':
        this.backend?.resize(parsed.cols, parsed.rows);
        return;
      case 'hostkey':
        this.pendingHostKey?.(parsed.accept);
        this.pendingHostKey = null;
        return;
      case 'open':
        if (this.opened) return;
        this.opened = true;
        await this.open(parsed);
        return;
    }
  }

  private async open(msg: Extract<import('./protocol.js').ClientMessage, { t: 'open' }>): Promise<void> {
    const { config } = this.ctx;

    let target: {
      host: string;
      port: number;
      username: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      command?: string;
      connectionId?: string;
    };

    // WeTTY-style local shell: `anterm --ssh-host localhost` (no --force-ssh),
    // opened without a saved connection or ad-hoc override.
    if (!msg.connectionId && !msg.adhoc && config.localShell) {
      this.startLocalShell(msg);
      return;
    }

    try {
      if (msg.connectionId) {
        const conn = await this.repo.get(this.user.id, msg.connectionId);
        if (!conn) {
          this.fail('connection not found');
          return;
        }
        target = {
          host: conn.host,
          port: conn.port,
          username: conn.sshUsername,
          command: conn.initCommand ?? config.ssh.command,
          connectionId: conn.id,
          ...this.repo.resolveSecrets(conn),
        };
      } else if (msg.adhoc) {
        if (!config.adhocEnabled) {
          this.fail('ad-hoc SSH is disabled on this server');
          return;
        }
        target = {
          host: msg.adhoc.host,
          port: msg.adhoc.port,
          username: msg.adhoc.username,
          password: msg.adhoc.password,
          privateKey: msg.adhoc.privateKey,
          passphrase: msg.adhoc.passphrase,
          command: config.ssh.command,
        };
      } else if (config.adhocEnabled && config.ssh.host) {
        if (!config.ssh.user) {
          this.fail('server ad-hoc mode has no default SSH user configured');
          return;
        }
        target = {
          host: config.ssh.host,
          port: config.ssh.port,
          username: config.ssh.user,
          command: config.ssh.command,
        };
      } else {
        this.fail('no connection specified');
        return;
      }
    } catch (err) {
      this.fail(`failed to resolve connection: ${(err as Error).message}`);
      return;
    }

    if (!this.hostAllowed(target.host)) {
      this.fail(`host not allowed: ${target.host}`);
      return;
    }

    const prompt: HostKeyPrompt = (info) =>
      new Promise<boolean>((resolve) => {
        this.pendingHostKey = resolve;
        this.send({
          t: 'hostkey-prompt',
          hostport: info.hostport,
          status: info.status === 'known' ? 'unknown' : info.status,
          keyType: info.keyType,
          fingerprint: info.fingerprint,
          knownFingerprint: info.knownFingerprint,
        });
      });

    const verifyHostKey = makeHostKeyVerifier(this.ctx.db, this.user.id, prompt);

    const ssh = new SshSession({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      passphrase: target.passphrase,
      command: target.command,
      cols: msg.cols,
      rows: msg.rows,
      verifyHostKey,
    });
    this.wireBackend(ssh, `${target.username}@${target.host}:${target.port}`, target.connectionId);
    ssh.connect();
  }

  private startLocalShell(msg: Extract<import('./protocol.js').ClientMessage, { t: 'open' }>): void {
    const local = new LocalSession({
      command: this.ctx.config.ssh.command,
      cols: msg.cols,
      rows: msg.rows,
    });
    this.wireBackend(local, `local:${process.env.SHELL ?? 'shell'}`);
    local.connect();
  }

  private wireBackend(backend: TerminalBackend, auditTarget: string, connectionId?: string): void {
    this.backend = backend;

    backend.on('ready', () => {
      void this.audit
        .open({
          userId: this.user.id,
          connectionId,
          target: auditTarget,
          clientIp: clientIp(this.req, this.ctx.config.trustProxy),
        })
        .then((id) => {
          this.auditId = id;
        });
      this.send({ t: 'status', state: 'ready' });
      this.armTimers();
    });

    backend.on('data', (chunk) => {
      this.bytesOut += chunk.length;
      this.bumpIdle();
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(chunk, { binary: true });
    });

    backend.on('error', (err) => {
      this.ctx.log.info({ err: err.message, target: auditTarget }, 'terminal backend error');
      this.send({ t: 'error', message: err.message });
    });

    backend.on('close', (info) => {
      this.send({ t: 'status', state: 'closed', detail: info.reason });
      this.teardown(info.reason);
    });
  }

  private hostAllowed(host: string): boolean {
    const list = this.ctx.config.allowHosts;
    if (!list.length) return true;
    return list.includes(host.toLowerCase());
  }

  private armTimers(): void {
    const { sshMaxDurationMin } = this.ctx.config;
    if (sshMaxDurationMin > 0) {
      this.maxTimer = setTimeout(
        () => this.backend?.close('max session duration reached'),
        sshMaxDurationMin * 60_000,
      );
    }
    this.bumpIdle();
  }

  private bumpIdle(): void {
    const mins = this.ctx.config.sshIdleTimeoutMin;
    if (mins <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.backend?.close('idle timeout'), mins * 60_000);
  }

  private fail(message: string): void {
    this.send({ t: 'error', message });
    this.send({ t: 'status', state: 'closed', detail: message });
    this.teardown(message);
  }

  private teardown(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.pendingHostKey?.(false);
    this.pendingHostKey = null;
    try {
      this.backend?.close(reason);
    } catch {
      /* ignore */
    }
    if (this.auditId) {
      void this.audit.close(this.auditId, {
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
        exitReason: reason,
      });
      this.auditId = null;
    }
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
