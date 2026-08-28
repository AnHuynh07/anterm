import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SessionService } from '../auth/session.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from '../connections/repo.js';
import { ReachabilityMonitor } from '../health/monitor.js';
import { ActivityLog } from '../activity.js';
import { AppSettingsStore } from '../settings.js';
import { Alerter } from '../alerts.js';
import { LiveRegistry } from './terminal.js';
import { buildApp } from '../http/app.js';
import { attachTerminalWs } from './terminal.js';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';

const SECRET = 'durable-secret-durable-secret-dur1x';

let app: Awaited<ReturnType<typeof buildApp>>;
let detachWs: () => void;
let baseUrl: string;
let fx: SshFixture;
let cookie: string;
let cookie2: string;
let csrf: string;
let connectionId: string;
const openSockets: WebSocket[] = [];

async function login(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { cookie, csrf: (await res.json()).csrf as string };
}

beforeAll(async () => {
  fx = await startSshFixture();
  // short quick-resume grace; durable window keeps the session for the default 120 min
  const config = loadConfig(['--app-secret', SECRET, '--db-url', ':memory:', '--no-record', '--resume-grace-sec', '1']);
  const log = pino({ level: 'silent' });
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const sessions = new SessionService(dbHandle.db, 3_600_000);
  const ctx: AppContext = {
    config,
    log,
    db: dbHandle.db,
    dbHandle,
    sessions,
    reachability: new ReachabilityMonitor(dbHandle.db, log, []),
    activity: new ActivityLog(dbHandle.db),
    settings: new AppSettingsStore(dbHandle.db),
    alerter: new Alerter(new AppSettingsStore(dbHandle.db), log),
    liveSessions: new LiveRegistry(),
  };
  const user = await createUser(dbHandle.db, { username: 'd', password: 'd-password' });
  await createUser(dbHandle.db, { username: 'other', password: 'other-password' });
  connectionId = (
    await new ConnectionRepo(dbHandle.db, SECRET).create(user.id, {
      name: 'fx',
      host: fx.host,
      port: fx.port,
      sshUsername: fx.username,
      authType: 'password',
      secret: fx.password,
    })
  ).id;

  app = await buildApp(ctx);
  detachWs = attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const a = await login('d', 'd-password');
  cookie = a.cookie;
  csrf = a.csrf;
  cookie2 = (await login('other', 'other-password')).cookie;
});

afterAll(async () => {
  for (const ws of openSockets) ws.terminate();
  detachWs?.();
  await app?.close();
  await fx?.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    openSockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('durable sessions', () => {
  it('survives a full disconnect, is listed for re-attach, and can be stopped', { timeout: 25_000 }, async () => {
    // open + ready
    const ws1 = await connect();
    let token = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ready')), 15_000);
      ws1.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 }));
      ws1.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'attached') token = m.token;
        if (m.t === 'hostkey-prompt') ws1.send(JSON.stringify({ t: 'hostkey', accept: true }));
        if (m.t === 'status' && m.state === 'ready') {
          clearTimeout(timer);
          resolve();
        }
        if (m.t === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      });
    });
    expect(token).toBeTruthy();

    ws1.send(Buffer.from('echo PERSISTED\n'));
    await new Promise((r) => setTimeout(r, 200));
    ws1.terminate(); // hard drop — no client left

    // wait well past the 1s quick-resume grace
    await new Promise((r) => setTimeout(r, 2500));

    // still listed as a running session for its owner
    const listRes = await fetch(`http://${baseUrl}/api/sessions/live`, { headers: { cookie } });
    const { sessions: live } = (await listRes.json()) as {
      sessions: { token: string; connectionId: string | null; detachedAt: number | null; attached: number }[];
    };
    const mine = live.find((s) => s.token === token);
    expect(mine, 'session should still be live after the resume grace').toBeTruthy();
    expect(mine!.connectionId).toBe(connectionId);
    expect(mine!.detachedAt).not.toBeNull();
    expect(mine!.attached).toBe(0);

    // another user cannot see it
    const otherList = await fetch(`http://${baseUrl}/api/sessions/live`, { headers: { cookie: cookie2 } });
    expect(((await otherList.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);

    // re-attach from a "new device" and confirm the shell is the same one
    const ws2 = await connect();
    let out2 = '';
    let resumed = false;
    ws2.send(JSON.stringify({ t: 'attach', token, cols: 80, rows: 24, fresh: true }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`resume timeout; got: ${out2}`)), 10_000);
      ws2.on('message', (d, isBinary) => {
        if (isBinary) {
          out2 += d.toString();
          return;
        }
        const m = JSON.parse(d.toString());
        if (m.t === 'attached' && m.resumed) resumed = true;
        if (m.t === 'status' && m.state === 'closed') {
          clearTimeout(timer);
          reject(new Error('durable session was closed: ' + m.detail));
        }
      });
      setTimeout(() => {
        ws2.send(Buffer.from('echo BACK\n'));
        setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, 800);
      }, 400);
    });
    expect(resumed).toBe(true);
    expect(out2).toContain('PERSISTED'); // replayed from the ring
    expect(out2).toContain('BACK'); // same shell still alive

    // a stranger cannot stop it (their csrf is fine; ownership check fails)
    const other2 = await login('other', 'other-password');
    const badStop = await fetch(`http://${baseUrl}/api/sessions/live/${token}/stop`, {
      method: 'POST',
      headers: { cookie: other2.cookie, 'x-csrf-token': other2.csrf },
    });
    expect(badStop.status).toBe(404);

    // the owner can
    const stop = await fetch(`http://${baseUrl}/api/sessions/live/${token}/stop`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(stop.status).toBe(200);

    const after = await fetch(`http://${baseUrl}/api/sessions/live`, { headers: { cookie } });
    expect(((await after.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});
