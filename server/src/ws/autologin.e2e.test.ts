import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { startDeviceFixture, type DeviceFixture } from '../../test/deviceFixture.js';

const SECRET = 'autologin-secret-autologin-secret-1';

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let dev: DeviceFixture;
let cookie: string;
let connectionId: string;
const recDir = mkdtempSync(join(tmpdir(), 'anterm-rec-'));

beforeAll(async () => {
  dev = await startDeviceFixture();

  const config = loadConfig(['--app-secret', SECRET, '--db-url', ':memory:', '--record-dir', recDir, '--resume-grace-sec', '0']);
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
    liveSessions: new LiveRegistry(),
    webProxy: new WebProxyRegistry(),
  };

  const user = await createUser(dbHandle.db, { username: 'neteng', password: 'neteng-pass', role: 'operator' });
  const repo = new ConnectionRepo(dbHandle.db, SECRET);
  const conn = await repo.create(user.id, {
    name: 'sw1',
    host: dev.host,
    port: dev.port,
    sshUsername: dev.sshUser,
    authType: 'password',
    secret: dev.sshPass,
    loginUsername: dev.loginUser,
    loginPassword: dev.loginPass,
    enablePassword: dev.enablePass,
    setupCommands: 'terminal length 0\nshow version',
  });
  connectionId = conn.id;

  app = await buildApp(ctx);
  attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'neteng', password: 'neteng-pass' }),
  });
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
});

afterAll(async () => {
  await app?.close();
  await dev?.close();
  rmSync(recDir, { recursive: true, force: true });
});

describe('login automation e2e', () => {
  it('never returns login/enable passwords in the connection DTO', async () => {
    const res = await fetch(`http://${baseUrl}/api/connections`, { headers: { cookie } });
    const body = (await res.json()) as { connections: Record<string, unknown>[] };
    const dto = body.connections[0]!;
    expect(dto.hasLoginPassword).toBe(true);
    expect(dto.hasEnablePassword).toBe(true);
    expect(dto.loginUsername).toBe(dev.loginUser);
    expect(JSON.stringify(dto)).not.toContain(dev.loginPass);
    expect(JSON.stringify(dto)).not.toContain(dev.enablePass);
  });

  it('auto-logs-in, enters enable mode and runs setup commands with zero typing', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    let out = '';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; output:\n${out}`)), 20_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'open', connectionId, cols: 80, rows: 24 })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          out += data.toString();
          if (out.includes('Cisco IOS Software') && out.includes('sw1#')) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hostkey-prompt') ws.send(JSON.stringify({ t: 'hostkey', accept: true }));
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on('error', reject);
    });

    // reached privileged prompt + setup command output, without the client sending any keystroke
    expect(out).toContain('sw1#');
    expect(out).toContain('Cisco IOS Software, Version 15.2');
  });

  it('records the session to a .cast file with credentials redacted', async () => {
    await new Promise((r) => setTimeout(r, 200)); // let teardown flush
    const list = (await (await fetch(`http://${baseUrl}/api/sessions`, { headers: { cookie } })).json()) as {
      sessions: { id: string; hasRecording: boolean }[];
    };
    const sid = list.sessions[0]?.id;
    expect(sid).toBeTruthy();
    expect(list.sessions[0]?.hasRecording).toBe(true);

    const cast = await (await fetch(`http://${baseUrl}/api/sessions/${sid}/recording`, { headers: { cookie } })).text();
    expect(JSON.parse(cast.split('\n')[0]!)).toMatchObject({ version: 2, width: 80 });
    expect(cast).toContain('Cisco IOS Software');
    // the auto-login typed these — must be masked in the transcript
    expect(cast).not.toContain('l0gin');
    expect(cast).not.toContain('en4ble');

    const txt = await (
      await fetch(`http://${baseUrl}/api/sessions/${sid}/recording.txt`, { headers: { cookie } })
    ).text();
    expect(txt).toContain('sw1#');
    expect(txt.includes(String.fromCharCode(27))).toBe(false); // ESC / ANSI stripped
  });
});
