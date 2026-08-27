import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createUser } from './auth/users.js';
import { ConnectionRepo } from './connections/repo.js';
import { CredentialRepo } from './connections/credentials.js';
import { decryptSecret } from './crypto/secrets.js';
import {
  applyVaultBundle,
  buildVaultBundle,
  decryptBundle,
  encryptBundle,
  parseJsonBundle,
} from './vault.js';

const A = 'aaaaaaaaaaaaaaaa-secret-one';
const B = 'bbbbbbbbbbbbbbbb-secret-two';

let src: DbHandle;

beforeEach(async () => {
  src = createDb(':memory:');
  runMigrations(src.sqlite);
  const admin = await createUser(src.db, { username: 'boss', password: 'x'.repeat(10), role: 'admin' });
  const op = await createUser(src.db, { username: 'neteng', password: 'x'.repeat(10), role: 'operator' });

  const creds = new CredentialRepo(src.db, A);
  const core = await creds.create(op.id, {
    name: 'core-admin',
    authType: 'password',
    secret: 's3cr3t-pw',
    loginUsername: 'netadmin',
    loginPassword: 'l0gin',
    enablePassword: 'en4ble',
  });

  const repo = new ConnectionRepo(src.db, A);
  await repo.create(op.id, {
    name: 'sw-01',
    host: '10.0.0.1',
    port: 22,
    sshUsername: 'admin',
    authType: 'password',
    credentialId: core.id,
    tags: 'cisco',
  });
  await repo.create(admin.id, {
    name: 'fw-01',
    host: '10.0.0.2',
    port: 22,
    sshUsername: 'root',
    authType: 'password',
    secret: 'inline-pw',
  });
});

afterEach(() => src.close());

describe('vault bundle', () => {
  it('captures decrypted secrets', async () => {
    const bundle = await buildVaultBundle(src.db, A);
    expect(bundle.credentials).toHaveLength(1);
    expect(bundle.credentials[0]).toMatchObject({
      owner: 'neteng',
      name: 'core-admin',
      secret: 's3cr3t-pw',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
    });
    expect(bundle.connections.find((c) => c.name === 'fw-01')?.secret).toBe('inline-pw');
    expect(bundle.connections.find((c) => c.name === 'sw-01')?.credential).toBe('core-admin');
  });

  it('encrypted archive round-trips and rejects a wrong passphrase', () => {
    const bundle = parseJsonBundle(JSON.stringify({ format: 'anterm-vault', version: 1, exportedAt: '', credentials: [], connections: [] }));
    const file = encryptBundle(bundle, 'passphrase-123');
    expect(decryptBundle(file, 'passphrase-123').format).toBe('anterm-vault');
    expect(() => decryptBundle(file, 'wrong-one')).toThrow(/passphrase|corrupt/i);
  });

  it('imports into a fresh instance under a different app secret', async () => {
    const bundle = await buildVaultBundle(src.db, A);
    const file = encryptBundle(bundle, 'pass-1234');

    const dst = createDb(':memory:');
    runMigrations(dst.sqlite);
    const boss2 = await createUser(dst.db, { username: 'boss', password: 'x'.repeat(10), role: 'admin' });
    // note: 'neteng' does NOT exist in dst — those rows fall back to boss2

    const restored = decryptBundle(file, 'pass-1234');
    const summary = await applyVaultBundle(dst.db, B, restored, { mode: 'skip', fallbackOwnerId: boss2.id });
    expect(summary.credentials.created).toBe(1);
    expect(summary.connections.created).toBe(2);
    expect(summary.errors).toEqual([]);

    // secret is now encrypted under B and still decrypts to the original
    const cred = await dst.db.query.credentials.findFirst();
    expect(decryptSecret(cred!.secretEnc!, B)).toBe('s3cr3t-pw');
    expect(decryptSecret(cred!.loginPasswordEnc!, B)).toBe('l0gin');

    const sw = await new ConnectionRepo(dst.db, B).list(boss2.id);
    const link = sw.find((c) => c.name === 'sw-01');
    expect(link?.credentialId).toBe(cred!.id); // credential ref rewired by name+owner
    expect(decryptSecret(sw.find((c) => c.name === 'fw-01')!.secretEnc!, B)).toBe('inline-pw');
    dst.close();
  });

  it('skip vs replace on name conflict', async () => {
    const bundle = await buildVaultBundle(src.db, A);
    const boss = (await src.db.query.users.findMany()).find((u) => u.username === 'boss')!;

    const skip = await applyVaultBundle(src.db, A, bundle, { mode: 'skip', fallbackOwnerId: boss.id });
    expect(skip.connections.skipped).toBe(2);
    expect(skip.credentials.skipped).toBe(1);

    const replace = await applyVaultBundle(src.db, A, bundle, { mode: 'replace', fallbackOwnerId: boss.id });
    expect(replace.connections.updated).toBe(2);
  });
});
