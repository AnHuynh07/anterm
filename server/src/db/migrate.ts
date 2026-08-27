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
