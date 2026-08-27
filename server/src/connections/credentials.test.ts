import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo } from './repo.js';
import { CredentialRepo, credentialToDto, resolveTarget } from './credentials.js';

const SECRET = 'cred-vault-secret-cred-vault-secret';

async function setup() {
  const h = createDb(':memory:');
  runMigrations(h.sqlite);
  const user = await createUser(h.db, { username: 'u', password: 'pw123456' });
  return {
    userId: user.id,
    conns: new ConnectionRepo(h.db, SECRET),
    creds: new CredentialRepo(h.db, SECRET),
  };
}

describe('CredentialRepo', () => {
  it('stores + resolves a shared credential without leaking secrets', async () => {
    const { userId, creds } = await setup();
    const c = await creds.create(userId, {
      name: 'core-admin',
      sshUsername: 'netadmin',
      authType: 'password',
      secret: 'sshpw',
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
      setupCommands: 'terminal length 0',
    });
    const dto = credentialToDto(c);
    expect(dto).toMatchObject({ name: 'core-admin', sshUsername: 'netadmin', hasSecret: true, hasEnablePassword: true });
    expect(JSON.stringify(dto)).not.toMatch(/sshpw|l0gin|en4ble/);
  });
});

describe('resolveTarget', () => {
  it('uses the linked credential when a connection references one', async () => {
    const { userId, conns, creds } = await setup();
    const cred = await creds.create(userId, {
      name: 'core-admin',
      sshUsername: 'netadmin',
      authType: 'password',
      secret: 'sshpw',
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
      setupCommands: 'terminal length 0\nshow version',
    });
    const conn = await conns.create(userId, {
      name: 'sw1',
      host: '10.0.0.1',
      port: 22,
      sshUsername: '', // provided by credential
      authType: 'password',
      credentialId: cred.id,
    });

    const linked = await creds.get(userId, conn.credentialId!);
    const r = resolveTarget(conn, linked ?? null, SECRET);
    expect(r.source).toBe('credential');
    expect(r.password).toBe('sshpw');
    expect(r.credSshUsername).toBe('netadmin');
    expect(r.autoLogin).toMatchObject({
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
      setupCommands: ['terminal length 0', 'show version'],
    });
  });

  it('falls back to inline connection fields when no credential is linked', async () => {
    const { userId, conns } = await setup();
    const conn = await conns.create(userId, {
      name: 'box',
      host: 'h',
      port: 22,
      sshUsername: 'root',
      authType: 'password',
      secret: 'inlinepw',
    });
    const r = resolveTarget(conn, null, SECRET);
    expect(r.source).toBe('inline');
    expect(r.password).toBe('inlinepw');
    expect(r.autoLogin).toBeNull();
  });

  it('deleting a credential detaches connections (SET NULL)', async () => {
    const { userId, conns, creds } = await setup();
    const cred = await creds.create(userId, { name: 'k', authType: 'agent' });
    const conn = await conns.create(userId, {
      name: 'c',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      credentialId: cred.id,
    });
    await creds.remove(userId, cred.id);
    const after = await conns.get(userId, conn.id);
    expect(after?.credentialId).toBeNull();
  });
});
