import { describe, expect, it } from 'vitest';
import { parseCsv, parseImport, toCsv, toPortable, type PortableConnection } from './portable.js';
import type { Connection } from '../db/schema.js';

const sample: PortableConnection = {
  name: 'core-sw1',
  host: '10.0.0.1',
  port: 22,
  sshUsername: 'admin',
  credential: 'core-admin',
  authType: 'password',
  group: 'Site A / Core',
  tags: 'cisco,prod',
  color: 'red',
  loginUsername: 'netadmin',
  setupCommands: 'terminal length 0\nshow version',
  initCommand: null,
};

describe('portable CSV', () => {
  it('round-trips including quoted fields with commas and newlines', () => {
    const csv = toCsv([sample]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'core-sw1',
      host: '10.0.0.1',
      group: 'Site A / Core',
      tags: 'cisco,prod',
      setupCommands: 'terminal length 0\nshow version',
    });
  });
});

describe('parseImport', () => {
  it('reads a JSON array', () => {
    const out = parseImport('json', JSON.stringify([{ name: 'a', host: 'h', port: 2222, sshUsername: 'u' }]));
    expect(out[0]).toMatchObject({ name: 'a', host: 'h', port: 2222, sshUsername: 'u', authType: 'password' });
  });

  it('reads a { connections: [...] } wrapper', () => {
    const out = parseImport('json', JSON.stringify({ connections: [{ name: 'a', host: 'h' }] }));
    expect(out[0].name).toBe('a');
    expect(out[0].port).toBe(22);
  });

  it('reads CSV with a header row', () => {
    const csv = 'name,host,port,sshUsername,credential\nsw1,10.0.0.9,22,admin,core-admin\n';
    const out = parseImport('csv', csv);
    expect(out[0]).toMatchObject({ name: 'sw1', host: '10.0.0.9', credential: 'core-admin' });
  });

  it('tolerates alternate column names and coerces invalid values', () => {
    const out = parseImport('json', JSON.stringify([{ name: 'x', host: 'h', ssh_username: 'root', authType: 'bogus' }]));
    expect(out[0].sshUsername).toBe('root');
    expect(out[0].authType).toBe('password');
  });
});

describe('toPortable', () => {
  it('omits secret fields', () => {
    const conn = {
      name: 'n',
      host: 'h',
      port: 22,
      sshUsername: 'u',
      authType: 'password',
      secretEnc: 'v1.aaa.bbb.ccc',
      loginPasswordEnc: 'v1.x.y.z',
      groupName: 'G',
      tags: 'a,b',
      color: 'blue',
      loginUsername: 'netadmin',
      setupCommands: null,
      initCommand: null,
      credentialId: null,
    } as unknown as Connection;
    const p = toPortable(conn, null);
    expect(JSON.stringify(p)).not.toMatch(/secretEnc|loginPasswordEnc|v1\./);
    expect(p).toMatchObject({ group: 'G', color: 'blue', loginUsername: 'netadmin' });
  });
});
