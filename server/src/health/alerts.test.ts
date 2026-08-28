import { createServer, type Server } from 'node:http';
import { createServer as netServer, type Server as NetServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from '../connections/repo.js';
import { AppSettingsStore, ALERTS_KEY } from '../settings.js';
import { Alerter } from '../alerts.js';
import { ReachabilityMonitor, type ReachTransition } from './monitor.js';

const log = pino({ level: 'silent' });
let h: DbHandle;

beforeEach(() => {
  h = createDb(':memory:');
  runMigrations(h.sqlite);
});
afterEach(() => h.close());

async function listen(srv: Server | NetServer): Promise<number> {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as { port: number }).port;
}

describe('Alerter', () => {
  it('POSTs a Slack-friendly payload to the configured webhook', async () => {
    const received: unknown[] = [];
    const hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('ok');
      });
    });
    const port = await listen(hook);

    const settings = new AppSettingsStore(h.db);
    await settings.setJson(ALERTS_KEY, { enabled: true, webhookUrl: `http://127.0.0.1:${port}/hook` });
    const alerter = new Alerter(settings, log);
    await alerter.dispatch({
      connectionId: 'c1',
      name: 'core-sw',
      host: '10.0.0.1',
      port: 22,
      status: 'down',
      prevStatus: 'up',
      latencyMs: null,
      detail: 'timed out',
      ts: 1,
    });

    expect(received).toHaveLength(1);
    const p = received[0] as { text: string; anterm: { name: string; status: string } };
    expect(p.text).toContain('core-sw');
    expect(p.text).toContain('DOWN');
    expect(p.anterm).toMatchObject({ name: 'core-sw', status: 'down' });
    hook.close();
  });

  it('does nothing when alerting is disabled', async () => {
    const settings = new AppSettingsStore(h.db);
    await settings.setJson(ALERTS_KEY, { enabled: false, webhookUrl: 'http://127.0.0.1:1/x' });
    // would throw ECONNREFUSED if it tried to POST
    await expect(new Alerter(settings, log).dispatch({} as ReachTransition)).resolves.toBeUndefined();
  });
});

describe('ReachabilityMonitor transitions', () => {
  it('records a debounced down transition and fires onTransition', async () => {
    const target = netServer((s) => s.destroy());
    const tport = await listen(target);

    const user = await createUser(h.db, { username: 'u', password: 'x'.repeat(10) });
    const conn = await new ConnectionRepo(h.db, 'a'.repeat(20)).create(user.id, {
      name: 'probe-me',
      host: '127.0.0.1',
      port: tport,
      sshUsername: 'x',
      authType: 'password',
    });

    const fired: ReachTransition[] = [];
    const mon = new ReachabilityMonitor(h.db, log, [], 60_000, 2);
    mon.onTransition = (t) => fired.push(t);

    await mon.sweepAll(); // first observation -> baseline 'up', no alert
    expect(mon.snapshot([conn.id])[conn.id]?.status).toBe('up');
    expect(fired).toHaveLength(0);

    await new Promise<void>((r) => target.close(() => r())); // now unreachable
    await mon.sweepAll(); // 1st down — pending
    expect(fired).toHaveLength(0);
    await mon.sweepAll(); // 2nd down — confirmed
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ connectionId: conn.id, status: 'down', prevStatus: 'up' });

    const events = await mon.eventsForConnection(conn.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'down', prevStatus: 'up' });

    // stays down -> no repeat alert
    await mon.sweepAll();
    expect(fired).toHaveLength(1);
  });
});
