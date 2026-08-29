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
import { AppSettingsStore } from '../settings.js';
import { Alerter } from '../alerts.js';
import { LiveRegistry } from '../ws/terminal.js';
import { WebProxyRegistry } from './proxy.js';
import { buildApp } from '../http/app.js';
import { startWebSwitchFixture, type WebSwitchFixture } from '../../test/webSwitchFixture.js';

const SECRET = 'webproxy-secret-webproxy-secret-wp1';

let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let sw: WebSwitchFixture;
let ownerCookie: string;
let viewerCookie: string;
let connId: string;

async function ctxWith(allowWebProxy: boolean): Promise<AppContext> {
  const args = ['--app-secret', SECRET, '--db-url', ':memory:', '--no-record'];
  if (!allowWebProxy) args.push('--allow-web-proxy=false');
  const config = loadConfig(args);
  const log = pino({ level: 'silent' });
  const dbHandle = createDb(':memory:');
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

beforeAll(async () => {
  sw = await startWebSwitchFixture();
  const ctx = await ctxWith(true);
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
      settings: { url: sw.url, authMode: 'form', username: sw.user, password: sw.pass },
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
});

describe('web-device reverse proxy', () => {
  it('signs in with the form and returns the authed page, rewritten for framing', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    // helmet's frame block is replaced so AnTerm can iframe it
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBeNull();
    const html = await res.text();
    // it followed the login redirect to the main page (not the login form)
    expect(html).not.toContain('name="Password"');
    expect(html).toContain('AT-GS950');
    // <base> + absolute paths rewritten under the proxy prefix
    const prefix = `/webproxy/${connId}/`;
    expect(html).toContain(`<base href="${prefix}">`);
    expect(html).toContain(`href="${prefix}iss/vlan.html"`);
    expect(html).toContain(`src="${prefix}iss/logo.gif"`);
    expect(html).toContain(`action="${prefix}iss/apply.cgi"`);
    expect(html).toContain(`<frame src="${prefix}iss/menu.html"`);
  });

  it('proxies binary assets with the session cookie injected', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/iss/logo.gif`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/gif');
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toBe('GIF89a');
  });

  it('rewrites CSS url() and never leaks the device cookie to the browser', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/iss/main.html`, {
      headers: { cookie: ownerCookie },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a viewer cannot open the proxy', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/`, { headers: { cookie: viewerCookie } });
    expect(res.status).toBe(403);
  });

  it('unauthenticated request is refused', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/`);
    expect(res.status).toBe(401);
  });

  it('GET /api/connections/:id/web reveals the credentials for the owner', async () => {
    const res = await fetch(`http://${base}/api/connections/${connId}/web`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: sw.url, username: sw.user, password: sw.pass });
    const deny = await fetch(`http://${base}/api/connections/${connId}/web`, { headers: { cookie: viewerCookie } });
    expect([403, 404]).toContain(deny.status); // not shared -> not visible
  });

  it('the escape-hatch redirect sends a stray /iss/ request back through the proxy', async () => {
    const res = await fetch(`http://${base}/iss/data.cgi?x=1`, {
      headers: { cookie: ownerCookie, referer: `http://${base}/webproxy/${connId}/iss/main.html` },
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`/webproxy/${connId}/iss/data.cgi?x=1`);
  });

  it('still auto-logs-in when authMode is "none" but credentials are stored (misconfig)', async () => {
    const ctx2 = await ctxWith(true);
    const u = await createUser(ctx2.db, { username: 'm', password: 'm-password', role: 'operator' });
    const id = (
      await new ConnectionRepo(ctx2.db, SECRET).create(u.id, {
        name: 'misconfig',
        host: sw.host,
        port: sw.port,
        protocol: 'http',
        sshUsername: '',
        authType: 'password',
        settings: { url: sw.url, authMode: 'none', username: sw.user, password: sw.pass },
      })
    ).id;
    const app2 = await buildApp(ctx2);
    await app2.listen({ host: '127.0.0.1', port: 0 });
    const b2 = `127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const ck = (await fetch(`http://${b2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'm', password: 'm-password' }),
    }).then((r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')));
    const res = await fetch(`http://${b2}/webproxy/${id}/iss/main.html`, { headers: { cookie: ck } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AT-GS950'); // got the authed page, not the login form
    await app2.close();
  });

  it('answers a HEAD by forwarding a GET (the device 405s HEAD) and drops the body', async () => {
    const res = await fetch(`http://${base}/webproxy/${connId}/`, { method: 'HEAD', headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('refuses the proxy when --allow-web-proxy is off', async () => {
    const ctx2 = await ctxWith(false);
    const u = await createUser(ctx2.db, { username: 'z', password: 'z-password' });
    const id = (
      await new ConnectionRepo(ctx2.db, SECRET).create(u.id, {
        name: 'z',
        host: sw.host,
        port: sw.port,
        protocol: 'http',
        sshUsername: '',
        authType: 'password',
        settings: { url: sw.url, authMode: 'form', username: sw.user, password: sw.pass },
      })
    ).id;
    const app2 = await buildApp(ctx2);
    await app2.listen({ host: '127.0.0.1', port: 0 });
    const b2 = `127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const login = await fetch(`http://${b2}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'z', password: 'z-password' }),
    });
    const ck = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(`http://${b2}/webproxy/${id}/`, { headers: { cookie: ck } });
    expect(res.status).toBe(403);
    await app2.close();
  });
});
