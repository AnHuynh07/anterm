import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const BASE_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...BASE_ENV };
});

describe('loadConfig', () => {
  it('applies defaults with only the required secret', () => {
    const cfg = loadConfig(['--app-secret', 'x'.repeat(20)]);
    expect(cfg.port).toBe(3000);
    expect(cfg.base).toBe('/');
    expect(cfg.adhocEnabled).toBe(false);
  });

  it('CLI flags beat env vars', () => {
    process.env.ANTERM_PORT = '4000';
    const cfg = loadConfig(['--app-secret', 'x'.repeat(20), '--port', '5000']);
    expect(cfg.port).toBe(5000);
  });

  it('normalises the base path', () => {
    const cfg = loadConfig(['--app-secret', 'x'.repeat(20), '--base', 'term/']);
    expect(cfg.base).toBe('/term');
  });

  it('enables ad-hoc mode when an ssh host is given', () => {
    const cfg = loadConfig(['--app-secret', 'x'.repeat(20), '--ssh-host', '10.0.0.1', '--ssh-user', 'root']);
    expect(cfg.adhocEnabled).toBe(true);
    expect(cfg.ssh.host).toBe('10.0.0.1');
    expect(cfg.ssh.port).toBe(22);
  });

  it('parses a comma-separated host allowlist', () => {
    const cfg = loadConfig(['--app-secret', 'x'.repeat(20), '--allow-hosts', 'a.internal, b.internal']);
    expect(cfg.allowHosts).toEqual(['a.internal', 'b.internal']);
  });

  it('rejects a too-short secret', () => {
    expect(() => loadConfig(['--app-secret', 'short'])).toThrow();
  });
});
