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

const SECRET = 'sharing-secret-sharing-secret-sha1';

let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let fx: SshFixture;
let connectionId: string;
const cookies: Record<string, string> = {};
const openSockets: WebSocket[] = [];

async function login(u: string, p: string) {
  const res = await fetch(`http://${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function ws(who: string): WebSocket {
  const s = new WebSocket(`ws://${base}/ws/terminal`, { headers: { cookie: cookies[who]! } });
  openSockets.push(s);
  return s;
}

beforeAll(async () => {
  fx = await startSshFixture();
  const config = loadConfig(['--app-secret', SECRET, '--db-url', ':memory:', '--no-record', '--resume-grace-sec', '0']);
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const log = pino({ level: 'silent' });
  const ctx: AppContext = {
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
  const owner = await createUser(dbHandle.db, { username: 'owner', password: 'owner-password', role: 'operator' });
  await createUser(dbHandle.db, { username: 'viewer', password: 'viewer-password', role: 'operator' });
  const conn = await new ConnectionRepo(dbHandle.db, SECRET).create(owner.id, {
    name: 'box',
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
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  cookies.owner = await login('owner', 'owner-password');
  cookies.viewer = await login('viewer', 'viewer-password');
});

afterAll(async () => {
  for (const s of openSockets) s.terminate();
  await app?.close();
  await fx?.close();
});

describe('session sharing (observer)', () => {
  it('a shared session lets another user watch read-only; unshared attach is refused', async () => {
    const o = ws('owner');
    let token = '';
    let ownerOut = '';
    let presence: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready; out=${ownerOut}`)), 15_000);
      o.on('open', () => o.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 })));
      o.on('message', (d, isBin) => {
        if (isBin) {
          ownerOut += d.toString();
          return;
        }
        const m = JSON.parse(d.toString());
        if (m.t === 'attached') token = m.token;
        if (m.t === 'hostkey-prompt') o.send(JSON.stringify({ t: 'hostkey', accept: true }));
        if (m.t === 'presence') presence = m.viewers;
        if (m.t === 'status' && m.state === 'ready') {
          clearTimeout(timer);
          resolve();
        }
        if (m.t === 'error') {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      });
      o.on('error', reject);
    });
    expect(token).toBeTruthy();

    // viewer cannot attach yet
    const denied = ws('viewer');
    const deniedMsg = await new Promise<string>((resolve) => {
      denied.on('open', () => denied.send(JSON.stringify({ t: 'attach', token, cols: 80, rows: 24 })));
      denied.on('message', (d, isBin) => {
        if (isBin) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'status' && m.state === 'closed') resolve(m.detail ?? '');
      });
    });
    expect(deniedMsg).toMatch(/not shared/i);
    denied.close();

    // owner shares
    o.send(JSON.stringify({ t: 'share', enabled: true }));
    await new Promise((r) => setTimeout(r, 150));

    // viewer attaches, gets read-only + replay, and sees the owner's later output
    const v = ws('viewer');
    let vAttached: Record<string, unknown> | null = null;
    let vOut = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('viewer never attached')), 10_000);
      v.on('open', () => v.send(JSON.stringify({ t: 'attach', token, cols: 80, rows: 24 })));
      v.on('message', (d, isBin) => {
        if (isBin) {
          vOut += d.toString();
          return;
        }
        const m = JSON.parse(d.toString());
        if (m.t === 'attached') {
          vAttached = m;
          clearTimeout(timer);
          resolve();
        }
      });
      v.on('error', reject);
    });
    expect(vAttached).toMatchObject({ readOnly: true, owner: 'owner' });

    // presence reaches the owner
    await new Promise((r) => setTimeout(r, 150));
    expect(presence).toContain('viewer');

    // owner runs a command -> viewer sees it
    o.send(Buffer.from('echo shared-visible\n'));
    await new Promise((r) => setTimeout(r, 800));
    expect(vOut).toContain('shared-visible');

    // viewer input is dropped (owner's stream never shows it)
    const mark = ownerOut.length;
    v.send(Buffer.from('echo VIEWER_INJECTED\n'));
    await new Promise((r) => setTimeout(r, 700));
    expect(ownerOut.slice(mark)).not.toContain('VIEWER_INJECTED');

    o.close();
    v.close();
  });
});
