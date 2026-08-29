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
import { WebConfigScheduler } from './configScheduler.js';
import { buildApp } from '../http/app.js';
import { startWebSwitchFixture, type WebSwitchFixture } from '../../test/webSwitchFixture.js';

const SECRET = 'webcfg-secret-webcfg-secret-webcfg1';
const BINARY_BLOB = [0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17].map((n) => String.fromCharCode(n)).join('').repeat(60);

let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: AppContext;
let base: string;
let sw: WebSwitchFixture;
let ownerCookie: string;
let csrf: string;
let connId: string;

const webhook: { hits: unknown[]; server: Server; url: string } = { hits: [], server: null!, url: '' };

async function login(u: string, p: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`http://${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { cookie, csrf: (await res.json()).csrf as string };
}

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
        configUrl: '/iss/backup.cfg',
      },
    })
  ).id;

  app = await buildApp(ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
  ({ cookie: ownerCookie, csrf } = await login('op', 'op-password'));
});

afterAll(async () => {
  await app?.close();
  await sw?.close();
  await new Promise<void>((r) => webhook.server.close(() => r()));
});

async function snapshotNow(): Promise<{
  status: number;
  body: { id?: string; changed?: boolean; lines?: number; binary?: boolean; error?: string };
}> {
  const res = await fetch(`http://${base}/api/connections/${connId}/config-snapshot`, {
    method: 'POST',
    headers: { cookie: ownerCookie, 'x-csrf-token': csrf },
  });
  return { status: res.status, body: await res.json() };
}

const snapshotList = () =>
  fetch(`http://${base}/api/connections/${connId}/config-snapshots`, { headers: { cookie: ownerCookie } }).then((r) =>
    r.json(),
  );

const rawSnapshot = (id: string) =>
  fetch(`http://${base}/api/connections/${connId}/config-snapshots/${id}`, { headers: { cookie: ownerCookie } }).then(
    (r) => r.json(),
  );

describe('web-device config history', () => {
  it('downloads the config backup URL through the logged-in session and stores it', async () => {
    const first = await snapshotNow();
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true); // first snapshot is always "changed"
    expect(first.body.binary).toBe(false);
    expect(first.body.lines).toBeGreaterThan(3);

    const list = await snapshotList();
    expect(list.protocol).toBe('http');
    expect(list.configCommand).toBe('/iss/backup.cfg'); // the URL, not "show running-config"
    expect(list.snapshots).toHaveLength(1);

    const raw = await rawSnapshot(list.snapshots[0].id);
    expect(raw.content).toContain('hostname gs950');
  });

  it('re-snapshots as unchanged, then detects a real diff when the device config changes', async () => {
    const same = await snapshotNow();
    expect(same.body.changed).toBe(false);

    sw.setConfig(sw.config.replace('hostname gs950', 'hostname gs950-core').replace(' name default\n', ''));
    const changed = await snapshotNow();
    expect(changed.body.changed).toBe(true);

    const diff = await (
      await fetch(
        `http://${base}/api/connections/${connId}/config-diff?a=${same.body.id}&b=${changed.body.id}`,
        { headers: { cookie: ownerCookie } },
      )
    ).json();
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);
    expect(
      diff.lines.some((l: { type: string; text: string }) => l.type === '+' && l.text.includes('gs950-core')),
    ).toBe(true);
  });

  it('the scheduled sweep fires a config-drift alert to the webhook on a change', async () => {
    await ctx.settings.setJson(ALERTS_KEY, { enabled: true, webhookUrl: webhook.url });
    const sched = new WebConfigScheduler(ctx);

    webhook.hits.length = 0;
    await sched.sweep(); // config unchanged since the last manual snapshot -> no alert
    expect(webhook.hits).toHaveLength(0);

    sw.setConfig(sw.config + '\nsnmp-server community public RO\n');
    await sched.sweep();
    expect(webhook.hits).toHaveLength(1);
    const hit = webhook.hits[0] as { text: string; anterm: { kind: string; name: string; added: number } };
    expect(hit.text).toContain('gs950');
    expect(hit.text).toContain('config changed');
    expect(hit.anterm).toMatchObject({ kind: 'config-drift', name: 'gs950' });
    expect(hit.anterm.added).toBeGreaterThan(0);
  });

  it('a binary config blob is reduced to a sha256 summary instead of a hex diff', async () => {
    sw.setConfig(BINARY_BLOB);
    const res = await snapshotNow();
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);

    const raw = await rawSnapshot(res.body.id!);
    expect(raw.content).toContain('# AnTerm binary configuration snapshot');
    expect(raw.content).toContain('# sha256:');
  });
});
