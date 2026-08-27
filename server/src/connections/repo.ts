import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, type Connection } from '../db/schema.js';
import { encryptSecret, maybeDecrypt } from '../crypto/secrets.js';

export type AuthType = 'password' | 'key' | 'agent';
export type ConnectionColor = 'red' | 'amber' | 'green' | 'blue' | 'violet';
const COLORS: ConnectionColor[] = ['red', 'amber', 'green', 'blue', 'violet'];

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  credentialId?: string | null;
  authType: AuthType;
  /** raw password or private key PEM; omitted on edit means "keep existing" */
  secret?: string | null;
  passphrase?: string | null;
  initCommand?: string | null;
  // in-band login automation (network devices)
  loginUsername?: string | null;
  loginPassword?: string | null;
  enablePassword?: string | null;
  setupCommands?: string | null;
  // organisation
  groupName?: string | null;
  tags?: string | null;
  color?: string | null;
  antiIdleSeconds?: number | null;
}

export function normTags(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const arr = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return arr.length ? arr.join(',') : null;
}

function normColor(raw: string | null | undefined): ConnectionColor | null {
  return raw && (COLORS as string[]).includes(raw) ? (raw as ConnectionColor) : null;
}

function clampIdle(v: number | null | undefined): number {
  const n = Math.floor(Number(v) || 0);
  return n <= 0 ? 0 : Math.min(Math.max(n, 15), 3600);
}

/** Shape returned to the client — never includes decrypted secrets. */
export interface ConnectionDto {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  credentialId: string | null;
  authType: AuthType;
  hasSecret: boolean;
  hasPassphrase: boolean;
  initCommand: string | null;
  loginUsername: string | null;
  hasLoginPassword: boolean;
  hasEnablePassword: boolean;
  setupCommands: string | null;
  groupName: string | null;
  tags: string[];
  color: ConnectionColor | null;
  antiIdleSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export function toDto(c: Connection): ConnectionDto {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    sshUsername: c.sshUsername,
    credentialId: c.credentialId ?? null,
    authType: c.authType,
    hasSecret: Boolean(c.secretEnc),
    hasPassphrase: Boolean(c.passphraseEnc),
    initCommand: c.initCommand ?? null,
    loginUsername: c.loginUsername ?? null,
    hasLoginPassword: Boolean(c.loginPasswordEnc),
    hasEnablePassword: Boolean(c.enablePasswordEnc),
    setupCommands: c.setupCommands ?? null,
    groupName: c.groupName ?? null,
    tags: c.tags ? c.tags.split(',').filter(Boolean) : [],
    color: c.color ?? null,
    antiIdleSeconds: c.antiIdleSeconds,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export class ConnectionRepo {
  constructor(
    private readonly db: Db,
    private readonly appSecret: string,
  ) {}

  list(userId: string): Promise<Connection[]> {
    return this.db.query.connections.findMany({
      where: eq(connections.userId, userId),
      orderBy: [desc(connections.updatedAt)],
    });
  }

  get(userId: string, id: string): Promise<Connection | undefined> {
    return this.db.query.connections.findFirst({
      where: and(eq(connections.id, id), eq(connections.userId, userId)),
    });
  }

  private enc(v: string | null | undefined): string | null {
    return v ? encryptSecret(v, this.appSecret) : null;
  }

  async create(userId: string, input: ConnectionInput): Promise<Connection> {
    const id = randomUUID();
    await this.db.insert(connections).values({
      id,
      userId,
      name: input.name,
      host: input.host,
      port: input.port,
      sshUsername: input.sshUsername,
      credentialId: input.credentialId || null,
      authType: input.authType,
      secretEnc: this.enc(input.secret),
      passphraseEnc: this.enc(input.passphrase),
      initCommand: input.initCommand ?? null,
      loginUsername: input.loginUsername || null,
      loginPasswordEnc: this.enc(input.loginPassword),
      enablePasswordEnc: this.enc(input.enablePassword),
      setupCommands: input.setupCommands || null,
      groupName: input.groupName?.trim() || null,
      tags: normTags(input.tags),
      color: normColor(input.color),
      antiIdleSeconds: clampIdle(input.antiIdleSeconds),
    });
    const created = await this.get(userId, id);
    if (!created) throw new Error('failed to read back created connection');
    return created;
  }

  async update(userId: string, id: string, input: ConnectionInput): Promise<Connection | undefined> {
    const existing = await this.get(userId, id);
    if (!existing) return undefined;

    const patch: Partial<Connection> = {
      name: input.name,
      host: input.host,
      port: input.port,
      sshUsername: input.sshUsername,
      credentialId: input.credentialId || null,
      authType: input.authType,
      initCommand: input.initCommand ?? null,
      loginUsername: input.loginUsername || null,
      setupCommands: input.setupCommands || null,
      groupName: input.groupName?.trim() || null,
      tags: normTags(input.tags),
      color: normColor(input.color),
      antiIdleSeconds: clampIdle(input.antiIdleSeconds),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    // secret `undefined` -> keep; `null`/'' -> clear; string -> replace
    if (input.secret !== undefined) patch.secretEnc = this.enc(input.secret);
    if (input.passphrase !== undefined) patch.passphraseEnc = this.enc(input.passphrase);
    if (input.loginPassword !== undefined) patch.loginPasswordEnc = this.enc(input.loginPassword);
    if (input.enablePassword !== undefined) patch.enablePasswordEnc = this.enc(input.enablePassword);

    await this.db.update(connections).set(patch).where(eq(connections.id, id));
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.get(userId, id);
    if (!existing) return false;
    await this.db.delete(connections).where(eq(connections.id, id));
    return true;
  }

  /** Decrypt stored credentials for an outbound SSH connection. */
  resolveSecrets(c: Connection): { password?: string; privateKey?: string; passphrase?: string } {
    const secret = maybeDecrypt(c.secretEnc, this.appSecret);
    const passphrase = maybeDecrypt(c.passphraseEnc, this.appSecret);
    if (c.authType === 'key') return { privateKey: secret, passphrase };
    if (c.authType === 'password') return { password: secret };
    return {};
  }

  /** Decrypt in-band login-automation settings (network device AAA login). */
  resolveLoginAutomation(c: Connection): {
    loginUsername?: string;
    loginPassword?: string;
    enablePassword?: string;
    setupCommands: string[];
  } {
    return {
      loginUsername: c.loginUsername ?? undefined,
      loginPassword: maybeDecrypt(c.loginPasswordEnc, this.appSecret),
      enablePassword: maybeDecrypt(c.enablePasswordEnc, this.appSecret),
      setupCommands: (c.setupCommands ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
}
