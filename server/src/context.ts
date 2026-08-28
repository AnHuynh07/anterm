import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db, DbHandle } from './db/client.js';
import type { SessionService } from './auth/session.js';
import type { ReachabilityMonitor } from './health/monitor.js';
import type { ActivityLog } from './activity.js';
import type { AppSettingsStore } from './settings.js';
import type { Alerter } from './alerts.js';
import type { LiveRegistry } from './ws/terminal.js';
import type { WebProxyRegistry } from './web/proxy.js';

export interface AppContext {
  config: AppConfig;
  log: Logger;
  db: Db;
  dbHandle: DbHandle;
  sessions: SessionService;
  reachability: ReachabilityMonitor;
  activity: ActivityLog;
  settings: AppSettingsStore;
  alerter: Alerter;
  /** process-wide table of running terminal sessions (for re-attach) */
  liveSessions: LiveRegistry;
  /** per-user reverse-proxy sessions to web-managed devices */
  webProxy: WebProxyRegistry;
}
