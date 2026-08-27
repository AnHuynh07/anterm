import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export interface RecorderOptions {
  cols: number;
  rows: number;
  title: string;
  /** returns the current list of secret strings to mask in the transcript */
  redact: () => string[];
  /** stop recording once the file exceeds this many bytes */
  maxBytes?: number;
}

/**
 * Writes an asciinema v2 `.cast` recording of a terminal session. Only output
 * ('o') events are needed for replay; input is captured separately for the
 * command log. Secrets from the auto-login are masked before they hit disk.
 */
export class SessionRecorder {
  private stream: WriteStream | null = null;
  private start = 0;
  private bytes = 0;
  private closed = false;
  private readonly max: number;

  constructor(
    private readonly filePath: string,
    private readonly opts: RecorderOptions,
  ) {
    this.max = opts.maxBytes ?? 25 * 1024 * 1024;
  }

  open(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.stream = createWriteStream(this.filePath, { flags: 'w' });
      this.start = Date.now();
      const header = {
        version: 2,
        width: this.opts.cols,
        height: this.opts.rows,
        timestamp: Math.floor(this.start / 1000),
        title: this.opts.title,
        env: { TERM: 'xterm-256color' },
      };
      this.stream.write(JSON.stringify(header) + '\n');
      return true;
    } catch {
      this.stream = null;
      return false;
    }
  }

  output(data: Buffer): void {
    this.event('o', data.toString('utf8'));
  }

  private event(kind: 'o' | 'i', text: string): void {
    if (!this.stream || this.closed || this.bytes > this.max) return;
    let s = text;
    for (const secret of this.opts.redact()) {
      if (secret && secret.length >= 3) s = s.split(secret).join('••••');
    }
    const t = (Date.now() - this.start) / 1000;
    const line = JSON.stringify([Number(t.toFixed(3)), kind, s]) + '\n';
    this.bytes += Buffer.byteLength(line);
    this.stream.write(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.end();
    this.stream = null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|[NOP])/;

/**
 * Reassembles command lines from a stream of client keystrokes for the
 * searchable command log. Handles backspace, ctrl-c/ctrl-u, and skips ANSI
 * cursor keys. Not a shell — just "what did the operator type before Enter".
 */
export class CommandExtractor {
  private line = '';

  feed(data: Buffer): string[] {
    const done: string[] = [];
    let s = data.toString('utf8');
    while (s.length) {
      const esc = ANSI_SEQ.exec(s);
      if (esc) {
        s = s.slice(esc[0].length);
        continue;
      }
      const ch = s[0]!;
      s = s.slice(1);
      if (ch === '\r' || ch === '\n') {
        const cmd = this.line.trim();
        this.line = '';
        if (cmd && cmd.length <= 2000) done.push(cmd);
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = this.line.slice(0, -1);
      } else if (ch === '\x03' || ch === '\x15') {
        this.line = ''; // ctrl-c / ctrl-u
      } else if (ch >= ' ' && ch !== '\x7f') {
        this.line += ch;
        if (this.line.length > 4000) this.line = this.line.slice(-2000);
      }
    }
    return done;
  }
}
