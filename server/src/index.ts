import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pino } from 'pino';
import { loadConfig } from './config.js';

// Load a .env from cwd, or one dir up (repo root when run as
// `node server/dist/index.js`), so `npm start` / start-anterm.bat work without
// an explicit --env-file. Values already in the environment take precedence.
const loadEnvFile = (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile;
if (typeof loadEnvFile === 'function') {
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (existsSync(p)) {
      try {
        loadEnvFile(p);
      } catch {
        /* unreadable / malformed — fall through to real env vars */
      }
      break;
    }
  }
}
import type { AppContext } from './context.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { bootstrapAdmin } from './auth/users.js';
import { SessionService } from './auth/session.js';
import { AuditLog } from './audit.js';
import { ActivityLog } from './activity.js';
import { AppSettingsStore } from './settings.js';
import { Alerter } from './alerts.js';
import { ReachabilityMonitor } from './health/monitor.js';
import { buildApp } from './http/app.js';
import { attachTerminalWs, LiveRegistry } from './ws/terminal.js';
import { WebProxyRegistry } from './web/proxy.js';
import { WebConfigScheduler } from './web/configScheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: process.env.LOG_LEVEL ?? (config.isDev ? 'debug' : 'info'),
    transport: config.isDev ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } : undefined,
  });

  const dbHandle = createDb(config.dbUrl);
  runMigrations(dbHandle.sqlite);
  if (config.record) mkdirSync(config.recordingsDir, { recursive: true });

  const sessions = new SessionService(dbHandle.db, config.sessionTtlHours * 3_600_000);
  await bootstrapAdmin(dbHandle.db, log, { username: config.adminUser, password: config.adminPassword });

  const settings = new AppSettingsStore(dbHandle.db);
  const alerter = new Alerter(settings, log);
  const reachability = new ReachabilityMonitor(dbHandle.db, log, config.allowHosts, 60_000, config.alertAfterFailures);
  reachability.onTransition = (t) => {
    log.info({ name: t.name, status: t.status, from: t.prevStatus }, 'reachability changed');
    void alerter.dispatch(t);
  };
  reachability.start();

  const activity = new ActivityLog(dbHandle.db, log);
  const liveSessions = new LiveRegistry();
  const webProxy = new WebProxyRegistry();
  const ctx: AppContext = {
    config,
    log,
    db: dbHandle.db,
    dbHandle,
    sessions,
    reachability,
    activity,
    settings,
    alerter,
    liveSessions,
    webProxy,
  };

  const webConfig = new WebConfigScheduler(ctx);
  webConfig.start();

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

  // audit retention: drop old sessions/commands + their .cast files
  const audit = new AuditLog(dbHandle.db);
  const retention = async (): Promise<void> => {
    if (config.recordRetentionDays <= 0) return;
    const { ids, paths } = await audit.expiredRecordings(config.recordRetentionDays);
    if (!ids.length) return;
    await audit.deleteSessions(ids);
    for (const p of paths) await rm(join(config.recordingsDir, p), { force: true });
    log.info({ removed: ids.length }, 'audit retention sweep');
    activity.record({
      action: 'session.recordings_pruned',
      detail: { sessions: ids.length, files: paths.length, olderThanDays: config.recordRetentionDays },
    });
  };
  void retention().catch((err) => log.warn({ err }, 'retention sweep failed'));
  const retentionTimer = setInterval(() => void retention().catch(() => {}), 6 * 3600_000);
  retentionTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    clearInterval(retentionTimer);
    reachability.stop();
    webConfig.stop();
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
