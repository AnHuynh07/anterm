import { pino } from 'pino';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { bootstrapAdmin } from './auth/users.js';
import { SessionService } from './auth/session.js';
import { buildApp } from './http/app.js';
import { attachTerminalWs } from './ws/terminal.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: process.env.LOG_LEVEL ?? (config.isDev ? 'debug' : 'info'),
    transport: config.isDev ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } : undefined,
  });

  const dbHandle = createDb(config.dbUrl);
  runMigrations(dbHandle.sqlite);

  const sessions = new SessionService(dbHandle.db, config.sessionTtlHours * 3_600_000);
  await bootstrapAdmin(dbHandle.db, log, { username: config.adminUser, password: config.adminPassword });

  const ctx: AppContext = { config, log, db: dbHandle.db, dbHandle, sessions };

  const app = await buildApp(ctx);
  const detachWs = attachTerminalWs(app.server, ctx);

  await app.listen({ host: config.host, port: config.port });
  const scheme = config.sslKey && config.sslCert ? 'https' : 'http';
  log.info(
    `AnTerm listening on ${scheme}://${config.host}:${config.port}${config.base}` +
      (config.adhocEnabled ? '  (ad-hoc SSH enabled)' : ''),
  );

  const sweep = setInterval(() => void sessions.sweepExpired().catch(() => {}), 15 * 60_000);
  sweep.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    detachWs();
    await app.close();
    dbHandle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
