import { randomUUID, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { connections, credentials } from './db/schema.js';
import { encryptSecret, maybeDecrypt } from './crypto/secrets.js';
import { normTags } from './connections/repo.js';

/**
 * Vault backup / migration. Unlike the inventory import/export (portable.ts,
 * which deliberately drops secrets), this carries **decrypted** SSH passwords and
 * keys — it is admin-only, re-auth gated, and can be disabled server-side.
 *
 *   encrypted  — a `.anterm` file, AES-256-GCM under a passphrase you type in.
 *                Portable across a change of ANTERM_APP_SECRET. Round-trips.
 *   json       — the same bundle, plaintext. Round-trips.
 *   csv        — connections flattened with secrets. Human-readable, export only.
 */

export type VaultFormat = 'encrypted' | 'json' | 'csv';

export interface VaultCredential {
  owner: string;
  name: string;
  sshUsername: string | null;
  authType: 'password' | 'key' | 'agent';
  secret: string | null;
  passphrase: string | null;
  loginUsername: string | null;
  loginPassword: string | null;
  enablePassword: string | null;
  setupCommands: string | null;
}

export interface VaultConnection {
  owner: string;
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  credential: string | null;
  authType: 'password' | 'key' | 'agent';
  secret: string | null;
  passphrase: string | null;
  initCommand: string | null;
  loginUsername: string | null;
  loginPassword: string | null;
  enablePassword: string | null;
  setupCommands: string | null;
  groupName: string | null;
  tags: string | null;
  color: string | null;
  antiIdleSeconds: number;
}

export interface VaultBundle {
  format: 'anterm-vault';
  version: 1;
  exportedAt: string;
  credentials: VaultCredential[];
  connections: VaultConnection[];
}

// ---------------------------------------------------------------- build / apply

export async function buildVaultBundle(db: Db, appSecret: string): Promise<VaultBundle> {
  const [us, creds, conns] = await Promise.all([
    db.query.users.findMany(),
    db.query.credentials.findMany(),
    db.query.connections.findMany(),
  ]);
  const userById = new Map(us.map((u) => [u.id, u.username]));
  const credNameById = new Map(creds.map((c) => [c.id, c.name]));

  return {
    format: 'anterm-vault',
    version: 1,
    exportedAt: new Date().toISOString(),
    credentials: creds.map((c) => ({
      owner: userById.get(c.userId) ?? '',
      name: c.name,
      sshUsername: c.sshUsername ?? null,
      authType: c.authType,
      secret: maybeDecrypt(c.secretEnc, appSecret) ?? null,
      passphrase: maybeDecrypt(c.passphraseEnc, appSecret) ?? null,
      loginUsername: c.loginUsername ?? null,
      loginPassword: maybeDecrypt(c.loginPasswordEnc, appSecret) ?? null,
      enablePassword: maybeDecrypt(c.enablePasswordEnc, appSecret) ?? null,
      setupCommands: c.setupCommands ?? null,
    })),
    connections: conns.map((c) => ({
      owner: userById.get(c.userId) ?? '',
      name: c.name,
      host: c.host,
      port: c.port,
      sshUsername: c.sshUsername,
      credential: c.credentialId ? (credNameById.get(c.credentialId) ?? null) : null,
      authType: c.authType,
      secret: maybeDecrypt(c.secretEnc, appSecret) ?? null,
      passphrase: maybeDecrypt(c.passphraseEnc, appSecret) ?? null,
      initCommand: c.initCommand ?? null,
      loginUsername: c.loginUsername ?? null,
      loginPassword: maybeDecrypt(c.loginPasswordEnc, appSecret) ?? null,
      enablePassword: maybeDecrypt(c.enablePasswordEnc, appSecret) ?? null,
      setupCommands: c.setupCommands ?? null,
      groupName: c.groupName ?? null,
      tags: c.tags ?? null,
      color: c.color ?? null,
      antiIdleSeconds: c.antiIdleSeconds,
    })),
  };
}

export interface ImportSummary {
  credentials: { created: number; updated: number; skipped: number };
  connections: { created: number; updated: number; skipped: number };
  errors: string[];
}

/**
 * Write a bundle into the DB, re-encrypting every secret under this instance's
 * app secret. Owners are matched by username; anything whose owner no longer
 * exists is assigned to `fallbackOwnerId` (the admin doing the import).
 */
export async function applyVaultBundle(
  db: Db,
  appSecret: string,
  bundle: VaultBundle,
  opts: { mode: 'skip' | 'replace'; fallbackOwnerId: string },
): Promise<ImportSummary> {
  const enc = (v: string | null | undefined) => (v ? encryptSecret(v, appSecret) : null);
  const summary: ImportSummary = {
    credentials: { created: 0, updated: 0, skipped: 0 },
    connections: { created: 0, updated: 0, skipped: 0 },
    errors: [],
  };

  const us = await db.query.users.findMany();
  const idByName = new Map(us.map((u) => [u.username.toLowerCase(), u.id]));
  const ownerId = (name: string) => idByName.get(name.toLowerCase()) ?? opts.fallbackOwnerId;

  // credentials first — connections reference them by (owner, name)
  const credIdByKey = new Map<string, string>(); // `${ownerId}:${name}` -> id
  for (const c of bundle.credentials) {
    try {
      const uid = ownerId(c.owner);
      const existing = await db.query.credentials.findFirst({
        where: and(eq(credentials.userId, uid), eq(credentials.name, c.name)),
      });
      const values = {
        userId: uid,
        name: c.name,
        sshUsername: c.sshUsername,
        authType: c.authType,
        secretEnc: enc(c.secret),
        passphraseEnc: enc(c.passphrase),
        loginUsername: c.loginUsername,
        loginPasswordEnc: enc(c.loginPassword),
        enablePasswordEnc: enc(c.enablePassword),
        setupCommands: c.setupCommands,
      };
      if (existing) {
        if (opts.mode === 'skip') {
          summary.credentials.skipped++;
          credIdByKey.set(`${uid}:${c.name}`, existing.id);
          continue;
        }
        await db
          .update(credentials)
          .set({ ...values, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(credentials.id, existing.id));
        credIdByKey.set(`${uid}:${c.name}`, existing.id);
        summary.credentials.updated++;
      } else {
        const id = randomUUID();
        await db.insert(credentials).values({ id, ...values });
        credIdByKey.set(`${uid}:${c.name}`, id);
        summary.credentials.created++;
      }
    } catch (err) {
      summary.errors.push(`credential ${c.name}: ${(err as Error).message}`);
    }
  }

  for (const c of bundle.connections) {
    try {
      const uid = ownerId(c.owner);
      const credId = c.credential ? (credIdByKey.get(`${uid}:${c.credential}`) ?? null) : null;
      const existing = await db.query.connections.findFirst({
        where: and(eq(connections.userId, uid), eq(connections.name, c.name)),
      });
      const values = {
        userId: uid,
        name: c.name,
        host: c.host,
        port: c.port,
        sshUsername: c.sshUsername,
        credentialId: credId,
        authType: c.authType,
        secretEnc: enc(c.secret),
        passphraseEnc: enc(c.passphrase),
        initCommand: c.initCommand,
        loginUsername: c.loginUsername,
        loginPasswordEnc: enc(c.loginPassword),
        enablePasswordEnc: enc(c.enablePassword),
        setupCommands: c.setupCommands,
        groupName: c.groupName,
        tags: normTags(c.tags),
        color: (['red', 'amber', 'green', 'blue', 'violet'] as const).includes(c.color as never)
          ? (c.color as 'red')
          : null,
        antiIdleSeconds: Number.isFinite(c.antiIdleSeconds) ? c.antiIdleSeconds : 0,
      };
      if (existing) {
        if (opts.mode === 'skip') {
          summary.connections.skipped++;
          continue;
        }
        await db
          .update(connections)
          .set({ ...values, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(connections.id, existing.id));
        summary.connections.updated++;
      } else {
        await db.insert(connections).values({ id: randomUUID(), ...values });
        summary.connections.created++;
      }
    } catch (err) {
      summary.errors.push(`connection ${c.name}: ${(err as Error).message}`);
    }
  }

  return summary;
}

// ---------------------------------------------------------------- serialisation

const ENC_FORMAT = 'anterm-vault-encrypted';

export function encryptBundle(bundle: VaultBundle, passphrase: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  return JSON.stringify(
    {
      format: ENC_FORMAT,
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: data.toString('base64'),
    },
    null,
    2,
  );
}

export function decryptBundle(envelope: string, passphrase: string): VaultBundle {
  let env: Record<string, string>;
  try {
    env = JSON.parse(envelope);
  } catch {
    throw new Error('not a valid .anterm file (bad JSON)');
  }
  if (env.format !== ENC_FORMAT) throw new Error('not an encrypted AnTerm vault file');
  try {
    const key = scryptSync(passphrase, Buffer.from(env.salt!, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv!, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag!, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return parseJsonBundle(plain);
  } catch (err) {
    if ((err as Error).message.includes('vault')) throw err;
    throw new Error('wrong passphrase or corrupted file');
  }
}

export function parseJsonBundle(text: string): VaultBundle {
  const b = JSON.parse(text) as VaultBundle;
  if (b.format !== 'anterm-vault' || !Array.isArray(b.connections) || !Array.isArray(b.credentials)) {
    throw new Error('not an AnTerm vault bundle');
  }
  return b;
}

const CSV_COLS = [
  'kind',
  'owner',
  'name',
  'host',
  'port',
  'sshUsername',
  'authType',
  'password',
  'privateKey',
  'passphrase',
  'credentialRef',
  'loginUsername',
  'loginPassword',
  'enablePassword',
  'setupCommands',
  'initCommand',
  'group',
  'tags',
  'color',
] as const;

const cell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function bundleToCsv(bundle: VaultBundle): string {
  const lines = [CSV_COLS.join(',')];
  for (const c of bundle.credentials) {
    lines.push(
      CSV_COLS.map((k) => {
        switch (k) {
          case 'kind':
            return 'credential';
          case 'owner':
            return c.owner;
          case 'name':
            return c.name;
          case 'sshUsername':
            return c.sshUsername ?? '';
          case 'authType':
            return c.authType;
          case 'password':
            return c.authType === 'password' ? (c.secret ?? '') : '';
          case 'privateKey':
            return c.authType === 'key' ? (c.secret ?? '') : '';
          case 'passphrase':
            return c.passphrase ?? '';
          case 'loginUsername':
            return c.loginUsername ?? '';
          case 'loginPassword':
            return c.loginPassword ?? '';
          case 'enablePassword':
            return c.enablePassword ?? '';
          case 'setupCommands':
            return (c.setupCommands ?? '').replace(/\n/g, '\\n');
          default:
            return '';
        }
      })
        .map(cell)
        .join(','),
    );
  }
  for (const c of bundle.connections) {
    lines.push(
      CSV_COLS.map((k) => {
        switch (k) {
          case 'kind':
            return 'connection';
          case 'owner':
            return c.owner;
          case 'name':
            return c.name;
          case 'host':
            return c.host;
          case 'port':
            return String(c.port);
          case 'sshUsername':
            return c.sshUsername;
          case 'authType':
            return c.authType;
          case 'password':
            return c.authType === 'password' ? (c.secret ?? '') : '';
          case 'privateKey':
            return c.authType === 'key' ? (c.secret ?? '') : '';
          case 'passphrase':
            return c.passphrase ?? '';
          case 'credentialRef':
            return c.credential ?? '';
          case 'loginUsername':
            return c.loginUsername ?? '';
          case 'loginPassword':
            return c.loginPassword ?? '';
          case 'enablePassword':
            return c.enablePassword ?? '';
          case 'setupCommands':
            return (c.setupCommands ?? '').replace(/\n/g, '\\n');
          case 'initCommand':
            return c.initCommand ?? '';
          case 'group':
            return c.groupName ?? '';
          case 'tags':
            return c.tags ?? '';
          case 'color':
            return c.color ?? '';
          default:
            return '';
        }
      })
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

export function serialiseBundle(bundle: VaultBundle, format: VaultFormat, passphrase?: string): string {
  if (format === 'encrypted') {
    if (!passphrase || passphrase.length < 8) throw new Error('a passphrase of at least 8 characters is required');
    return encryptBundle(bundle, passphrase);
  }
  if (format === 'csv') return bundleToCsv(bundle);
  return JSON.stringify(bundle, null, 2);
}
