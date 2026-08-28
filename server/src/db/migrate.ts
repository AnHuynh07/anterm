import type Database from 'better-sqlite3';

/**
 * Lightweight forward-only migrator. Each entry runs once, tracked in
 * `_migrations`. Keeps first-run zero-config (no drizzle-kit needed at runtime);
 * `drizzle-kit generate` is still available for authoring future changes.
 */
const migrations: { id: string; sql: string }[] = [
  {
    id: '0001_init',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);

      CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        user_agent TEXT,
        client_ip TEXT
      );
      CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions (user_id);
      CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON app_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        ssh_username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret_enc TEXT,
        passphrase_enc TEXT,
        init_command TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS connections_user_name_idx ON connections (user_id, name);

      CREATE TABLE IF NOT EXISTS host_keys (
        id TEXT PRIMARY KEY,
        hostport TEXT NOT NULL,
        key_type TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL,
        added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS host_keys_hostport_idx ON host_keys (hostport);

      CREATE TABLE IF NOT EXISTS ssh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        target TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        ended_at INTEGER,
        client_ip TEXT,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        exit_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS ssh_sessions_user_idx ON ssh_sessions (user_id);
      CREATE INDEX IF NOT EXISTS ssh_sessions_started_idx ON ssh_sessions (started_at);
    `,
  },
  {
    id: '0002_login_automation',
    sql: /* sql */ `
      ALTER TABLE connections ADD COLUMN login_username TEXT;
      ALTER TABLE connections ADD COLUMN login_password_enc TEXT;
      ALTER TABLE connections ADD COLUMN enable_password_enc TEXT;
      ALTER TABLE connections ADD COLUMN setup_commands TEXT;
    `,
  },
  {
    id: '0003_organisation',
    sql: /* sql */ `
      ALTER TABLE connections ADD COLUMN group_name TEXT;
      ALTER TABLE connections ADD COLUMN tags TEXT;
      ALTER TABLE connections ADD COLUMN color TEXT;
      CREATE INDEX IF NOT EXISTS connections_group_idx ON connections (user_id, group_name);
    `,
  },
  {
    id: '0004_credential_vault',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        ssh_username TEXT,
        auth_type TEXT NOT NULL DEFAULT 'password',
        secret_enc TEXT,
        passphrase_enc TEXT,
        login_username TEXT,
        login_password_enc TEXT,
        enable_password_enc TEXT,
        setup_commands TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS credentials_user_name_idx ON credentials (user_id, name);
      ALTER TABLE connections ADD COLUMN credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '0005_recording_and_commands',
    sql: /* sql */ `
      ALTER TABLE ssh_sessions ADD COLUMN recording_path TEXT;
      ALTER TABLE ssh_sessions ADD COLUMN command_count INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ssh_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commands_session_idx ON commands (session_id);
      CREATE INDEX IF NOT EXISTS commands_user_ts_idx ON commands (user_id, ts);
    `,
  },
  {
    id: '0006_snippets_and_antiidle',
    sql: /* sql */ `
      ALTER TABLE connections ADD COLUMN anti_idle_seconds INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS snippets_user_idx ON snippets (user_id);
    `,
  },
  {
    id: '0007_rbac_and_activity',
    sql: /* sql */ `
      -- role model: admin / operator / viewer  (legacy 'user' becomes 'operator')
      UPDATE users SET role = 'operator' WHERE role NOT IN ('admin', 'operator', 'viewer');

      CREATE TABLE IF NOT EXISTS connection_shares (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        can_edit INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS connection_shares_conn_user_idx ON connection_shares (connection_id, user_id);
      CREATE INDEX IF NOT EXISTS connection_shares_user_idx ON connection_shares (user_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        actor_id TEXT,
        actor_name TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_events_ts_idx ON audit_events (ts);
      CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_id, ts);
      CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, ts);
    `,
  },
  {
    id: '0008_jump_host',
    sql: /* sql */ `
      ALTER TABLE connections ADD COLUMN jump_connection_id TEXT
        REFERENCES connections(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS connections_jump_idx ON connections (jump_connection_id);
    `,
  },
  {
    id: '0009_config_snapshots',
    sql: /* sql */ `
      ALTER TABLE connections ADD COLUMN config_command TEXT;
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES ssh_sessions(id) ON DELETE SET NULL,
        captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        reason TEXT NOT NULL DEFAULT 'manual',
        lines INTEGER NOT NULL DEFAULT 0,
        changed INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS config_snapshots_conn_idx ON config_snapshots (connection_id, captured_at);
    `,
  },
  {
    id: '0010_totp',
    sql: /* sql */ `
      ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
      ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN totp_recovery_enc TEXT;
    `,
  },
];

export function runMigrations(raw: Database.Database): void {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));`,
  );
  const applied = new Set<string>(
    raw
      .prepare('SELECT id FROM _migrations')
      .all()
      .map((r) => (r as { id: string }).id),
  );
  const insert = raw.prepare('INSERT INTO _migrations (id) VALUES (?)');
  const tx = raw.transaction((pending: typeof migrations) => {
    for (const m of pending) {
      raw.exec(m.sql);
      insert.run(m.id);
    }
  });
  const pending = migrations.filter((m) => !applied.has(m.id));
  if (pending.length) tx(pending);
}
