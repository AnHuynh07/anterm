import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SessionService } from '../auth/session.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from '../connections/repo.js';
import { ReachabilityMonitor } from '../health/monitor.js';
import { ActivityLog } from '../activity.js';
import { AppSettingsStore, ALERTS_KEY } from '../settings.js';
import { Alerter } from '../alerts.js';
import { LiveRegistry } from '../ws/terminal.js';
import { WebProxyRegistry } from './proxy.js';
import { WebDeviceScheduler } from './deviceScheduler.js';
import { buildApp } from '../http/app.js';
import { startWebSwitchFixture, type WebSwitchFixture } from '../../test/webSwitchFixture.js';

const SECRET = 'webfacts-secret-webfacts-secret-wf1';

let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: AppContext;
let base: string;
let sw: WebSwitchFixture;
let ownerCookie: string;
let viewerCookie: string;
let connId: string;

const webhook: { hits: unknown[]; server: Server; url: string } = { hits: [], server: null!, url: '' };

async function loginCookie(u: string, p: string): Promise<string> {
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

const getFacts = (cookie = ownerCookie) =>
  fetch(`http://${base}/api/connections/${connId}/web-facts`, { headers: { cookie } });

beforeAll(async () => {
  sw = await startWebSwitchFixture();

  webhook.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      webhook.hits.push(JSON.parse(body || '{}'));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => webhook.server.listen(0, '127.0.0.1', () => r()));
  webhook.url = `http://127.0.0.1:${(webhook.server.address() as { port: number }).port}/hook`;

  const config = loadConfig(['--app-secret', SECRET, '--db-url', ':memory:', '--no-record']);
  const log = pino({ level: 'silent' });
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const settings = new AppSettingsStore(dbHandle.db);
  ctx = {
    config,
    log,
    db: dbHandle.db,
    dbHandle,
    sessions: new SessionService(dbHandle.db, 3_600_000),
    reachability: new ReachabilityMonitor(dbHandle.db, log, []),
    activity: new ActivityLog(dbHandle.db),
    settings,
    alerter: new Alerter(settings, log),
    liveSessions: new LiveRegistry(),
    webProxy: new WebProxyRegistry(),
  };

  const owner = await createUser(ctx.db, { username: 'op', password: 'op-password', role: 'operator' });
  await createUser(ctx.db, { username: 'view', password: 'view-password', role: 'viewer' });
  connId = (
    await new ConnectionRepo(ctx.db, SECRET).create(owner.id, {
      name: 'gs950',
      host: sw.host,
      port: sw.port,
      protocol: 'http',
      sshUsername: '',
      authType: 'password',
      settings: {
        url: sw.url,
        authMode: 'form',
        username: sw.user,
        password: sw.pass,
        factsUrl: '/iss/sysinfo.htm',
        firmwareBaseline: '2.4.4',
      },
    })
  ).id;

  app = await buildApp(ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  ownerCookie = await loginCookie('op', 'op-password');
  viewerCookie = await loginCookie('view', 'view-password');
});

afterAll(async () => {
  await app?.close();
  await sw?.close();
  await new Promise<void>((r) => webhook.server.close(() => r()));
});

describe('web-device facts readout', () => {
  it('scrapes model / firmware / MAC / uptime from the status page and matches the baseline', async () => {
    const res = await getFacts();
    expect(res.status).toBe(200);
    const body = await res.json();
    const byLabel = Object.fromEntries(body.facts.map((f: { label: string; value: string }) => [f.label, f.value]));
    expect(byLabel['Model']).toBe('AT-GS950/16PS');
    expect(byLabel['Firmware']).toBe('2.4.4');
    expect(byLabel['MAC address']).toBe('00:1A:EB:12:34:56');
    expect(byLabel['Uptime']).toMatch(/14 days/);
    expect(body.firmware).toBe('2.4.4');
    expect(body.baseline).toBe('2.4.4');
    expect(body.firmwareOk).toBe(true);
  });

  it('flags firmware that no longer matches the baseline', async () => {
    sw.setFirmware('2.4.5');
    const body = await (await getFacts()).json();
    expect(body.firmware).toBe('2.4.5');
    expect(body.firmwareOk).toBe(false);
    sw.setFirmware('2.4.4');
  });

  it('a viewer (not shared) cannot read facts', async () => {
    const res = await getFacts(viewerCookie);
    expect([403, 404]).toContain(res.status);
  });

  it('400 when the device has no device-info URL', async () => {
    const owner = await ctx.db.query.users.findFirst();
    const other = (
      await new ConnectionRepo(ctx.db, SECRET).create(owner!.id, {
        name: 'no-facts',
        host: sw.host,
        port: sw.port,
        protocol: 'http',
        sshUsername: '',
        authType: 'password',
        settings: { url: sw.url, authMode: 'form', username: sw.user, password: sw.pass },
      })
    ).id;
    const res = await fetch(`http://${base}/api/connections/${other}/web-facts`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(400);
  });

  it('the scheduled sweep alerts once when firmware drifts off baseline, then re-arms', async () => {
    await ctx.settings.setJson(ALERTS_KEY, { enabled: true, webhookUrl: webhook.url });
    const sched = new WebDeviceScheduler(ctx);

    webhook.hits.length = 0;
    await sched.sweep(); // firmware == baseline -> no alert
    expect(webhook.hits).toHaveLength(0);

    sw.setFirmware('2.4.7');
    await sched.sweep();
    await sched.sweep(); // same drifted version -> still just one alert
    expect(webhook.hits).toHaveLength(1);
    const hit = webhook.hits[0] as { text: string; anterm: { kind: string; expected: string; now: string } };
    expect(hit.text).toContain('firmware is now');
    expect(hit.anterm).toMatchObject({ kind: 'firmware-change', expected: '2.4.4', now: '2.4.7' });

    sw.setFirmware('2.4.4'); // back on baseline -> re-arm
    await sched.sweep();
    sw.setFirmware('2.4.8'); // drifts again -> a fresh alert
    await sched.sweep();
    expect(webhook.hits).toHaveLength(2);

    sw.setFirmware('2.4.4');
  });
});
