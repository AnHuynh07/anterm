import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import yaml from 'js-yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

/**
 * Configuration is merged with this precedence:
 *   CLI flags  >  ANTERM_* env vars  >  --conf file (yaml/json)  >  defaults
 *
 * The WeTTY-style `--ssh-*` flags enable an optional "ad-hoc" mode where users
 * can open a terminal without any saved DB connection (login is still required).
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (!v) return [] as string[];
    const arr = Array.isArray(v) ? v : v.split(',');
    return arr.map((s) => s.trim()).filter(Boolean);
  });

const schema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(3000),
  base: z
    .string()
    .default('/')
    .transform((b) => {
      let s = b.startsWith('/') ? b : `/${b}`;
      if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
      return s;
    }),
  appSecret: z.string().min(16, 'ANTERM_APP_SECRET must be at least 16 characters'),
  dbUrl: z.string().default('./data/anterm.sqlite'),
  adminUser: z.string().optional(),
  adminPassword: z.string().optional(),
  allowIframe: bool.default(false),
  allowHosts: csv,
  sslKey: z.string().optional(),
  sslCert: z.string().optional(),
  trustProxy: bool.default(true),

  // session / limits
  sessionTtlHours: z.coerce.number().positive().default(12),
  sshIdleTimeoutMin: z.coerce.number().nonnegative().default(0), // 0 = disabled
  sshMaxDurationMin: z.coerce.number().nonnegative().default(0),
  // keep an SSH session alive this long after the websocket drops, for resume-on-reconnect
  resumeGraceSec: z.coerce.number().nonnegative().default(90),

  // audit
  record: bool.default(true), // record session I/O + command log
  recordDir: z.string().optional(), // default: <dbdir>/recordings
  recordRetentionDays: z.coerce.number().nonnegative().default(30), // 0 = keep forever

  // WeTTY-style ad-hoc SSH defaults
  ssh: z.object({
    host: z.string().optional(),
    port: z.coerce.number().int().positive().default(22),
    user: z.string().optional(),
    auth: csv, // e.g. ["password","publickey"]
    key: z.string().optional(), // path to private key file
    knownHosts: z.string().optional(),
    command: z.string().optional(),
    forceSsh: bool.default(false),
  }),
});

export type AppConfig = z.infer<typeof schema> & {
  adhocEnabled: boolean;
  localShell: boolean;
  isDev: boolean;
  /** resolved recordings directory */
  recordingsDir: string;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function loadConfFile(path: string): Record<string, unknown> {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = extname(path).toLowerCase() === '.json' ? JSON.parse(raw) : yaml.load(raw);
  return (parsed ?? {}) as Record<string, unknown>;
}

export function loadConfig(argv = hideBin(process.argv)): AppConfig {
  const parsed = yargs(argv)
    .scriptName('anterm')
    .env('ANTERM')
    .option('conf', { type: 'string', describe: 'Path to a yaml/json config file' })
    .option('host', { type: 'string', describe: 'HTTP listen address' })
    .option('port', { type: 'number', describe: 'HTTP listen port' })
    .option('base', { type: 'string', describe: 'Base path for reverse-proxy sub-path hosting' })
    .option('app-secret', { type: 'string', describe: 'Master secret (encrypts credentials, signs cookies)' })
    .option('db-url', { type: 'string', describe: 'SQLite database file path' })
    .option('admin-user', { type: 'string' })
    .option('admin-password', { type: 'string' })
    .option('allow-iframe', { type: 'boolean' })
    .option('allow-hosts', { type: 'string', describe: 'Comma-separated SSH target allowlist' })
    .option('trust-proxy', { type: 'boolean', describe: 'Honour X-Forwarded-* headers (default true)' })
    .option('session-ttl-hours', { type: 'number' })
    .option('ssh-idle-timeout-min', { type: 'number', describe: 'Close idle SSH sessions after N minutes (0 = off)' })
    .option('ssh-max-duration-min', { type: 'number', describe: 'Hard cap on SSH session length (0 = off)' })
    .option('resume-grace-sec', { type: 'number', describe: 'Keep SSH alive N s after a WS drop for resume (0 = off)' })
    .option('record', { type: 'boolean', describe: 'Record session I/O + command log (default true)' })
    .option('record-dir', { type: 'string', describe: 'Directory for .cast recordings' })
    .option('record-retention-days', { type: 'number', describe: 'Delete recordings older than N days (0 = keep)' })
    .option('ssl-key', { type: 'string' })
    .option('ssl-cert', { type: 'string' })
    .option('ssh-host', { type: 'string', describe: 'Ad-hoc mode: default SSH host' })
    .option('ssh-port', { type: 'number' })
    .option('ssh-user', { type: 'string' })
    .option('ssh-auth', { type: 'string', describe: 'Comma list: password,publickey,keyboard-interactive' })
    .option('ssh-key', { type: 'string', describe: 'Path to a default private key' })
    .option('known-hosts', { type: 'string' })
    .option('ssh-command', { type: 'string', describe: 'Run a command instead of an interactive shell' })
    .option('force-ssh', { type: 'boolean' })
    .help()
    .parseSync();

  const fileCfg = parsed.conf ? loadConfFile(parsed.conf) : {};
  const fileSsh = (fileCfg.ssh ?? {}) as Record<string, unknown>;

  const merged = {
    host: parsed.host ?? fileCfg.host,
    port: parsed.port ?? fileCfg.port,
    base: parsed.base ?? fileCfg.base,
    appSecret: parsed.appSecret ?? fileCfg.appSecret ?? process.env.ANTERM_APP_SECRET,
    dbUrl: parsed.dbUrl ?? fileCfg.dbUrl,
    adminUser: parsed.adminUser ?? fileCfg.adminUser ?? process.env.ADMIN_USER,
    adminPassword: parsed.adminPassword ?? fileCfg.adminPassword ?? process.env.ADMIN_PASSWORD,
    allowIframe: parsed.allowIframe ?? fileCfg.allowIframe,
    allowHosts: parsed.allowHosts ?? fileCfg.allowHosts,
    sslKey: parsed.sslKey ?? fileCfg.sslKey,
    sslCert: parsed.sslCert ?? fileCfg.sslCert,
    trustProxy: parsed.trustProxy ?? fileCfg.trustProxy,
    sessionTtlHours: parsed.sessionTtlHours ?? fileCfg.sessionTtlHours,
    sshIdleTimeoutMin: parsed.sshIdleTimeoutMin ?? fileCfg.sshIdleTimeoutMin,
    sshMaxDurationMin: parsed.sshMaxDurationMin ?? fileCfg.sshMaxDurationMin,
    resumeGraceSec: parsed.resumeGraceSec ?? fileCfg.resumeGraceSec,
    record: parsed.record ?? fileCfg.record,
    recordDir: parsed.recordDir ?? fileCfg.recordDir,
    recordRetentionDays: parsed.recordRetentionDays ?? fileCfg.recordRetentionDays,
    ssh: {
      host: parsed.sshHost ?? fileSsh.host,
      port: parsed.sshPort ?? fileSsh.port,
      user: parsed.sshUser ?? fileSsh.user,
      auth: parsed.sshAuth ?? fileSsh.auth,
      key: parsed.sshKey ?? fileSsh.key,
      knownHosts: parsed.knownHosts ?? fileSsh.knownHosts,
      command: parsed.sshCommand ?? fileSsh.command,
      forceSsh: parsed.forceSsh ?? fileSsh.forceSsh,
    },
  };

  const cfg = schema.parse(merged);
  const recordingsDir =
    cfg.recordDir ??
    (cfg.dbUrl === ':memory:' ? resolve('./data/recordings') : resolve(dirname(cfg.dbUrl), 'recordings'));
  return {
    ...cfg,
    adhocEnabled: Boolean(cfg.ssh.host),
    // WeTTY-style: `--ssh-host localhost` with no --force-ssh means a local PTY.
    localShell: Boolean(cfg.ssh.host && LOOPBACK.has(cfg.ssh.host) && !cfg.ssh.forceSsh),
    isDev: process.env.NODE_ENV !== 'production',
    recordingsDir,
  };
}
