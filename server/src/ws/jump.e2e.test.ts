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
import { buildApp } from '../http/app.js';
import { attachTerminalWs } from './terminal.js';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';

const SECRET = 'jump-secret-jump-secret-jump-secr1';

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let bastion: SshFixture;
let target: SshFixture;
let cookie: string;
let repo: ConnectionRepo;
let bastionConnId: string;
let targetConnId: string;

beforeAll(async () => {
  bastion = await startSshFixture({ username: 'jump', password: 'jump-pw', allowForward: true });
  target = await startSshFixture({ username: 'demo', password: 'demo-pw' });

  const config = loadConfig(['--app-secret', SECRET, '--db-url', ':memory:', '--no-record', '--resume-grace-sec', '0']);
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const sessions = new SessionService(dbHandle.db, 3_600_000);
  const log = pino({ level: 'silent' });
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
  };

  const user = await createUser(dbHandle.db, { username: 'op', password: 'op-password', role: 'operator' });
  repo = new ConnectionRepo(dbHandle.db, SECRET);

  const b = await repo.create(user.id, {
    name: 'bastion',
    host: bastion.host,
    port: bastion.port,
    sshUsername: 'jump',
    authType: 'password',
    secret: 'jump-pw',
  });
  bastionConnId = b.id;
  const t = await repo.create(user.id, {
    name: 'behind-bastion',
    host: target.host,
    port: target.port,
    sshUsername: 'demo',
    authType: 'password',
    secret: 'demo-pw',
    jumpConnectionId: b.id,
  });
  targetConnId = t.id;

  app = await buildApp(ctx);
  attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'op', password: 'op-password' }),
  });
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
});

afterAll(async () => {
  await app?.close();
  await bastion?.close();
  await target?.close();
});

describe('jump host (ProxyJump)', () => {
  it('reaches the target through the bastion and echoes input', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    let out = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; output:\n${out}`)), 20_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId: targetConnId, cols: 80, rows: 24 })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          out += data.toString();
          if (out.includes('through-the-tunnel')) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hostkey-prompt') ws.send(JSON.stringify({ t: 'hostkey', accept: true }));
        if (msg.t === 'status' && msg.state === 'ready') ws.send(Buffer.from('echo through-the-tunnel\n'));
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on('error', reject);
    });
    expect(out).toContain('through-the-tunnel');
  });

  it('rejects a jump chain that loops back on itself', async () => {
    // point the bastion at the target, so target -> bastion -> target
    await repo.updateAny(bastionConnId, {
      name: 'bastion',
      host: bastion.host,
      port: bastion.port,
      sshUsername: 'jump',
      authType: 'password',
      jumpConnectionId: targetConnId,
    });
    await expect(repo.jumpChain(targetConnId)).rejects.toThrow(/cycle/i);

    // and the API refuses to save such a link
    const csrfRes = await fetch(`http://${baseUrl}/api/auth/me`, { headers: { cookie } });
    const csrf = (await csrfRes.json()).csrf;
    const bad = await fetch(`http://${baseUrl}/api/connections/${targetConnId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({
        name: 'behind-bastion',
        host: target.host,
        port: target.port,
        sshUsername: 'demo',
        authType: 'password',
        jumpConnectionId: bastionConnId,
      }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/loop/i);

    // undo so nothing leaks to other assertions
    await repo.updateAny(bastionConnId, {
      name: 'bastion',
      host: bastion.host,
      port: bastion.port,
      sshUsername: 'jump',
      authType: 'password',
      jumpConnectionId: null,
    });
  });
});
