import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandExtractor, SessionRecorder } from './recorder.js';

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('SessionRecorder', () => {
  it('writes an asciinema v2 cast and masks secrets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rec-'));
    const secrets = ['s3cr3t'];
    const rec = new SessionRecorder(join(dir, 'a.cast'), {
      cols: 100,
      rows: 30,
      title: 'admin@sw1',
      redact: () => secrets,
    });
    expect(rec.open()).toBe(true);
    rec.output(Buffer.from('login: '));
    rec.output(Buffer.from('password accepted, token=s3cr3t done'));
    rec.close();
    await new Promise((r) => setTimeout(r, 20));

    const lines = readFileSync(join(dir, 'a.cast'), 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]!);
    expect(header).toMatchObject({ version: 2, width: 100, height: 30, title: 'admin@sw1' });
    const events = lines.slice(1).map((l) => JSON.parse(l));
    expect(events[0][1]).toBe('o');
    const all = events.map((e) => e[2]).join('');
    expect(all).toContain('••••');
    expect(all).not.toContain('s3cr3t');
  });
});

describe('CommandExtractor', () => {
  const ex = () => new CommandExtractor();

  it('emits a command on CR', () => {
    const e = ex();
    expect(e.feed(Buffer.from('show version'))).toEqual([]);
    expect(e.feed(Buffer.from('\r'))).toEqual(['show version']);
  });

  it('handles backspace and ctrl-u', () => {
    const e = ex();
    e.feed(Buffer.from('show xxx'));
    e.feed(Buffer.from('\x7f\x7f\x7f'));
    e.feed(Buffer.from('run'));
    expect(e.feed(Buffer.from('\n'))).toEqual(['show run']);
    e.feed(Buffer.from('garbage\x15clean'));
    expect(e.feed(Buffer.from('\r'))).toEqual(['clean']);
  });

  it('skips ANSI cursor keys and drops empty lines', () => {
    const e = ex();
    e.feed(Buffer.from('\x1b[A\x1b[B')); // up, down
    expect(e.feed(Buffer.from('\r'))).toEqual([]);
    expect(e.feed(Buffer.from('conf t\r\r\r'))).toEqual(['conf t']);
  });
});
