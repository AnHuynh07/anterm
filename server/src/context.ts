import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db, DbHandle } from './db/client.js';
import type { SessionService } from './auth/session.js';
import type { ReachabilityMonitor } from './health/monitor.js';
import type { ActivityLog } from './activity.js';

export interface AppContext {
  config: AppConfig;
  log: Logger;
  db: Db;
  dbHandle: DbHandle;
  sessions: SessionService;
  reachability: ReachabilityMonitor;
  activity: ActivityLog;
}
