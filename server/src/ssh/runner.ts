import { SshSession, type HostKeyVerifier } from './client.js';
import { AutoLogin, type AutoLoginConfig } from './autologin.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export interface RunSpec {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  autoLogin?: AutoLoginConfig | null;
  command: string;
  verifyHostKey: HostKeyVerifier;
  idleMs?: number;
  maxMs?: number;
}

export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Open a throwaway SSH shell, run login automation if configured, send one
 * command, collect output until the device goes quiet, then hang up. Used by the
 * "run on many devices" bulk action — never prompts, so a device whose host key
 * isn't trusted yet is rejected by `verifyHostKey`.
 */
export function runCommand(spec: RunSpec): Promise<RunResult> {
  const started = Date.now();
  const idleMs = spec.idleMs ?? 2500;
  const maxMs = spec.maxMs ?? 25_000;

  return new Promise<RunResult>((resolve) => {
    const chunks: Buffer[] = [];
    let auto: AutoLogin | null = null;
    let sentCommand = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let sendTimer: NodeJS.Timeout | null = null;

    const ssh = new SshSession({
      host: spec.host,
      port: spec.port,
      username: spec.username,
      password: spec.password,
      privateKey: spec.privateKey,
      passphrase: spec.passphrase,
      cols: 200,
      rows: 60,
      verifyHostKey: spec.verifyHostKey,
    });

    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (sendTimer) clearTimeout(sendTimer);
      auto?.dispose();
      try {
        ssh.close('bulk run complete');
      } catch {
        /* ignore */
      }
      const raw = Buffer.concat(chunks).toString('utf8').replace(ANSI, '').replace(/\r\n/g, '\n');
      resolve({ ok, output: cleanOutput(raw, spec.command), error, durationMs: Date.now() - started });
    };

    const hardTimer = setTimeout(
      () => finish(sentCommand, sentCommand ? undefined : 'timed out before the command could run'),
      maxMs,
    );
    hardTimer.unref?.();

    const bumpIdle = (): void => {
      if (!sentCommand || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(true), idleMs);
      idleTimer.unref?.();
    };

    const trySend = (): void => {
      if (sentCommand || settled) return;
      if (auto && !auto.done) {
        sendTimer = setTimeout(trySend, 300);
        sendTimer.unref?.();
        return;
      }
      sentCommand = true;
      chunks.length = 0; // discard the banner / login noise
      ssh.write(spec.command.replace(/[\r\n]+$/, '') + '\r');
      bumpIdle();
    };

    ssh.on('ready', () => {
      if (spec.autoLogin) auto = new AutoLogin(spec.autoLogin, (s) => ssh.write(s), () => undefined);
      sendTimer = setTimeout(trySend, spec.autoLogin ? 700 : 500);
      sendTimer.unref?.();
    });
    ssh.on('data', (d) => {
      auto?.feed(d);
      chunks.push(d);
      bumpIdle();
    });
    ssh.on('error', (err) => finish(false, err.message));
    ssh.on('close', (info) =>
      finish(sentCommand, sentCommand ? undefined : info.reason || 'connection closed before the command ran'),
    );

    ssh.connect();
  });
}

function cleanOutput(raw: string, command: string): string {
  let lines = raw.split('\n');
  const cmd = command.trim();
  if (lines[0]?.trim().endsWith(cmd)) lines = lines.slice(1);
  while (lines.length && /^[\w.@:~/\\()[\] -]{0,60}[#>$%]\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Run one command across many targets with bounded concurrency. */
export async function runFanout<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency = 6,
): Promise<void> {
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}
