import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';

const IAC = 255;
const SE = 240;
const SB = 250;
const WILL = 251;
const OPT_SGA = 3;
const OPT_ECHO = 1;

export interface TelnetFixture {
  port: number;
  host: string;
  close: () => Promise<void>;
}

/** Strip inbound Telnet IAC negotiation, returning only the payload bytes. */
function stripIac(state: { carry: Buffer }, chunk: Buffer): Buffer {
  const data = state.carry.length ? Buffer.concat([state.carry, chunk]) : chunk;
  state.carry = Buffer.alloc(0);
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== IAC) {
      out.push(data[i]!);
      i++;
      continue;
    }
    if (i + 1 >= data.length) {
      state.carry = data.subarray(i);
      break;
    }
    const cmd = data[i + 1]!;
    if (cmd === IAC) {
      out.push(IAC);
      i += 2;
    } else if (cmd === SB) {
      let j = i + 2;
      while (j < data.length - 1 && !(data[j] === IAC && data[j + 1] === SE)) j++;
      if (j >= data.length - 1) {
        state.carry = data.subarray(i);
        break;
      }
      i = j + 2;
    } else {
      if (i + 2 >= data.length) {
        state.carry = data.subarray(i);
        break;
      }
      i += 3;
    }
  }
  return Buffer.from(out);
}

const PROMPT = 'tsw# ';

/**
 * A throwaway in-process Telnet server for integration tests. Offers SGA + ECHO,
 * strips inbound IAC, and emulates a tiny line-oriented device: an optional
 * `login:` / `Password:` sequence, then a `tsw# ` prompt that runs each typed
 * line through `/bin/sh -c` — enough to exercise login automation and I/O.
 */
export async function startTelnetFixture(opts?: { login?: { user: string; pass: string } }): Promise<TelnetFixture> {
  const server: Server = createServer((sock) => {
    const iac = { carry: Buffer.alloc(0) };
    let stage: 'user' | 'pass' | 'shell' = opts?.login ? 'user' : 'shell';
    let line = '';

    sock.write(Buffer.from([IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO]));
    if (stage === 'user') sock.write('login: ');
    else sock.write(`\r\n${PROMPT}`);

    const runLine = (cmd: string) => {
      if (!cmd.trim()) {
        sock.write(`\r\n${PROMPT}`);
        return;
      }
      execFile('/bin/sh', ['-c', cmd], { timeout: 4000 }, (_err, stdout, stderr) => {
        sock.write(`\r\n${stdout}${stderr}${PROMPT}`);
      });
    };

    sock.on('data', (chunk) => {
      const clean = stripIac(iac, chunk);
      for (const ch of clean.toString('latin1')) {
        if (ch === '\r' || ch === '\n') {
          const done = line;
          line = '';
          if (!done && stage !== 'shell') continue;
          if (stage === 'user') {
            stage = 'pass';
            sock.write('\r\nPassword: ');
          } else if (stage === 'pass') {
            stage = 'shell';
            sock.write(`\r\n${PROMPT}`);
          } else {
            runLine(done);
          }
        } else if (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) < 0x7f) {
          line += ch;
        }
      }
    });

    sock.on('error', () => undefined);
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  return {
    port,
    host: '127.0.0.1',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
