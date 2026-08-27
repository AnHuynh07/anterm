/**
 * In-band login automation for network devices.
 *
 * Many switches/routers/firewalls run their own `Username:` / `Password:` (and
 * `enable`) prompt *inside* the SSH session after transport auth. This state
 * machine watches the first slice of session output, answers those prompts with
 * stored credentials, optionally enters enable mode, runs setup commands
 * (`terminal length 0`, …), then **permanently disengages** — it never inspects
 * or writes the stream again, so interactive programs are untouched.
 */

export interface AutoLoginConfig {
  loginUsername?: string;
  loginPassword?: string;
  enablePassword?: string;
  setupCommands: string[];
}

type State =
  | 'wait-user'
  | 'wait-pass'
  | 'wait-ready'
  | 'wait-enable-pass'
  | 'sending-setup'
  | 'done';

const RE_USER = /(user\s?name|login)\s*[:>]\s*$/i;
const RE_PASS = /pass(word|phrase)?\s*[:>]\s*$/i;
const PROMPT_BODY = "[\\w.@:~/\\\\()\\[\\]{} -]{1,60}";
const RE_EXEC = new RegExp(`${PROMPT_BODY}>\\s*$`); // user-exec prompt (needs `enable`)
const RE_PRIV = new RegExp(`${PROMPT_BODY}[#$%]\\s*$`); // priv-exec / unix shell prompt

const MAX_MS = 20_000;
const MAX_BYTES = 128 * 1024;
const MAX_SENDS = 8;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]|[\x00-\x08\x0e-\x1f]/g;

export class AutoLogin {
  private state: State;
  private tail = '';
  private started = Date.now();
  private bytes = 0;
  private sends = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly cfg: AutoLoginConfig,
    private readonly write: (data: string) => void,
    private readonly onSecret: (secret: string) => void,
  ) {
    this.state = cfg.loginUsername ? 'wait-user' : 'wait-ready';
    const guard = setTimeout(() => this.finish(), MAX_MS);
    guard.unref?.();
    this.timers.push(guard);
  }

  get done(): boolean {
    return this.state === 'done';
  }

  feed(chunk: Buffer): void {
    if (this.state === 'done' || this.state === 'sending-setup') return;
    this.bytes += chunk.length;
    if (this.bytes > MAX_BYTES) return this.finish();

    this.tail = (this.tail + chunk.toString('utf8').replace(ANSI, '')).slice(-512);
    this.step();
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.state = 'done';
  }

  private send(data: string, secret?: string): void {
    if (this.sends++ >= MAX_SENDS) return this.finish();
    if (secret) this.onSecret(secret);
    this.write(data);
    this.tail = ''; // don't re-match the prompt we just answered
  }

  private step(): void {
    switch (this.state) {
      case 'wait-user':
        if (RE_USER.test(this.tail)) {
          this.send(`${this.cfg.loginUsername ?? ''}\r`);
          this.state = 'wait-pass';
        }
        return;

      case 'wait-pass':
        if (RE_PASS.test(this.tail)) {
          this.send(`${this.cfg.loginPassword ?? ''}\r`, this.cfg.loginPassword);
          this.state = 'wait-ready';
        }
        return;

      case 'wait-ready':
        if (this.cfg.enablePassword && RE_EXEC.test(this.tail)) {
          this.send('enable\r');
          this.state = 'wait-enable-pass';
          return;
        }
        if (RE_PRIV.test(this.tail) || (!this.cfg.enablePassword && RE_EXEC.test(this.tail))) {
          this.runSetup();
        }
        return;

      case 'wait-enable-pass':
        if (RE_PASS.test(this.tail)) {
          this.send(`${this.cfg.enablePassword ?? ''}\r`, this.cfg.enablePassword);
          this.state = 'wait-ready';
        }
        return;
    }
  }

  private runSetup(): void {
    this.state = 'sending-setup';
    const cmds = [...this.cfg.setupCommands];
    const next = () => {
      const cmd = cmds.shift();
      if (cmd === undefined) return this.finish();
      this.write(`${cmd}\r`);
      const t = setTimeout(next, 150);
      t.unref?.();
      this.timers.push(t);
    };
    next();
  }

  private finish(): void {
    this.dispose();
  }
}
