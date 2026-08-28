import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import type { CloseInfo, TerminalBackend } from '../ssh/backend.js';

// --- Telnet protocol (RFC 854 / 855 / 1073 / 1091) ---
const IAC = 255;
const SE = 240;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

const OPT_BINARY = 0;
const OPT_ECHO = 1;
const OPT_SGA = 3; // suppress go-ahead
const OPT_TTYPE = 24; // terminal type
const OPT_NAWS = 31; // negotiate about window size

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

/** Options we are willing to enable on our side (reply WILL to a DO). */
const WANT_LOCAL = new Set([OPT_SGA, OPT_TTYPE, OPT_NAWS, OPT_BINARY]);
/** Options we want the peer to enable (reply DO to a WILL). */
const WANT_REMOTE = new Set([OPT_SGA, OPT_ECHO, OPT_BINARY]);

interface TelnetEvents {
  ready: () => void;
  data: (chunk: Buffer) => void;
  close: (info: CloseInfo) => void;
  error: (err: Error) => void;
}

export interface TelnetOptions {
  host: string;
  port: number;
  cols: number;
  rows: number;
  /** pre-established transport (e.g. a stream forwarded through a jump host) */
  socket?: Duplex;
  /** value returned for TERMINAL-TYPE negotiation */
  term?: string;
}

/**
 * A raw Telnet client presented as a {@link TerminalBackend}, so the whole
 * terminal pipeline (LiveSession, recording, durable sessions, broadcast,
 * login automation) works unchanged. Telnet carries no authentication and no
 * transport security — callers gate it behind `--allow-telnet` and warn the user.
 */
export class TelnetSession extends EventEmitter implements TerminalBackend {
  private sock: Duplex | null = null;
  private closed = false;
  private cols: number;
  private rows: number;
  private readonly term: string;
  /** bytes carried over from a chunk that split mid-IAC-sequence */
  private carry: Buffer = Buffer.alloc(0);
  /** negotiation state so we never answer the same offer twice (loop guard) */
  private localEnabled = new Set<number>(); // options we have said WILL for
  private remoteEnabled = new Set<number>(); // options the peer has said WILL for
  private refused = new Set<number>(); // (dir<<8|opt) pairs we have already rejected

  constructor(private readonly opts: TelnetOptions) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.term = opts.term ?? 'xterm-256color';
  }

  override on<E extends keyof TelnetEvents>(event: E, listener: TelnetEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<E extends keyof TelnetEvents>(event: E, ...args: Parameters<TelnetEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  connect(): void {
    const attach = (s: Duplex): void => {
      this.sock = s;
      s.on('data', (chunk: Buffer) => this.ingest(chunk));
      s.on('close', () => this.finish('connection closed'));
      s.on('end', () => this.finish('connection closed by peer'));
      s.on('error', (err: Error) => {
        this.emit('error', err);
        this.finish(err.message);
      });
      // proactively offer the options a modern terminal wants
      this.sendRaw(
        Buffer.from([IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA, IAC, WILL, OPT_TTYPE, IAC, WILL, OPT_NAWS]),
      );
      this.localEnabled.add(OPT_SGA).add(OPT_TTYPE).add(OPT_NAWS);
      this.sendNaws();
      this.emit('ready');
    };

    if (this.opts.socket) {
      attach(this.opts.socket);
      return;
    }
    const s = createConnection({ host: this.opts.host, port: this.opts.port });
    s.setNoDelay(true);
    s.once('connect', () => attach(s));
    s.once('error', (err) => {
      this.emit('error', err);
      this.finish(err.message);
    });
  }

  write(data: Buffer | string): void {
    if (!this.sock || this.closed) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // a literal 0xFF in the data stream must be doubled
    if (buf.includes(IAC)) {
      const parts: Buffer[] = [];
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === IAC) {
          parts.push(buf.subarray(start, i + 1), Buffer.from([IAC]));
          start = i + 1;
        }
      }
      parts.push(buf.subarray(start));
      this.sock.write(Buffer.concat(parts));
    } else {
      this.sock.write(buf);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.localEnabled.has(OPT_NAWS)) this.sendNaws();
  }

  close(reason = 'client disconnected'): void {
    if (this.closed) return;
    try {
      this.sock?.end();
      // net.Socket has destroy(); a forwarded Duplex may not
      (this.sock as { destroy?: () => void } | null)?.destroy?.();
    } catch {
      /* ignore */
    }
    this.finish(reason);
  }

  // --- internals ---

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const info: CloseInfo = { code: null, signal: null, reason };
    this.emit('close', info);
  }

  private sendRaw(buf: Buffer): void {
    this.sock?.write(buf);
  }

  private sendNaws(): void {
    const clamp = (n: number) => Math.max(0, Math.min(65535, Math.floor(n)));
    const w = clamp(this.cols);
    const h = clamp(this.rows);
    const dims = [w >> 8, w & 0xff, h >> 8, h & 0xff];
    // any 0xFF inside the subnegotiation payload must be doubled
    const payload: number[] = [];
    for (const b of dims) {
      payload.push(b);
      if (b === IAC) payload.push(IAC);
    }
    this.sendRaw(Buffer.from([IAC, SB, OPT_NAWS, ...payload, IAC, SE]));
  }

  private sendTtype(): void {
    const name = Buffer.from(this.term, 'ascii');
    this.sendRaw(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_IS]), name, Buffer.from([IAC, SE])]));
  }

  /** Parse an incoming chunk: strip IAC sequences, emit the plain data. */
  private ingest(chunk: Buffer): void {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    const out: number[] = [];
    let i = 0;

    while (i < data.length) {
      const b = data[i]!;
      if (b !== IAC) {
        out.push(b);
        i++;
        continue;
      }
      // need at least the command byte
      if (i + 1 >= data.length) {
        this.carry = data.subarray(i);
        break;
      }
      const cmd = data[i + 1]!;

      if (cmd === IAC) {
        out.push(IAC); // escaped literal 0xFF
        i += 2;
        continue;
      }

      if (cmd === SB) {
        const end = this.findSubnegEnd(data, i + 2);
        if (end === -1) {
          this.carry = data.subarray(i);
          break;
        }
        this.handleSubneg(data.subarray(i + 2, end));
        i = end + 2; // past IAC SE
        continue;
      }

      if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
        if (i + 2 >= data.length) {
          this.carry = data.subarray(i);
          break;
        }
        this.handleNegotiation(cmd, data[i + 2]!);
        i += 3;
        continue;
      }

      // NOP / DM / BRK / GA / … — single command byte, nothing to do
      i += 2;
    }

    if (out.length) this.emit('data', Buffer.from(out));
  }

  /** Index of the IAC in the terminating `IAC SE`, or -1 if incomplete. */
  private findSubnegEnd(data: Buffer, from: number): number {
    for (let i = from; i < data.length - 1; i++) {
      if (data[i] === IAC && data[i + 1] === SE) return i;
      if (data[i] === IAC && data[i + 1] === IAC) i++; // doubled 0xFF inside payload
    }
    return -1;
  }

  private handleSubneg(body: Buffer): void {
    if (body.length === 0) return;
    const opt = body[0]!;
    if (opt === OPT_TTYPE && body[1] === TTYPE_SEND) this.sendTtype();
    // NAWS/other server-initiated subnegs: nothing we need to act on
  }

  private handleNegotiation(cmd: number, opt: number): void {
    if (cmd === DO) {
      if (WANT_LOCAL.has(opt)) {
        if (!this.localEnabled.has(opt)) {
          this.localEnabled.add(opt);
          this.sendRaw(Buffer.from([IAC, WILL, opt]));
          if (opt === OPT_NAWS) this.sendNaws();
        }
      } else {
        this.rejectOnce(WONT, opt);
      }
      return;
    }
    if (cmd === DONT) {
      if (this.localEnabled.delete(opt)) this.sendRaw(Buffer.from([IAC, WONT, opt]));
      return;
    }
    if (cmd === WILL) {
      if (WANT_REMOTE.has(opt)) {
        if (!this.remoteEnabled.has(opt)) {
          this.remoteEnabled.add(opt);
          this.sendRaw(Buffer.from([IAC, DO, opt]));
        }
      } else {
        this.rejectOnce(DONT, opt);
      }
      return;
    }
    if (cmd === WONT) {
      if (this.remoteEnabled.delete(opt)) this.sendRaw(Buffer.from([IAC, DONT, opt]));
      return;
    }
  }

  private rejectOnce(cmd: number, opt: number): void {
    const key = (cmd << 8) | opt;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    this.sendRaw(Buffer.from([IAC, cmd, opt]));
  }
}
