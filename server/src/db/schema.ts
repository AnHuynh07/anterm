import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%s','now'))`;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
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
    authType: text('auth_type', { enum: ['password', 'key', 'agent'] })
      .notNull()
      .default('password'),
    // AES-256-GCM ciphertext (base64) — password OR private key material
    secretEnc: text('secret_enc'),
    passphraseEnc: text('passphrase_enc'),
    initCommand: text('init_command'),
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

export type User = typeof users.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type SshSession = typeof sshSessions.$inferSelect;
export type Command = typeof commands.$inferSelect;
export type Snippet = typeof snippets.$inferSelect;
