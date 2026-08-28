import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { hostKeys, type User } from '../db/schema.js';
import { AuditLog } from '../audit.js';
import { ConnectionRepo } from '../connections/repo.js';
import { CredentialRepo, resolveTarget } from '../connections/credentials.js';
import { ShareRepo } from '../connections/shares.js';
import { connAccess } from '../access.js';
import { SshSession } from '../ssh/client.js';
import { TelnetSession } from '../telnet/session.js';
import { dialThroughJumps } from '../ssh/jump.js';
import { runCommand } from '../ssh/runner.js';
import { LocalSession } from '../ssh/local.js';
import { SnapshotRepo, isConfigSaveCommand } from '../config/snapshots.js';
import type { TerminalBackend } from '../ssh/backend.js';
import { AutoLogin, type AutoLoginConfig } from '../ssh/autologin.js';
import { CommandExtractor, SessionRecorder } from '../ssh/recorder.js';
import { makeHostKeyVerifier, type HostKeyPrompt } from '../ssh/hostkeys.js';
import { clientMessage, encodeServer, type ClientMessage, type ServerMessage } from './protocol.js';
import { SID_COOKIE } from '../auth/session.js';

const RING_MAX = 256 * 1024;

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

interface Deps {
  repo: ConnectionRepo;
  creds: CredentialRepo;
  shares: ShareRepo;
  audit: AuditLog;
}

type OpenMsg = Extract<ClientMessage, { t: 'open' }>;

interface JumpHopSpec {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface Target {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  command?: string;
  connectionId?: string;
  autoLogin?: AutoLoginConfig;
  antiIdleSeconds?: number;
  auditTarget: string;
  local?: boolean;
  telnet?: boolean;
  jumps?: JumpHopSpec[];
  configCommand?: string;
}

/** A running SSH/local session, as shown in the "Running sessions" list. */
export interface LiveSessionSummary {
  token: string;
  connectionId: string | null;
  target: string;
  startedAt: number;
  /** epoch ms since the last client left, or null while someone is attached */
  detachedAt: number | null;
  /** owner-side clients currently attached */
  attached: number;
  observers: number;
  shared: boolean;
}

/**
 * Process-wide table of live sessions. Kept on the AppContext so HTTP routes can
 * list a user's running sessions and let them re-attach from another device.
 */
export class LiveRegistry {
  private map = new Map<string, LiveSession>();

  set(token: string, s: LiveSession): void {
    this.map.set(token, s);
  }
  delete(token: string): void {
    this.map.delete(token);
  }
  get(token: string): LiveSession | undefined {
    return this.map.get(token);
  }
  forUser(userId: string): LiveSessionSummary[] {
    return [...this.map.values()]
      .filter((s) => s.userId === userId && !s.isClosed)
      .map((s) => s.summary())
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  /** Close one of `userId`'s sessions by token. Returns false if not theirs. */
  stopFor(userId: string, token: string): boolean {
    const s = this.map.get(token);
    if (!s || s.userId !== userId || s.isClosed) return false;
    s.close('closed from session list');
    return true;
  }
  closeAll(reason: string): void {
    for (const s of [...this.map.values()]) s.close(reason);
  }
}

export function attachTerminalWs(server: HttpServer, ctx: AppContext): () => void {
  const { config, log } = ctx;
  const wss = new WebSocketServer({ noServer: true });
  const wsPath = `${config.base === '/' ? '' : config.base}/ws/terminal`;
  const deps: Deps = {
    repo: new ConnectionRepo(ctx.db, config.appSecret),
    creds: new CredentialRepo(ctx.db, config.appSecret),
    shares: new ShareRepo(ctx.db),
    audit: new AuditLog(ctx.db),
  };
  const registry = ctx.liveSessions;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== wsPath) return;

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
          new ClientConn(ws, req, ctx, deps, resolved.user, registry).start();
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
    registry.closeAll('server shutdown');
    wss.close();
  };
}

/**
 * An SSH/local session that lives independently of any WebSocket. Clients attach
 * and detach; when the last one leaves, a grace timer keeps the session (and a
 * ring buffer of recent output) alive so a reconnecting client can resume.
 */
class LiveSession {
  readonly token = randomBytes(24).toString('base64url');
  private backend: TerminalBackend | null = null;
  private autoLogin: AutoLogin | null = null;
  readonly redact: string[] = [];
  private recorder: SessionRecorder | null = null;
  private cmdExtractor = new CommandExtractor();
  private pendingCommands: string[] = [];
  private commandCount = 0;
  private cmdFlushTimer: NodeJS.Timeout | null = null;
  private antiIdleTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();

  private auditId: string | null = null;
  private bytesIn = 0;
  private bytesOut = 0;
  private closed = false;
  private ready = false;

  // ring buffer of recent output for resume
  private ring: Buffer[] = [];
  private ringBytes = 0;
  private producedTotal = 0; // monotonic total bytes ever produced
  private detachTotal = 0; // producedTotal at the moment the last client left

  private clients = new Set<ClientConn>();
  private pendingHostKey: ((accept: boolean) => void) | null = null;
  private jumpDispose: (() => void) | null = null;
  private shared = false;
  private sawConfigSave = false;
  private readonly startedAt = Date.now();
  private detachedAt: number | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: Deps,
    private readonly user: User,
    private readonly target: Target,
    private cols: number,
    private rows: number,
    private readonly registry: LiveRegistry,
  ) {
    registry.set(this.token, this);
  }

  get userId(): string {
    return this.user.id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  summary(): LiveSessionSummary {
    const owners = [...this.clients].filter((c) => !c.isObserver).length;
    return {
      token: this.token,
      connectionId: this.target.connectionId ?? null,
      target: this.target.auditTarget,
      startedAt: Math.floor(this.startedAt / 1000),
      detachedAt: this.detachedAt ? Math.floor(this.detachedAt / 1000) : null,
      attached: owners,
      observers: this.clients.size - owners,
      shared: this.shared,
    };
  }

  get isShared(): boolean {
    return this.shared;
  }

  get ownerName(): string {
    return this.user.username;
  }

  setShared(enabled: boolean): void {
    this.shared = enabled;
    this.fanoutPresence();
  }

  private fanoutPresence(): void {
    const viewers = [...this.clients].filter((c) => c.isObserver).map((c) => c.label);
    this.fanoutMsg({ t: 'presence', viewers });
  }

  connect(firstClient: ClientConn): void {
    this.clients.add(firstClient);

    if (this.target.local) {
      const local = new LocalSession({ command: this.target.command, cols: this.cols, rows: this.rows });
      this.wire(local);
      local.connect();
      return;
    }

    const prompt: HostKeyPrompt = (info) =>
      new Promise<boolean>((resolve) => {
        this.pendingHostKey = resolve;
        this.fanoutMsg({
          t: 'hostkey-prompt',
          hostport: info.hostport,
          status: info.status === 'known' ? 'unknown' : info.status,
          keyType: info.keyType,
          fingerprint: info.fingerprint,
          knownFingerprint: info.knownFingerprint,
        });
      });

    const verifier = () =>
      makeHostKeyVerifier(this.ctx.db, this.user.id, prompt, (info) =>
        this.ctx.activity.record({
          actor: { id: this.user.id, name: this.user.username, ip: [...this.clients][0]?.ip ?? null },
          action: info.status === 'changed' ? 'hostkey.changed_accepted' : 'hostkey.trusted',
          target: info.hostport,
          detail: { keyType: info.keyType, fingerprint: info.fingerprint },
        }),
      );

    const start = (sock?: Duplex): void => {
      const backend: TerminalBackend = this.target.telnet
        ? new TelnetSession({
            host: this.target.host,
            port: this.target.port,
            cols: this.cols,
            rows: this.rows,
            socket: sock,
          })
        : new SshSession({
            host: this.target.host,
            port: this.target.port,
            username: this.target.username,
            password: this.target.password,
            privateKey: this.target.privateKey,
            passphrase: this.target.passphrase,
            command: this.target.command,
            cols: this.cols,
            rows: this.rows,
            sock,
            verifyHostKey: verifier(),
          });
      this.wire(backend);
      backend.connect();
    };

    if (this.target.jumps?.length) {
      const hops = this.target.jumps.map((h) => ({ ...h, verifyHostKey: verifier() }));
      dialThroughJumps(hops, this.target.host, this.target.port)
        .then(({ sock, dispose }) => {
          if (this.closed) {
            dispose();
            return;
          }
          this.jumpDispose = dispose;
          start(sock);
        })
        .catch((err) => {
          this.fanoutMsg({ t: 'error', message: `jump host: ${(err as Error).message}` });
          this.close(`jump host failed: ${(err as Error).message}`);
        });
      return;
    }
    start();
  }

  private wire(backend: TerminalBackend): void {
    this.backend = backend;

    backend.on('ready', () => {
      this.ready = true;
      void this.onReady();
      if (this.target.autoLogin) {
        this.autoLogin = new AutoLogin(
          this.target.autoLogin,
          (s) => backend.write(s),
          (s) => this.redact.push(s),
        );
      }
      const ai = this.target.antiIdleSeconds;
      if (ai && ai > 0) this.startAntiIdle(ai * 1000);
      this.armTimers();
      this.fanoutMsg({ t: 'status', state: 'ready' });
    });

    backend.on('data', (chunk) => {
      this.bytesOut += chunk.length;
      this.producedTotal += chunk.length;
      this.lastActivity = Date.now();
      this.bumpIdle();
      this.autoLogin?.feed(chunk);
      this.recorder?.output(chunk);
      this.ring.push(chunk);
      this.ringBytes += chunk.length;
      while (this.ringBytes > RING_MAX && this.ring.length > 1) {
        this.ringBytes -= this.ring.shift()!.length;
      }
      this.fanoutBinary(chunk);
    });

    backend.on('error', (err) => {
      this.ctx.log.info({ err: err.message, target: this.target.auditTarget }, 'terminal backend error');
      this.fanoutMsg({ t: 'error', message: err.message });
    });

    backend.on('close', (info) => this.close(info.reason));
  }

  private async onReady(): Promise<void> {
    const { config } = this.ctx;
    let recordingPath: string | null = null;
    if (config.record) {
      const rel = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.cast`;
      const rec = new SessionRecorder(join(config.recordingsDir, rel), {
        cols: this.cols,
        rows: this.rows,
        title: this.target.auditTarget,
        redact: () => this.redact,
      });
      if (rec.open()) {
        this.recorder = rec;
        recordingPath = rel;
      } else {
        this.ctx.log.warn('could not start session recording (disk?)');
      }
    }
    this.auditId = await this.deps.audit.open({
      userId: this.user.id,
      connectionId: this.target.connectionId,
      target: this.target.auditTarget,
      clientIp: [...this.clients][0]?.ip,
      recordingPath,
    });
    this.flushCommands();
  }

  // ---- client attach / detach ----

  attach(client: ClientConn, cols?: number, rows?: number, fresh = false): void {
    this.clients.add(client);
    this.detachedAt = null;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (cols && rows && (cols !== this.cols || rows !== this.rows)) {
      this.cols = cols;
      this.rows = rows;
      this.backend?.resize(cols, rows);
    }

    // `fresh` (re-attach into a blank terminal, e.g. from another device): replay
    // the whole ring. Otherwise replay only what was produced while every client
    // was away — the reconnecting tab already shows the earlier output.
    const skip = fresh ? 0 : Math.max(0, this.detachTotal - (this.producedTotal - this.ringBytes));
    const replay = Buffer.concat(this.ring).subarray(Math.min(skip, this.ringBytes));
    if (replay.length) client.sendBinary(replay);
    if (this.ready) client.send({ t: 'status', state: 'ready' });
    this.fanoutPresence();
  }

  detach(client: ClientConn): void {
    this.clients.delete(client);
    this.fanoutPresence();
    if (this.closed) return;
    // keep the session alive only while an owner-side client is connected;
    // observers alone must not hold an SSH session open.
    if ([...this.clients].some((c) => !c.isObserver)) return;
    this.detachTotal = this.producedTotal;
    // resume disabled → tear the session down as soon as the last client leaves
    const { resumeGraceSec, durableSessionMin } = this.ctx.config;
    if (resumeGraceSec <= 0) {
      this.close('websocket closed');
      return;
    }
    this.detachedAt = Date.now();
    // a fully-detached session lives for the longer of the quick resume grace and
    // the durable-session window, so it can be re-attached from another device.
    const graceMs = Math.max(resumeGraceSec * 1000, durableSessionMin * 60_000);
    this.graceTimer = setTimeout(
      () => this.close(durableSessionMin > 0 ? 'detached session expired' : 'resume window expired'),
      graceMs,
    );
    this.graceTimer.unref?.();
  }

  // ---- input from a client ----

  write(data: Buffer): void {
    this.bytesIn += data.length;
    this.lastActivity = Date.now();
    this.bumpIdle();
    const cmds = this.cmdExtractor.feed(data);
    if (cmds.length) {
      this.pendingCommands.push(...cmds);
      this.commandCount += cmds.length;
      this.scheduleCommandFlush();
      if (cmds.some(isConfigSaveCommand)) this.sawConfigSave = true;
    }
    this.backend?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.backend?.resize(cols, rows);
  }

  answerHostKey(accept: boolean): void {
    this.pendingHostKey?.(accept);
    this.pendingHostKey = null;
  }

  // ---- fan-out ----

  private fanoutMsg(msg: ServerMessage): void {
    for (const c of this.clients) c.send(msg);
  }
  private fanoutBinary(buf: Buffer): void {
    for (const c of this.clients) c.sendBinary(buf);
  }

  // ---- timers ----

  private startAntiIdle(intervalMs: number): void {
    const period = Math.max(intervalMs, 15_000);
    this.antiIdleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity >= period) {
        try {
          this.backend?.write('\x00');
        } catch {
          /* ignore */
        }
        this.lastActivity = Date.now();
      }
    }, Math.min(period, 30_000));
    this.antiIdleTimer.unref?.();
  }

  private armTimers(): void {
    const { sshMaxDurationMin } = this.ctx.config;
    if (sshMaxDurationMin > 0) {
      this.maxTimer = setTimeout(() => this.close('max session duration reached'), sshMaxDurationMin * 60_000);
      this.maxTimer.unref?.();
    }
    this.bumpIdle();
  }

  private bumpIdle(): void {
    const mins = this.ctx.config.sshIdleTimeoutMin;
    if (mins <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle timeout'), mins * 60_000);
    this.idleTimer.unref?.();
  }

  private scheduleCommandFlush(): void {
    if (this.cmdFlushTimer) return;
    this.cmdFlushTimer = setTimeout(() => {
      this.cmdFlushTimer = null;
      this.flushCommands();
    }, 2000);
  }

  private flushCommands(): void {
    if (!this.auditId || !this.pendingCommands.length) return;
    const texts = this.pendingCommands;
    this.pendingCommands = [];
    void this.deps.audit
      .logCommands({ sessionId: this.auditId, userId: this.user.id, target: this.target.auditTarget, texts })
      .catch((err) => this.ctx.log.warn({ err }, 'command log write failed'));
  }

  // ---- shutdown ----

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.registry.delete(this.token);
    for (const t of [this.idleTimer, this.maxTimer, this.cmdFlushTimer, this.graceTimer]) if (t) clearTimeout(t);
    if (this.antiIdleTimer) clearInterval(this.antiIdleTimer);
    this.autoLogin?.dispose();
    this.recorder?.close();
    this.jumpDispose?.();
    this.pendingHostKey?.(false);
    this.pendingHostKey = null;
    try {
      this.backend?.close(reason);
    } catch {
      /* ignore */
    }
    this.flushCommands();
    const closedAuditId = this.auditId;
    if (this.auditId) {
      void this.deps.audit.close(this.auditId, {
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
        exitReason: reason,
        commandCount: this.commandCount,
      });
      this.auditId = null;
    }
    this.fanoutMsg({ t: 'status', state: 'closed', detail: reason });
    for (const c of this.clients) c.detachFromLive();
    this.clients.clear();

    if (
      this.sawConfigSave &&
      this.target.connectionId &&
      !this.target.local &&
      !this.target.telnet &&
      !this.target.jumps?.length
    ) {
      void this.captureConfigSnapshot('auto-after-save', closedAuditId).catch((err) =>
        this.ctx.log.info({ err: (err as Error).message }, 'auto config snapshot failed'),
      );
    }
  }

  /** Best-effort: reconnect briefly, dump the running config, store a snapshot. */
  async captureConfigSnapshot(
    reason: 'manual' | 'auto-after-save' | 'auto',
    sessionId?: string | null,
    triggeredBy?: string,
  ): Promise<{ changed: boolean; lines: number } | null> {
    const connId = this.target.connectionId;
    if (!connId || this.target.telnet) return null; // snapshots go over a fresh SSH exec
    const cmd = this.target.configCommand || 'show running-config';
    const known = await this.ctx.db.query.hostKeys.findFirst({
      where: eq(hostKeys.hostport, `${this.target.host.toLowerCase()}:${this.target.port}`),
    });
    if (!known) return null;

    const res = await runCommand({
      host: this.target.host,
      port: this.target.port,
      username: this.target.username,
      password: this.target.password,
      privateKey: this.target.privateKey,
      passphrase: this.target.passphrase,
      autoLogin: this.target.autoLogin ?? null,
      command: cmd,
      idleMs: 3500,
      maxMs: 45_000,
      verifyHostKey: async (info) => info.fingerprint === known.fingerprintSha256,
    });
    if (!res.ok || !res.output.trim()) return null;

    const { snapshot, changed } = await new SnapshotRepo(this.ctx.db).create({
      connectionId: connId,
      userId: triggeredBy ?? this.user.id,
      sessionId: sessionId ?? null,
      reason,
      content: res.output,
    });
    this.ctx.activity.record({
      actor: { id: triggeredBy ?? this.user.id, name: this.user.username },
      action: 'connection.config_snapshot',
      target: this.target.auditTarget,
      detail: { reason, changed, lines: snapshot.lines },
    });
    return { changed, lines: snapshot.lines };
  }
}

/** One WebSocket client, attached to at most one LiveSession. */
class ClientConn {
  readonly ip?: string;
  private live: LiveSession | null = null;
  private handledOpen = false;
  /** true when attached to someone else's shared session (read-only) */
  observer = false;

  constructor(
    private readonly ws: WebSocket,
    req: IncomingMessage,
    private readonly ctx: AppContext,
    private readonly deps: Deps,
    private readonly user: User,
    private readonly registry: LiveRegistry,
  ) {
    this.ip = clientIp(req, ctx.config.trustProxy);
  }

  get isObserver(): boolean {
    return this.observer;
  }
  get label(): string {
    return this.user.username;
  }

  start(): void {
    this.ws.binaryType = 'nodebuffer';
    this.send({ t: 'status', state: 'connecting' });
    this.ws.on('message', (data, isBinary) => void this.onMessage(data, isBinary));
    this.ws.on('close', () => this.onWsClose());
    this.ws.on('error', () => this.onWsClose());
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeServer(msg));
  }
  sendBinary(buf: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf, { binary: true });
  }

  /** Called by LiveSession when it closes. */
  detachFromLive(): void {
    this.live = null;
  }

  private onWsClose(): void {
    this.live?.detach(this);
    this.live = null;
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      if (this.observer) return; // shared viewers are read-only
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.live?.write(buf);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = clientMessage.parse(JSON.parse(data.toString()));
    } catch {
      this.send({ t: 'error', message: 'invalid control message' });
      return;
    }

    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong' });
        return;
      case 'resize':
        if (!this.observer) this.live?.resize(msg.cols, msg.rows);
        return;
      case 'hostkey':
        if (!this.observer) this.live?.answerHostKey(msg.accept);
        return;
      case 'share':
        if (this.live && this.live.userId === this.user.id) this.live.setShared(msg.enabled);
        return;
      case 'attach': {
        const live = this.registry.get(msg.token);
        if (!live) {
          this.send({ t: 'status', state: 'closed', detail: 'session no longer available' });
          return;
        }
        const owner = live.userId === this.user.id;
        if (!owner && !live.isShared) {
          this.send({ t: 'status', state: 'closed', detail: 'this session is not shared' });
          return;
        }
        this.live = live;
        this.observer = !owner;
        live.attach(
          this,
          this.observer ? undefined : msg.cols,
          this.observer ? undefined : msg.rows,
          !this.observer && msg.fresh === true,
        );
        this.send({
          t: 'attached',
          token: live.token,
          resumed: true,
          readOnly: this.observer || undefined,
          owner: this.observer ? live.ownerName : undefined,
        });
        return;
      }
      case 'open':
        if (this.handledOpen) return;
        this.handledOpen = true;
        await this.open(msg);
        return;
    }
  }

  private fail(message: string): void {
    this.send({ t: 'error', message });
    this.send({ t: 'status', state: 'closed', detail: message });
  }

  private async open(msg: OpenMsg): Promise<void> {
    const { config } = this.ctx;
    let target: Target;

    if (this.user.role === 'viewer') {
      return this.fail('your account is read-only and cannot open terminal sessions');
    }

    try {
      if (!msg.connectionId && !msg.adhoc && config.localShell) {
        target = {
          host: 'localhost',
          port: 0,
          username: '',
          command: config.ssh.command,
          local: true,
          auditTarget: `local:${process.env.SHELL ?? 'shell'}`,
        };
      } else if (msg.connectionId) {
        const conn = await this.deps.repo.getAny(msg.connectionId);
        if (!conn) return this.fail('connection not found');
        const share =
          this.user.role === 'admin' || conn.userId === this.user.id
            ? null
            : ((await this.deps.shares.getFor(conn.id, this.user.id)) ?? null);
        if (!connAccess(this.user, conn.userId, share).canOpen) {
          return this.fail('you do not have access to open this connection');
        }
        const isTelnet = conn.protocol === 'telnet';
        if (isTelnet && !config.allowTelnet) {
          return this.fail('Telnet connections are disabled on this server (enable with --allow-telnet)');
        }
        // credentials always resolve on the owner's behalf — a shared user never sees them
        const cred = conn.credentialId ? await this.deps.creds.get(conn.userId, conn.credentialId) : undefined;
        const resolved = resolveTarget(conn, cred ?? null, config.appSecret);
        const username = conn.sshUsername || resolved.credSshUsername || '';
        if (!isTelnet && !username) {
          return this.fail('no SSH username — set one on the connection or its credential');
        }
        const hasAuto = Boolean(resolved.autoLogin);

        let jumps: JumpHopSpec[] | undefined;
        if (conn.jumpConnectionId) {
          const chain = await this.deps.repo.jumpChain(conn.id); // throws on cycle / too deep
          jumps = await Promise.all(
            chain.map(async (b) => {
              const bCred = b.credentialId ? await this.deps.creds.get(b.userId, b.credentialId) : undefined;
              const br = resolveTarget(b, bCred ?? null, config.appSecret);
              const bu = b.sshUsername || br.credSshUsername || '';
              if (!bu) throw new Error(`jump host "${b.name}" has no SSH username`);
              return {
                host: b.host,
                port: b.port,
                username: bu,
                password: br.password,
                privateKey: br.privateKey,
                passphrase: br.passphrase,
              };
            }),
          );
        }

        target = {
          host: conn.host,
          port: conn.port,
          username,
          telnet: isTelnet || undefined,
          command: isTelnet || hasAuto ? undefined : (conn.initCommand ?? config.ssh.command),
          connectionId: conn.id,
          autoLogin: resolved.autoLogin ?? undefined,
          antiIdleSeconds: conn.antiIdleSeconds || undefined,
          password: isTelnet ? undefined : resolved.password,
          privateKey: isTelnet ? undefined : resolved.privateKey,
          passphrase: isTelnet ? undefined : resolved.passphrase,
          jumps,
          configCommand: conn.configCommand ?? undefined,
          auditTarget: isTelnet
            ? `telnet://${conn.host}:${conn.port}`
            : `${username}@${conn.host}:${conn.port}`,
        };
      } else if (msg.adhoc) {
        if (!config.adhocEnabled) return this.fail('ad-hoc SSH is disabled on this server');
        target = {
          host: msg.adhoc.host,
          port: msg.adhoc.port,
          username: msg.adhoc.username,
          password: msg.adhoc.password,
          privateKey: msg.adhoc.privateKey,
          passphrase: msg.adhoc.passphrase,
          command: config.ssh.command,
          auditTarget: `${msg.adhoc.username}@${msg.adhoc.host}:${msg.adhoc.port}`,
        };
      } else if (config.adhocEnabled && config.ssh.host) {
        if (!config.ssh.user) return this.fail('server ad-hoc mode has no default SSH user configured');
        target = {
          host: config.ssh.host,
          port: config.ssh.port,
          username: config.ssh.user,
          command: config.ssh.command,
          auditTarget: `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`,
        };
      } else {
        return this.fail('no connection specified');
      }
    } catch (err) {
      return this.fail(`failed to resolve connection: ${(err as Error).message}`);
    }

    const list = config.allowHosts;
    if (!target.local && list.length && !list.includes(target.host.toLowerCase())) {
      return this.fail(`host not allowed: ${target.host}`);
    }

    const live = new LiveSession(this.ctx, this.deps, this.user, target, msg.cols, msg.rows, this.registry);
    this.live = live;
    this.send({ t: 'attached', token: live.token });
    live.connect(this);
  }
}
