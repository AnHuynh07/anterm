import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../auth/users.js';
import { ConnectionRepo, normTags, toDto } from './repo.js';

const SECRET = 'repo-test-secret-repo-test-secret-1';

async function setup() {
  const h = createDb(':memory:');
  runMigrations(h.sqlite);
  const user = await createUser(h.db, { username: 'u', password: 'pw123456' });
  return { repo: new ConnectionRepo(h.db, SECRET), userId: user.id };
}

describe('normTags', () => {
  it('lowercases, splits on comma/space, dedupes', () => {
    expect(normTags('Cisco, EDGE cisco  prod')).toBe('cisco,edge,prod');
    expect(normTags('')).toBeNull();
    expect(normTags(null)).toBeNull();
  });
});

describe('ConnectionRepo organisation fields', () => {
  it('stores group/tags/color and exposes them via DTO', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'core-sw1',
      host: '10.0.0.1',
      port: 22,
      sshUsername: 'admin',
      authType: 'password',
      secret: 'pw',
      groupName: 'Site A / Core',
      tags: 'Cisco, PROD, cisco',
      color: 'red',
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
    });
    const dto = toDto(c);
    expect(dto.groupName).toBe('Site A / Core');
    expect(dto.tags).toEqual(['cisco', 'prod']);
    expect(dto.color).toBe('red');
    expect(dto.hasLoginPassword).toBe(true);
    expect(dto.hasEnablePassword).toBe(true);
    // secrets never leak
    expect(JSON.stringify(dto)).not.toMatch(/l0gin|en4ble|(^|[^p])pw/);
  });

  it('clamps antiIdleSeconds (0 = off, else 15..3600)', async () => {
    const { repo, userId } = await setup();
    const mk = (n: number) =>
      repo.create(userId, {
        name: `ai-${n}`,
        host: 'h',
        port: 22,
        sshUsername: 'u',
        authType: 'agent',
        antiIdleSeconds: n,
      });
    expect(toDto(await mk(0)).antiIdleSeconds).toBe(0);
    expect(toDto(await mk(5)).antiIdleSeconds).toBe(15);
    expect(toDto(await mk(120)).antiIdleSeconds).toBe(120);
    expect(toDto(await mk(999999)).antiIdleSeconds).toBe(3600);
  });

  it('rejects an unknown colour (stored as null)', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'x',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      color: 'chartreuse',
    });
    expect(toDto(c).color).toBeNull();
  });

  it('update clears group/tags when blank', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'y',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      groupName: 'G',
      tags: 'a,b',
    });
    const updated = await repo.update(userId, c.id, {
      name: 'y',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      groupName: '',
      tags: '',
    });
    expect(toDto(updated!).groupName).toBeNull();
    expect(toDto(updated!).tags).toEqual([]);
  });

  it('stores a runbook and clears it when blanked', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'rb',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      runbook: '  ## Reboot\n- console in rack 3  ',
    });
    expect(toDto(c).runbook).toBe('## Reboot\n- console in rack 3');
    const cleared = await repo.update(userId, c.id, {
      name: 'rb',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'agent',
      runbook: '   ',
    });
    expect(toDto(cleared!).runbook).toBeNull();
  });

  it('web device: encrypts the password, DTO hides it, resolveWebTarget decrypts', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'gs950',
      host: '10.195.32.34',
      port: 443,
      protocol: 'http',
      sshUsername: '',
      authType: 'password',
      settings: { url: 'http://10.195.32.34/', authMode: 'form', username: 'manager', password: 'friend' },
    });
    const dto = toDto(c);
    expect(dto.protocol).toBe('http');
    expect(dto.web).toMatchObject({ url: 'http://10.195.32.34/', authMode: 'form', username: 'manager', hasPassword: true });
    expect(JSON.stringify(dto)).not.toMatch(/friend/); // password never leaves
    expect(c.settings).not.toContain('friend'); // encrypted at rest

    const resolved = repo.resolveWebTarget(c);
    expect(resolved).toMatchObject({ url: 'http://10.195.32.34/', username: 'manager', password: 'friend', loginPath: '/iss/redirect.html' });

    // edit without a password keeps the stored one
    const edited = await repo.update(userId, c.id, {
      name: 'gs950',
      host: '10.195.32.34',
      port: 443,
      protocol: 'http',
      sshUsername: '',
      authType: 'password',
      settings: { url: 'http://10.195.32.34/mgmt', authMode: 'form', username: 'manager' },
    });
    expect(repo.resolveWebTarget(edited!)?.password).toBe('friend');
    expect(repo.resolveWebTarget(edited!)?.url).toBe('http://10.195.32.34/mgmt');
  });

  it('resolveLoginAutomation decrypts round-trip', async () => {
    const { repo, userId } = await setup();
    const c = await repo.create(userId, {
      name: 'z',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'password',
      secret: 'sshpw',
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
      setupCommands: 'terminal length 0\n\nshow version',
    });
    const auto = repo.resolveLoginAutomation(c);
    expect(auto).toMatchObject({
      loginUsername: 'netadmin',
      loginPassword: 'l0gin',
      enablePassword: 'en4ble',
      setupCommands: ['terminal length 0', 'show version'],
    });
  });
});
