import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { ReachabilityMonitor } from '../health/monitor.js';
import { ActivityLog } from '../activity.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SessionService } from '../auth/session.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from '../connections/repo.js';
import { buildApp } from './app.js';
import { attachTerminalWs } from '../ws/terminal.js';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';

const APP_SECRET = 'e2e-secret-e2e-secret-e2e-secret-1';

let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let fx: SshFixture;
let connectionId: string;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  fx = await startSshFixture();

  const config = loadConfig(['--app-secret', APP_SECRET, '--db-url', ':memory:', '--no-record', '--resume-grace-sec', '0']);
  const log = pino({ level: 'silent' });
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const sessions = new SessionService(dbHandle.db, 3_600_000);
  ctx = {
    config,
    log,
    db: dbHandle.db,
    dbHandle,
    sessions,
    reachability: new ReachabilityMonitor(dbHandle.db, log, []),
    activity: new ActivityLog(dbHandle.db),
  };

  const user = await createUser(dbHandle.db, { username: 'e2e', password: 'e2e-password', role: 'admin' });
  const repo = new ConnectionRepo(dbHandle.db, APP_SECRET);
  const conn = await repo.create(user.id, {
    name: 'fixture',
    host: fx.host,
    port: fx.port,
    sshUsername: fx.username,
    authType: 'password',
    secret: fx.password,
  });
  connectionId = conn.id;

  app = await buildApp(ctx);
  attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as { port: number };
  baseUrl = `127.0.0.1:${addr.port}`;

  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'e2e', password: 'e2e-password' }),
  });
  const setCookies = res.headers.getSetCookie();
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  csrf = (await res.json()).csrf;
  expect(csrf).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
  await fx?.close();
});

describe('terminal websocket e2e', () => {
  it('rejects an unauthenticated upgrade', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`);
    const err = await new Promise<Error>((resolve) => ws.on('error', resolve));
    expect(err.message).toMatch(/401/);
  });

  it('opens a session, trusts the host key (TOFU), and echoes input', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    let output = '';
    let sawHostKeyPrompt = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; output so far: ${JSON.stringify(output)}`)), 15_000);

      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          output += data.toString();
          if (output.includes('tofu-ok')) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hostkey-prompt') {
          sawHostKeyPrompt = true;
          ws.send(JSON.stringify({ t: 'hostkey', accept: true }));
        }
        if (msg.t === 'status' && msg.state === 'ready') {
          ws.send(Buffer.from('echo tofu-ok\n'));
        }
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on('error', reject);
    });

    expect(sawHostKeyPrompt).toBe(true);
    expect(output).toContain('tofu-ok');
  });

  it('remembers the trusted host key on the next connection (no prompt)', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    let prompted = false;
    let ready = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hostkey-prompt') prompted = true;
        if (msg.t === 'status' && msg.state === 'ready') {
          ready = true;
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on('error', reject);
    });

    expect(prompted).toBe(false);
    expect(ready).toBe(true);
  });

  it('writes an audit row for the session', async () => {
    const res = await fetch(`http://${baseUrl}/api/sessions`, { headers: { cookie } });
    const body = (await res.json()) as { sessions: { target: string; bytesIn: number }[] };
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions[0]?.target).toContain(`${fx.username}@${fx.host}`);
  });

  it('enforces CSRF on connection mutations', async () => {
    const res = await fetch(`http://${baseUrl}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'x', host: 'h', port: 22, sshUsername: 'u', authType: 'password' }),
    });
    expect(res.status).toBe(403);

    const ok = await fetch(`http://${baseUrl}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ name: 'x2', host: 'h', port: 22, sshUsername: 'u', authType: 'password' }),
    });
    expect(ok.status).toBe(201);
  });
});
