import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { credentials, type Connection, type Credential } from '../db/schema.js';
import { encryptSecret, maybeDecrypt } from '../crypto/secrets.js';
import type { AutoLoginConfig } from '../ssh/autologin.js';
import type { AuthType } from './repo.js';

export interface CredentialInput {
  name: string;
  sshUsername?: string | null;
  authType: AuthType;
  secret?: string | null;
  passphrase?: string | null;
  loginUsername?: string | null;
  loginPassword?: string | null;
  enablePassword?: string | null;
  setupCommands?: string | null;
}

export interface CredentialDto {
  id: string;
  name: string;
  sshUsername: string | null;
  authType: AuthType;
  hasSecret: boolean;
  hasPassphrase: boolean;
  loginUsername: string | null;
  hasLoginPassword: boolean;
  hasEnablePassword: boolean;
  setupCommands: string | null;
  createdAt: number;
  updatedAt: number;
}

export function credentialToDto(c: Credential): CredentialDto {
  return {
    id: c.id,
    name: c.name,
    sshUsername: c.sshUsername ?? null,
    authType: c.authType,
    hasSecret: Boolean(c.secretEnc),
    hasPassphrase: Boolean(c.passphraseEnc),
    loginUsername: c.loginUsername ?? null,
    hasLoginPassword: Boolean(c.loginPasswordEnc),
    hasEnablePassword: Boolean(c.enablePasswordEnc),
    setupCommands: c.setupCommands ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export class CredentialRepo {
  constructor(
    private readonly db: Db,
    private readonly appSecret: string,
  ) {}

  private enc(v: string | null | undefined): string | null {
    return v ? encryptSecret(v, this.appSecret) : null;
  }

  list(userId: string): Promise<Credential[]> {
    return this.db.query.credentials.findMany({
      where: eq(credentials.userId, userId),
      orderBy: [asc(credentials.name)],
    });
  }

  get(userId: string, id: string): Promise<Credential | undefined> {
    return this.db.query.credentials.findFirst({
      where: and(eq(credentials.id, id), eq(credentials.userId, userId)),
    });
  }

  async create(userId: string, input: CredentialInput): Promise<Credential> {
    const id = randomUUID();
    await this.db.insert(credentials).values({
      id,
      userId,
      name: input.name,
      sshUsername: input.sshUsername?.trim() || null,
      authType: input.authType,
      secretEnc: this.enc(input.secret),
      passphraseEnc: this.enc(input.passphrase),
      loginUsername: input.loginUsername || null,
      loginPasswordEnc: this.enc(input.loginPassword),
      enablePasswordEnc: this.enc(input.enablePassword),
      setupCommands: input.setupCommands || null,
    });
    const created = await this.get(userId, id);
    if (!created) throw new Error('failed to read back created credential');
    return created;
  }

  async update(userId: string, id: string, input: CredentialInput): Promise<Credential | undefined> {
    const existing = await this.get(userId, id);
    if (!existing) return undefined;
    const patch: Partial<Credential> = {
      name: input.name,
      sshUsername: input.sshUsername?.trim() || null,
      authType: input.authType,
      loginUsername: input.loginUsername || null,
      setupCommands: input.setupCommands || null,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (input.secret !== undefined) patch.secretEnc = this.enc(input.secret);
    if (input.passphrase !== undefined) patch.passphraseEnc = this.enc(input.passphrase);
    if (input.loginPassword !== undefined) patch.loginPasswordEnc = this.enc(input.loginPassword);
    if (input.enablePassword !== undefined) patch.enablePasswordEnc = this.enc(input.enablePassword);
    await this.db.update(credentials).set(patch).where(eq(credentials.id, id));
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.get(userId, id);
    if (!existing) return false;
    await this.db.delete(credentials).where(eq(credentials.id, id));
    return true;
  }
}

export interface ResolvedTarget {
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  autoLogin: AutoLoginConfig | null;
  /** SSH username from the credential, used when the connection has none */
  credSshUsername?: string;
  source: 'inline' | 'credential';
}

/**
 * Resolve the effective auth + login-automation for a connection: from its
 * linked credential when set, otherwise from the connection's own fields.
 */
export function resolveTarget(conn: Connection, cred: Credential | null, appSecret: string): ResolvedTarget {
  const src = cred ?? conn;
  const secret = maybeDecrypt(src.secretEnc, appSecret);
  const passphrase = maybeDecrypt(src.passphraseEnc, appSecret);

  const loginUsername = src.loginUsername ?? undefined;
  const setupCommands = (src.setupCommands ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const autoCfg: AutoLoginConfig = {
    loginUsername,
    loginPassword: maybeDecrypt(src.loginPasswordEnc, appSecret),
    enablePassword: maybeDecrypt(src.enablePasswordEnc, appSecret),
    setupCommands,
  };
  const autoLogin = loginUsername || setupCommands.length ? autoCfg : null;

  const base: ResolvedTarget = {
    authType: src.authType,
    autoLogin,
    credSshUsername: cred?.sshUsername ?? undefined,
    source: cred ? 'credential' : 'inline',
  };
  if (src.authType === 'key') return { ...base, privateKey: secret, passphrase };
  if (src.authType === 'password') return { ...base, password: secret };
  return base;
}
