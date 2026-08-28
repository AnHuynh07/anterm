import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%s','now'))`;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'operator', 'viewer'] })
      .notNull()
      .default('operator'),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    totpRecoveryEnc: text('totp_recovery_enc'), // JSON array of unused recovery codes (encrypted)
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    usernameIdx: uniqueIndex('users_username_idx').on(t.username),
  }),
);

export const appSessions = sqliteTable(
  'app_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
    userAgent: text('user_agent'),
    clientIp: text('client_ip'),
  },
  (t) => ({
    userIdx: index('app_sessions_user_idx').on(t.userId),
    expiresIdx: index('app_sessions_expires_idx').on(t.expiresAt),
  }),
);

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sshUsername: text('ssh_username'), // optional default; connection can override
    authType: text('auth_type', { enum: ['password', 'key', 'agent'] })
      .notNull()
      .default('password'),
    secretEnc: text('secret_enc'),
    passphraseEnc: text('passphrase_enc'),
    loginUsername: text('login_username'),
    loginPasswordEnc: text('login_password_enc'),
    enablePasswordEnc: text('enable_password_enc'),
    setupCommands: text('setup_commands'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    userNameIdx: uniqueIndex('credentials_user_name_idx').on(t.userId, t.name),
  }),
);

export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    sshUsername: text('ssh_username').notNull().default(''),
    credentialId: text('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    // reach this device by tunnelling through another saved connection (bastion)
    jumpConnectionId: text('jump_connection_id'),
    authType: text('auth_type', { enum: ['password', 'key', 'agent'] })
      .notNull()
      .default('password'),
    // AES-256-GCM ciphertext (base64) — password OR private key material
    secretEnc: text('secret_enc'),
    passphraseEnc: text('passphrase_enc'),
    initCommand: text('init_command'),
    configCommand: text('config_command'), // for config snapshots; default 'show running-config'
    // --- in-band login automation (network devices with AAA login prompts) ---
    loginUsername: text('login_username'),
    loginPasswordEnc: text('login_password_enc'),
    enablePasswordEnc: text('enable_password_enc'),
    setupCommands: text('setup_commands'), // newline-separated, typed after login
    // --- organisation ---
    groupName: text('group_name'),
    tags: text('tags'), // comma-separated, lowercased
    color: text('color', { enum: ['red', 'amber', 'green', 'blue', 'violet'] }),
    antiIdleSeconds: integer('anti_idle_seconds').notNull().default(0), // 0 = off
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    userIdx: index('connections_user_idx').on(t.userId),
    userNameIdx: uniqueIndex('connections_user_name_idx').on(t.userId, t.name),
  }),
);

export const hostKeys = sqliteTable(
  'host_keys',
  {
    id: text('id').primaryKey(),
    // scope by host:port so keys are shared across a user's connections to the same box
    hostport: text('hostport').notNull(),
    keyType: text('key_type').notNull(),
    fingerprintSha256: text('fingerprint_sha256').notNull(),
    addedByUserId: text('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    addedAt: integer('added_at').notNull().default(now),
  },
  (t) => ({
    hostportIdx: uniqueIndex('host_keys_hostport_idx').on(t.hostport),
  }),
);

export const sshSessions = sqliteTable(
  'ssh_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    target: text('target').notNull(), // user@host:port (denormalised for history)
    startedAt: integer('started_at').notNull().default(now),
    endedAt: integer('ended_at'),
    clientIp: text('client_ip'),
    bytesIn: integer('bytes_in').notNull().default(0),
    bytesOut: integer('bytes_out').notNull().default(0),
    exitReason: text('exit_reason'),
    recordingPath: text('recording_path'), // asciinema .cast, relative to recordingsDir
    commandCount: integer('command_count').notNull().default(0),
  },
  (t) => ({
    userIdx: index('ssh_sessions_user_idx').on(t.userId),
    startedIdx: index('ssh_sessions_started_idx').on(t.startedAt),
  }),
);

export const commands = sqliteTable(
  'commands',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sshSessions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    ts: integer('ts').notNull().default(now),
    text: text('text').notNull(),
  },
  (t) => ({
    sessionIdx: index('commands_session_idx').on(t.sessionId),
    userTsIdx: index('commands_user_ts_idx').on(t.userId, t.ts),
  }),
);

export const snippets = sqliteTable(
  'snippets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    command: text('command').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({ userIdx: index('snippets_user_idx').on(t.userId) }),
);

/** Point-in-time capture of a device's running config, for change tracking + diff. */
export const configSnapshots = sqliteTable(
  'config_snapshots',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => sshSessions.id, { onDelete: 'set null' }),
    capturedAt: integer('captured_at').notNull().default(now),
    reason: text('reason').notNull().default('manual'), // 'manual' | 'auto-after-save' | 'auto'
    lines: integer('lines').notNull().default(0),
    changed: integer('changed', { mode: 'boolean' }).notNull().default(true),
    content: text('content').notNull(),
  },
  (t) => ({ connIdx: index('config_snapshots_conn_idx').on(t.connectionId, t.capturedAt) }),
);

/** Grant another user access to a connection they don't own. */
export const connectionShares = sqliteTable(
  'connection_shares',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canEdit: integer('can_edit', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    connUserIdx: uniqueIndex('connection_shares_conn_user_idx').on(t.connectionId, t.userId),
    userIdx: index('connection_shares_user_idx').on(t.userId),
  }),
);

/** Append-only log of management actions (who changed what, logins, host-key trust). */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull().default(now),
    actorId: text('actor_id'), // nullable: failed logins have no resolved user
    actorName: text('actor_name'), // denormalised, survives user deletion
    action: text('action').notNull(),
    target: text('target'),
    detail: text('detail'), // small JSON blob
    ip: text('ip'),
  },
  (t) => ({
    tsIdx: index('audit_events_ts_idx').on(t.ts),
    actorIdx: index('audit_events_actor_idx').on(t.actorId, t.ts),
    actionIdx: index('audit_events_action_idx').on(t.action, t.ts),
  }),
);

/** Small key-value store for admin-editable runtime settings (alert webhook, …). */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** A recorded up/down transition for a connection — powers alerts + the uptime feed. */
export const reachabilityEvents = sqliteTable(
  'reachability_events',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull().default(now),
    status: text('status').notNull(), // 'up' | 'down' | 'unknown'
    prevStatus: text('prev_status'),
    latencyMs: integer('latency_ms'),
    detail: text('detail'),
  },
  (t) => ({
    tsIdx: index('reachability_events_ts_idx').on(t.ts),
    connIdx: index('reachability_events_conn_idx').on(t.connectionId, t.ts),
  }),
);

export type Role = (typeof users.$inferSelect)['role'];
export type User = typeof users.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type SshSession = typeof sshSessions.$inferSelect;
export type Command = typeof commands.$inferSelect;
export type Snippet = typeof snippets.$inferSelect;
export type ConnectionShare = typeof connectionShares.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type ConfigSnapshot = typeof configSnapshots.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type ReachabilityEvent = typeof reachabilityEvents.$inferSelect;
