import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { ReachabilityMonitor } from '../health/monitor.js';
import { ActivityLog } from '../activity.js';
import { AppSettingsStore } from '../settings.js';
import { Alerter } from '../alerts.js';
import { LiveRegistry } from '../ws/terminal.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SessionService } from '../auth/session.js';
import { createUser } from '../auth/users.js';
import { totpCode } from '../auth/totp.js';
import { buildApp } from './app.js';
import { attachTerminalWs } from '../ws/terminal.js';

const APP_SECRET = 'rbac-secret-rbac-secret-rbac-secr';

let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
const tok: Record<string, { cookie: string; csrf: string }> = {};

async function login(username: string, password: string) {
  const res = await fetch(`http://${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status, `${username} login`).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const csrf = (await res.json()).csrf as string;
  return { cookie, csrf };
}

const asUser = (who: string) => ({
  GET: (path: string) => fetch(`http://${base}/api${path}`, { headers: { cookie: tok[who]!.cookie } }),
  send: (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie: tok[who]!.cookie, 'x-csrf-token': tok[who]!.csrf };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`http://${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  },
});

beforeAll(async () => {
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
    settings: new AppSettingsStore(dbHandle.db),
    alerter: new Alerter(new AppSettingsStore(dbHandle.db), log),
    liveSessions: new LiveRegistry(),
  };

  await createUser(dbHandle.db, { username: 'boss', password: 'boss-password', role: 'admin' });
  await createUser(dbHandle.db, { username: 'opa', password: 'opa-password', role: 'operator' });
  await createUser(dbHandle.db, { username: 'opb', password: 'opb-password', role: 'operator' });
  await createUser(dbHandle.db, { username: 'watch', password: 'watch-password', role: 'viewer' });

  app = await buildApp(ctx);
  attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  tok.boss = await login('boss', 'boss-password');
  tok.opa = await login('opa', 'opa-password');
  tok.opb = await login('opb', 'opb-password');
  tok.watch = await login('watch', 'watch-password');
});

afterAll(async () => {
  await app?.close();
});

describe('RBAC + sharing', () => {
  let connId: string;

  it('operator creates a connection; viewer cannot', async () => {
    const bad = await asUser('watch').send('POST', '/connections', {
      name: 'v-attempt',
      host: '10.0.0.9',
      port: 22,
      sshUsername: 'x',
      authType: 'password',
    });
    expect(bad.status).toBe(403);

    const ok = await asUser('opa').send('POST', '/connections', {
      name: 'core-sw',
      host: '10.0.0.1',
      port: 22,
      sshUsername: 'admin',
      authType: 'password',
    });
    expect(ok.status).toBe(201);
    connId = (await ok.json()).connection.id;
  });

  it('admin sees every connection; another operator and a viewer do not', async () => {
    const boss = await (await asUser('boss').GET('/connections')).json();
    expect(boss.connections.find((c: { id: string }) => c.id === connId)?.relation).toBe('admin');

    const opb = await (await asUser('opb').GET('/connections')).json();
    expect(opb.connections.find((c: { id: string }) => c.id === connId)).toBeUndefined();

    const watch = await (await asUser('watch').GET('/connections')).json();
    expect(watch.connections.find((c: { id: string }) => c.id === connId)).toBeUndefined();
  });

  it('shares to a viewer (read-only) and to an operator (with edit)', async () => {
    const pick = await (await asUser('opa').GET('/users/pickable')).json();
    const idOf = (n: string) => pick.users.find((u: { username: string }) => u.username === n).id;

    const res = await asUser('opa').send('PUT', `/connections/${connId}/shares`, {
      shares: [
        { userId: idOf('watch'), canEdit: false },
        { userId: idOf('opb'), canEdit: true },
      ],
    });
    expect(res.status).toBe(200);

    const watch = (await (await asUser('watch').GET('/connections')).json()).connections.find(
      (c: { id: string }) => c.id === connId,
    );
    expect(watch.relation).toBe('shared');
    expect(watch.canOpen).toBe(false); // viewer never opens
    expect(watch.canEdit).toBe(false);

    const opb = (await (await asUser('opb').GET('/connections')).json()).connections.find(
      (c: { id: string }) => c.id === connId,
    );
    expect(opb.relation).toBe('shared');
    expect(opb.canOpen).toBe(true);
    expect(opb.canEdit).toBe(true);
  });

  it('shared operator with edit can PUT; a viewer cannot; delete stays owner-only', async () => {
    const editBody = { name: 'core-sw', host: '10.0.0.1', port: 22, sshUsername: 'admin', authType: 'password' };

    const opbEdit = await asUser('opb').send('PUT', `/connections/${connId}`, { ...editBody, sshUsername: 'root' });
    expect(opbEdit.status).toBe(200);

    const watchEdit = await asUser('watch').send('PUT', `/connections/${connId}`, editBody);
    expect(watchEdit.status).toBe(403);

    const opbDelete = await asUser('opb').send('DELETE', `/connections/${connId}`);
    expect(opbDelete.status).toBe(403);
  });

  it('gates the users and activity APIs to admins', async () => {
    expect((await asUser('opa').GET('/users')).status).toBe(403);
    expect((await asUser('opa').GET('/activity')).status).toBe(403);
    expect((await asUser('watch').GET('/users/pickable')).status).toBe(403);
    expect((await asUser('opa').GET('/users/pickable')).status).toBe(200);
    expect((await asUser('boss').GET('/users')).status).toBe(200);
  });

  it('admin creates a user and it lands in the activity log', async () => {
    const res = await asUser('boss').send('POST', '/users', {
      username: 'newbie',
      password: 'newbie-password',
      role: 'viewer',
    });
    expect(res.status).toBe(201);

    const events = (await (await asUser('boss').GET('/activity')).json()).events as { action: string; target: string }[];
    expect(events.some((e) => e.action === 'user.create' && e.target === 'newbie')).toBe(true);
    expect(events.some((e) => e.action === 'connection.create')).toBe(true);
    expect(events.some((e) => e.action === 'connection.share')).toBe(true);
  });

  it('blocks the last active admin from being demoted', async () => {
    const bossId = (await (await asUser('boss').GET('/users')).json()).users.find(
      (u: { username: string }) => u.username === 'boss',
    ).id;
    const res = await asUser('boss').send('PATCH', `/users/${bossId}`, { role: 'operator' });
    expect(res.status).toBe(400);
  });

  it('rejects a viewer opening a terminal over the websocket', async () => {
    const ws = new WebSocket(`ws://${base}/ws/terminal`, { headers: { cookie: tok.watch!.cookie } });
    const msg = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 8000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId: connId, cols: 80, rows: 24 })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(data.toString());
        if (m.t === 'error') {
          clearTimeout(t);
          ws.close();
          resolve(m.message);
        }
      });
      ws.on('error', reject);
    });
    expect(msg).toMatch(/read-only|cannot open/i);
  });

  it('vault export/import: admin only, re-auth, plaintext ack, encrypted round-trip', async () => {
    // non-admin -> 403
    expect((await asUser('opa').send('POST', '/vault/export', { password: 'opa-password', format: 'json', acknowledgePlaintext: true })).status).toBe(403);

    // wrong password -> 403
    expect((await asUser('boss').send('POST', '/vault/export', { password: 'nope', format: 'encrypted', passphrase: 'pp-123456' })).status).toBe(403);

    // plaintext without acknowledgement -> 400
    expect((await asUser('boss').send('POST', '/vault/export', { password: 'boss-password', format: 'json' })).status).toBe(400);

    // encrypted export -> import replace: summary shows the connection updated
    const exp = await asUser('boss').send('POST', '/vault/export', {
      password: 'boss-password',
      format: 'encrypted',
      passphrase: 'archive-pass-1',
    });
    expect(exp.status).toBe(200);
    const archive = await exp.text();

    const imp = await asUser('boss').send('POST', '/vault/import', {
      password: 'boss-password',
      format: 'encrypted',
      data: archive,
      passphrase: 'archive-pass-1',
      mode: 'replace',
    });
    expect(imp.status).toBe(200);
    const summary = await imp.json();
    expect(summary.connections.updated + summary.connections.created).toBeGreaterThan(0);
    expect(summary.errors).toEqual([]);

    // wrong passphrase on import -> 400
    const bad = await asUser('boss').send('POST', '/vault/import', {
      password: 'boss-password',
      format: 'encrypted',
      data: archive,
      passphrase: 'WRONG',
      mode: 'skip',
    });
    expect(bad.status).toBe(400);

    const events = (await (await asUser('boss').GET('/activity')).json()).events as { action: string }[];
    expect(events.some((e) => e.action === 'vault.export')).toBe(true);
    expect(events.some((e) => e.action === 'vault.import')).toBe(true);
  });

  it('downloads a database backup (admin only)', async () => {
    expect((await asUser('opa').GET('/vault/db-backup')).status).toBe(403);
    const res = await asUser('boss').GET('/vault/db-backup');
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('two-factor: setup, enable, gated login, recovery code, disable', async () => {
    const setup = await (await asUser('opb').send('POST', '/auth/2fa/setup')).json();
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUri).toContain('otpauth://totp/');

    const en = await asUser('opb').send('POST', '/auth/2fa/enable', { code: totpCode(setup.secret) });
    expect(en.status).toBe(200);
    const { recoveryCodes } = await en.json();
    expect(recoveryCodes).toHaveLength(8);

    const raw = () =>
      fetch(`http://${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'opb', password: 'opb-password' }),
      });

    // password alone now only yields a ticket
    const step1 = await (await raw()).json();
    expect(step1.mfaRequired).toBe(true);
    expect(step1.ticket).toBeTruthy();

    const twofa = (ticket: string, code: string) =>
      fetch(`http://${base}/api/auth/login/2fa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket, code }),
      });

    expect((await twofa(step1.ticket, '000000')).status).toBe(401);

    const s2 = await raw().then((r) => r.json());
    const good = await twofa(s2.ticket, totpCode(setup.secret));
    expect(good.status).toBe(200);
    expect((await good.json()).user.username).toBe('opb');

    // a recovery code also works, once
    const s3 = await raw().then((r) => r.json());
    const rec = await twofa(s3.ticket, recoveryCodes[0]);
    expect(rec.status).toBe(200);
    const s4 = await raw().then((r) => r.json());
    expect((await twofa(s4.ticket, recoveryCodes[0])).status).toBe(401); // already used

    // disable
    const off = await asUser('opb').send('POST', '/auth/2fa/disable', { password: 'opb-password' });
    expect(off.status).toBe(200);
    expect((await (await raw()).json()).mfaRequired).toBeUndefined();
  });
});
