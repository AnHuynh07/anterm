import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TelnetSession } from './session.js';

const IAC = 255;
const SE = 240;
const SB = 250;
const WILL = 251;
const DO = 253;
const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_TTYPE = 24;
const OPT_NAWS = 31;

let srv: Server | undefined;
afterEach(() => {
  srv?.close();
  srv = undefined;
});

function serve(onConn: (sock: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    srv = createServer(onConn);
    srv.listen(0, '127.0.0.1', () => resolve((srv!.address() as { port: number }).port));
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function contains(haystack: Buffer, needle: number[]): boolean {
  const n = Buffer.from(needle);
  return haystack.includes(n);
}

async function open(port: number, cols = 80, rows = 24): Promise<{ t: TelnetSession; out: () => string }> {
  const t = new TelnetSession({ host: '127.0.0.1', port, cols, rows });
  let out = '';
  t.on('data', (c) => (out += c.toString('latin1')));
  await new Promise<void>((resolve, reject) => {
    t.on('ready', () => resolve());
    t.on('error', reject);
    t.connect();
  });
  return { t, out: () => out };
}

describe('TelnetSession', () => {
  it('strips IAC control sequences and emits only the payload', async () => {
    const port = await serve((sock) => {
      sock.write(
        Buffer.concat([
          Buffer.from([IAC, DO, OPT_SGA]),
          Buffer.from('hello '),
          Buffer.from([IAC, WILL, OPT_ECHO]),
          Buffer.from('world'),
        ]),
      );
    });
    const { out } = await open(port);
    await wait(120);
    expect(out()).toBe('hello world');
  });

  it('answers negotiation: WILL SGA/NAWS, DO ECHO, and sends the window size', async () => {
    let recv = Buffer.alloc(0);
    const port = await serve((sock) => {
      sock.on('data', (d) => (recv = Buffer.concat([recv, d])));
      sock.write(Buffer.from([IAC, DO, OPT_NAWS, IAC, DO, OPT_SGA, IAC, WILL, OPT_ECHO, IAC, DO, OPT_TTYPE]));
    });
    await open(port, 120, 40);
    await wait(150);
    expect(contains(recv, [IAC, WILL, OPT_NAWS])).toBe(true);
    expect(contains(recv, [IAC, WILL, OPT_SGA])).toBe(true);
    expect(contains(recv, [IAC, DO, OPT_ECHO])).toBe(true);
    // NAWS subnegotiation carrying 120 x 40
    expect(contains(recv, [IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE])).toBe(true);
    // TERMINAL-TYPE IS xterm-256color after a SEND
    // (server didn't SB..SEND here, so just check WILL TTYPE was offered)
    expect(contains(recv, [IAC, WILL, OPT_TTYPE])).toBe(true);
  });

  it('replies to a TERMINAL-TYPE SEND with the term name', async () => {
    let recv = Buffer.alloc(0);
    const port = await serve((sock) => {
      sock.on('data', (d) => (recv = Buffer.concat([recv, d])));
      sock.write(Buffer.from([IAC, SB, OPT_TTYPE, 1 /* SEND */, IAC, SE]));
    });
    await open(port);
    await wait(120);
    const isReply = Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0 /* IS */]), Buffer.from('xterm-256color')]);
    expect(recv.includes(isReply)).toBe(true);
  });

  it('doubles a literal 0xFF in outbound data', async () => {
    let recv = Buffer.alloc(0);
    const port = await serve((sock) => sock.on('data', (d) => (recv = Buffer.concat([recv, d]))));
    const { t } = await open(port);
    await wait(50);
    const before = recv.length;
    t.write(Buffer.from([0x41, 0xff, 0x42]));
    await wait(80);
    expect([...recv.subarray(before)]).toEqual([0x41, 0xff, 0xff, 0x42]);
  });

  it('reassembles an IAC sequence split across two chunks', async () => {
    const port = await serve((sock) => {
      sock.write(Buffer.from([0x41, IAC])); // "A" + dangling IAC
      setTimeout(() => sock.write(Buffer.from([WILL, OPT_SGA, 0x42])), 40); // WILL SGA + "B"
    });
    const { out } = await open(port);
    await wait(200);
    expect(out()).toBe('AB');
  });

  it('emits close when the peer hangs up', async () => {
    const port = await serve((sock) => setTimeout(() => sock.end(), 40));
    const t = new TelnetSession({ host: '127.0.0.1', port, cols: 80, rows: 24 });
    const reason = await new Promise<string>((resolve) => {
      t.on('close', (info) => resolve(info.reason));
      t.on('ready', () => undefined);
      t.connect();
    });
    expect(reason).toBeTruthy();
  });

  it('sends an updated NAWS on resize', async () => {
    let recv = Buffer.alloc(0);
    const port = await serve((sock) => {
      sock.on('data', (d) => (recv = Buffer.concat([recv, d])));
      sock.write(Buffer.from([IAC, DO, OPT_NAWS]));
    });
    const { t } = await open(port, 80, 24);
    await wait(80);
    t.resize(200, 50);
    await wait(80);
    expect(contains(recv, [IAC, SB, OPT_NAWS, 0, 200, 0, 50, IAC, SE])).toBe(true);
  });
});
