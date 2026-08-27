import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { SessionService } from '../auth/session.js';
import { createUser } from '../auth/users.js';
import { buildApp } from '../http/app.js';
import { attachTerminalWs } from './terminal.js';
import { startSshFixture, type SshFixture } from '../../test/sshFixture.js';

const APP_SECRET = 'adhoc-secret-adhoc-secret-adhoc-1';

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let fx: SshFixture;
let cookie: string;

beforeAll(async () => {
  fx = await startSshFixture();
  // --ssh-host enables ad-hoc mode; --force-ssh keeps loopback targets on SSH.
  const config = loadConfig([
    '--app-secret',
    APP_SECRET,
    '--db-url',
    ':memory:',
    '--ssh-host',
    '127.0.0.1',
    '--force-ssh',
  ]);
  expect(config.adhocEnabled).toBe(true);
  expect(config.localShell).toBe(false);

  const log = pino({ level: 'silent' });
  const dbHandle = createDb(':memory:');
  runMigrations(dbHandle.sqlite);
  const sessions = new SessionService(dbHandle.db, 3_600_000);
  const ctx: AppContext = { config, log, db: dbHandle.db, dbHandle, sessions };
  await createUser(dbHandle.db, { username: 'a', password: 'a-password', role: 'user' });

  app = await buildApp(ctx);
  attachTerminalWs(app.server, ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const res = await fetch(`http://${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'a', password: 'a-password' }),
  });
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
});

afterAll(async () => {
  await app?.close();
  await fx?.close();
});

describe('ad-hoc terminal', () => {
  it('/health advertises ad-hoc mode', async () => {
    const res = await fetch(`http://${baseUrl}/api/health`);
    expect((await res.json()).adhoc).toBe(true);
  });

  it('connects to a user-supplied ad-hoc target', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws/terminal`, { headers: { cookie } });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${output}`)), 15_000);
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            t: 'open',
            adhoc: { host: fx.host, port: fx.port, username: fx.username, password: fx.password },
            cols: 80,
            rows: 24,
          }),
        ),
      );
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          output += data.toString();
          if (output.includes('adhoc-ok')) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hostkey-prompt') ws.send(JSON.stringify({ t: 'hostkey', accept: true }));
        if (msg.t === 'status' && msg.state === 'ready') ws.send(Buffer.from('echo adhoc-ok\n'));
        if (msg.t === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on('error', reject);
    });
    expect(output).toContain('adhoc-ok');
  });
});
