/**
 * Offline vault backup — same payloads as the admin UI, without a running server.
 *
 *   tsx server/scripts/vault.ts export <out-file> [--format encrypted|json|csv] [--passphrase <s>]
 *   tsx server/scripts/vault.ts import <in-file>  [--passphrase <s>] [--mode skip|replace]
 *
 * Reads ANTERM_APP_SECRET / ANTERM_DB_URL from the environment (or --env-file).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { activeAdminCount, listUsers } from '../src/auth/users.js';
import {
  applyVaultBundle,
  buildVaultBundle,
  decryptBundle,
  parseJsonBundle,
  serialiseBundle,
  type VaultFormat,
} from '../src/vault.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if ((cmd !== 'export' && cmd !== 'import') || !file) {
    console.error('usage: vault.ts export <out> [--format encrypted|json|csv] [--passphrase s]');
    console.error('       vault.ts import <in> [--passphrase s] [--mode skip|replace]');
    process.exit(2);
  }

  const config = loadConfig([]);
  const handle = createDb(config.dbUrl);
  runMigrations(handle.sqlite);

  if (cmd === 'export') {
    const format = (flag('format') ?? 'encrypted') as VaultFormat;
    const bundle = await buildVaultBundle(handle.db, config.appSecret);
    const body = serialiseBundle(bundle, format, flag('passphrase'));
    writeFileSync(file, body);
    console.log(
      `wrote ${file} — ${bundle.connections.length} connections, ${bundle.credentials.length} credentials (${format})`,
    );
  } else {
    const raw = readFileSync(file, 'utf8');
    const bundle = raw.trimStart().startsWith('{') && raw.includes('anterm-vault-encrypted')
      ? decryptBundle(raw, flag('passphrase') ?? '')
      : parseJsonBundle(raw);
    const admins = await listUsers(handle.db).then((us) => us.filter((u) => u.role === 'admin' && !u.disabled));
    if (!admins.length || !(await activeAdminCount(handle.db))) {
      console.error('no active admin in the target database — create one first');
      process.exit(1);
    }
    const summary = await applyVaultBundle(handle.db, config.appSecret, bundle, {
      mode: (flag('mode') ?? 'skip') as 'skip' | 'replace',
      fallbackOwnerId: admins[0]!.id,
    });
    console.log(JSON.stringify(summary, null, 2));
  }
  handle.close();
}

main().catch((err) => {
  console.error('vault:', (err as Error).message);
  process.exit(1);
});
