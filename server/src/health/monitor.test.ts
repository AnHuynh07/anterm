import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from '../connections/repo.js';
import { ReachabilityMonitor, probe } from './monitor.js';

let srv: Server;
let openPort: number;

beforeAll(async () => {
  srv = createServer((s) => s.end());
  openPort = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)));
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe('probe', () => {
  it('reports up + latency for a listening port', async () => {
    const r = await probe('127.0.0.1', openPort);
    expect(r.status).toBe('up');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports down for a closed port', async () => {
    const r = await probe('127.0.0.1', 1); // nothing listens on :1
    expect(r.status).toBe('down');
    expect(r.detail).toBeTruthy();
  });
});

describe('ReachabilityMonitor', () => {
  it('checks a user\'s connections and returns a per-id snapshot', async () => {
    const h = createDb(':memory:');
    runMigrations(h.sqlite);
    const user = await createUser(h.db, { username: 'u', password: 'pw123456' });
    const repo = new ConnectionRepo(h.db, 'x'.repeat(20));
    const up = await repo.create(user.id, { name: 'up', host: '127.0.0.1', port: openPort, sshUsername: 'x', authType: 'agent' });
    const down = await repo.create(user.id, { name: 'down', host: '127.0.0.1', port: 1, sshUsername: 'x', authType: 'agent' });

    const mon = new ReachabilityMonitor(h.db, pino({ level: 'silent' }), []);
    const res = await mon.checkUser(user.id);
    expect(res[up.id]?.status).toBe('up');
    expect(res[down.id]?.status).toBe('down');
  });

  it('marks hosts outside the allowlist as unknown, without probing', async () => {
    const h = createDb(':memory:');
    runMigrations(h.sqlite);
    const user = await createUser(h.db, { username: 'u', password: 'pw123456' });
    const repo = new ConnectionRepo(h.db, 'x'.repeat(20));
    const c = await repo.create(user.id, { name: 'x', host: 'blocked.example', port: 22, sshUsername: 'x', authType: 'agent' });
    const mon = new ReachabilityMonitor(h.db, pino({ level: 'silent' }), ['allowed.internal']);
    const res = await mon.checkUser(user.id);
    expect(res[c.id]?.status).toBe('unknown');
    expect(res[c.id]?.detail).toMatch(/allowlist/);
  });
});
