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
import { WebProxyRegistry } from '../web/proxy.js';
import { buildApp } from '../http/app.js';
import { attachTerminalWs } from './terminal.js';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';

const SECRET = 'resume-secret-resume-secret-resume1';

let app: Awaited<ReturnType<typeof buildApp>>;
let detachWs: () => void;
let baseUrl: string;
let fx: SshFixture;
let cookie: string;
let connectionId: string;
const openSockets: WebSocket[] = [];

beforeAll(async () => {
  fx = await startSshFixture();
  const config = loadConfig([
    '--app-secret',
    SECRET,
    '--db-url',
    ':memory:',
    '--no-record',
    '--resume-grace-sec',
    '4',
  ]);
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
    webProxy: new WebProxyRegistry(),
  };
  const user = await createUser(dbHandle.db, { username: 'r', password: 'r-password' });
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
  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'r', password: 'r-password' }),
  });
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
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

describe('resume on reconnect', () => {
  it('keeps the SSH session alive across a WS drop and replays missed output', { timeout: 25_000 }, async () => {
    // 1. open, trust host key, wait for ready
    const ws1 = await connect();
    let token = '';
    let out1 = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready; ${out1}`)), 15_000);
      ws1.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 }));
      ws1.on('message', (d, isBinary) => {
        if (isBinary) {
          out1 += d.toString();
          return;
        }
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

    // 2. kick off delayed output, then immediately drop the socket
    ws1.send(Buffer.from('echo MARK-A; sleep 1; echo MARK-DELAYED\n'));
    await new Promise((r) => setTimeout(r, 120));
    ws1.terminate(); // hard drop, no clean close

    // 3. reconnect + attach after the delayed echo has fired server-side
    await new Promise((r) => setTimeout(r, 1500));
    const ws2 = await connect();
    let out2 = '';
    let resumed = false;
    ws2.send(JSON.stringify({ t: 'attach', token, cols: 80, rows: 24 }));

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
          reject(new Error('session was not kept alive: ' + m.detail));
        }
      });
      // give it a moment to replay + confirm the shell still responds
      setTimeout(() => {
        ws2.send(Buffer.from('echo MARK-B\n'));
        setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, 800);
      }, 400);
    });

    expect(resumed).toBe(true);
    expect(out2).toContain('MARK-DELAYED'); // produced while disconnected, replayed on attach
    expect(out2).toContain('MARK-B'); // same shell still alive and responding
  });

  it('refuses to attach to an unknown / other-user token', { timeout: 15_000 }, async () => {
    const ws = await connect();
    const closed = await new Promise<string>((resolve) => {
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'status' && m.state === 'closed') resolve(m.detail ?? '');
      });
      ws.send(JSON.stringify({ t: 'attach', token: 'totally-bogus-token', cols: 80, rows: 24 }));
    });
    expect(closed).toMatch(/no longer available/);
  });
});
