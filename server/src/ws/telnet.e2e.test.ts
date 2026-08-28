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
import { startTelnetFixture, type TelnetFixture } from '../../test/telnetFixture.js';

const SECRET = 'telnet-secret-telnet-secret-telnet1';

let app: Awaited<ReturnType<typeof buildApp>>;
let detachWs: () => void;
let baseUrl: string;
let fx: TelnetFixture;
let cookie: string;
let telnetConnId: string;
let dbHandle: ReturnType<typeof createDb>;
const openSockets: WebSocket[] = [];

async function makeCtx(allowTelnet: boolean): Promise<AppContext> {
  const args = ['--app-secret', SECRET, '--db-url', ':memory:', '--no-record', '--resume-grace-sec', '0'];
  if (allowTelnet) args.push('--allow-telnet');
  const config = loadConfig(args);
  const log = pino({ level: 'silent' });
  dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  return {
    config,
    log,
    db: dbHandle.db,
    dbHandle,
    sessions: new SessionService(dbHandle.db, 3_600_000),
    reachability: new ReachabilityMonitor(dbHandle.db, log, []),
    activity: new ActivityLog(dbHandle.db),
    settings: new AppSettingsStore(dbHandle.db),
    alerter: new Alerter(new AppSettingsStore(dbHandle.db), log),
    liveSessions: new LiveRegistry(),
    webProxy: new WebProxyRegistry(),
  };
}

beforeAll(async () => {
  fx = await startTelnetFixture({ login: { user: 'netadmin', pass: 'l0gin' } });
  const ctx = await makeCtx(true);
  const user = await createUser(ctx.db, { username: 't', password: 't-password' });
  const repo = new ConnectionRepo(ctx.db, SECRET);
  telnetConnId = (
    await repo.create(user.id, {
      name: 'tsw',
      host: fx.host,
      port: fx.port,
      protocol: 'telnet',
      sshUsername: '',
      authType: 'password',
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      setupCommands: 'echo SETUP-RAN',
    })
  ).id;

  app = await buildApp(ctx);
  detachWs = attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 't', password: 't-password' }),
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

async function driveOpen(connectionId: string, onReady?: (ws: WebSocket) => void): Promise<string> {
  const ws = await connect();
  let out = '';
  return new Promise<string>((resolve, reject) => {
    const done = setTimeout(() => resolve(out), 4000);
    const fail = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(out)}`)), 12_000);
    ws.on('message', (d, isBinary) => {
      if (isBinary) {
        out += d.toString();
        return;
      }
      const m = JSON.parse(d.toString());
      if (m.t === 'status' && m.state === 'ready') onReady?.(ws);
      if (m.t === 'error') {
        clearTimeout(done);
        clearTimeout(fail);
        reject(new Error(m.message));
      }
    });
    ws.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 }));
  });
}

describe('telnet over the terminal websocket', () => {
  it('runs login automation, its setup command, and carries interactive input', async () => {
    const out = await driveOpen(telnetConnId, (ws) =>
      setTimeout(() => ws.send(Buffer.from('echo TELNET-LIVE\n')), 500),
    );
    // AutoLogin answered login:/Password:, the setup command ran, and typing works
    expect(out).toContain('SETUP-RAN');
    expect(out).toContain('TELNET-LIVE');
  });

  it('refuses telnet connections when --allow-telnet is off', async () => {
    const ctx2 = await makeCtx(false);
    const u = await createUser(ctx2.db, { username: 'z', password: 'z-password' });
    const id = (
      await new ConnectionRepo(ctx2.db, SECRET).create(u.id, {
        name: 'z', host: fx.host, port: fx.port, protocol: 'telnet', sshUsername: '', authType: 'password',
      })
    ).id;
    const app2 = await buildApp(ctx2);
    const detach2 = attachTerminalWs(app2.server, ctx2);
    await app2.listen({ host: '127.0.0.1', port: 0 });
    const url2 = `127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const login = await fetch(`http://${url2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'z', password: 'z-password' }),
    });
    const ck = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const ws = new WebSocket(`ws://${url2}/ws/terminal`, { headers: { cookie: ck } });
    openSockets.push(ws);
    const msg = await new Promise<string>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId: id, cols: 80, rows: 24 })));
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'error') resolve(m.message);
      });
    });
    expect(msg).toMatch(/telnet/i);
    ws.terminate();
    detach2();
    await app2.close();
  });
});
