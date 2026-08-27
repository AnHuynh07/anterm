import { EventEmitter } from 'node:events';
import { platform } from 'node:os';
import type { CloseInfo, TerminalBackend } from './backend.js';

interface LocalEvents {
  ready: () => void;
  data: (chunk: Buffer) => void;
  close: (info: CloseInfo) => void;
  error: (err: Error) => void;
}

export interface LocalShellOptions {
  command?: string; // run this instead of an interactive login shell
  cols?: number;
  rows?: number;
  cwd?: string;
  term?: string;
}

interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/**
 * A local login shell via the optional `node-pty` dependency. Used for the
 * WeTTY-style "connect to localhost without SSH" mode. If node-pty is not
 * installed the connect() call emits a clear error.
 */
export class LocalSession extends EventEmitter implements TerminalBackend {
  private pty: PtyLike | null = null;
  private closed = false;

  constructor(private readonly opts: LocalShellOptions) {
    super();
  }

  override on<E extends keyof LocalEvents>(event: E, listener: LocalEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof LocalEvents>(event: E, ...args: Parameters<LocalEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  connect(): void {
    void this.spawn();
  }

  private async spawn(): Promise<void> {
    // node-pty is an optional dependency and needs a native build; keep the
    // reference dynamic and untyped so the server compiles without it.
    let ptyMod: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike };
    try {
      ptyMod = (await import('node-pty' as string)) as typeof ptyMod;
    } catch {
      this.emit('error', new Error('local shell unavailable: the optional "node-pty" dependency is not installed'));
      this.finish(null, null, 'node-pty not installed');
      return;
    }

    const isWin = platform() === 'win32';
    const shell = process.env.SHELL ?? (isWin ? 'powershell.exe' : '/bin/bash');
    const [file, args] = this.opts.command
      ? isWin
        ? ['powershell.exe', ['-Command', this.opts.command]]
        : [shell, ['-c', this.opts.command]]
      : [shell, [] as string[]];

    try {
      this.pty = ptyMod.spawn(file, args as string[], {
        name: this.opts.term ?? 'xterm-256color',
        cols: this.opts.cols ?? 80,
        rows: this.opts.rows ?? 24,
        cwd: this.opts.cwd ?? process.env.HOME ?? process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.emit('error', err as Error);
      this.finish(null, null, (err as Error).message);
      return;
    }

    this.pty.onData((d) => this.emit('data', Buffer.from(d, 'utf8')));
    this.pty.onExit(({ exitCode, signal }) =>
      this.finish(exitCode, signal ? String(signal) : null, `shell exited (${exitCode})`),
    );
    this.emit('ready');
  }

  write(data: Buffer | string): void {
    this.pty?.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows);
    } catch {
      /* pty may have exited */
    }
  }

  close(reason = 'client disconnected'): void {
    if (this.closed) return;
    try {
      this.pty?.kill();
    } catch {
      /* ignore */
    }
    this.finish(null, null, reason);
  }

  private finish(code: number | null, signal: string | null, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const info: CloseInfo = { code, signal, reason };
    this.emit('close', info);
  }
}
