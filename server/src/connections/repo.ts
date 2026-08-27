import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, type Connection } from '../db/schema.js';
import { encryptSecret, maybeDecrypt } from '../crypto/secrets.js';

export type AuthType = 'password' | 'key' | 'agent';

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  authType: AuthType;
  /** raw password or private key PEM; omitted on edit means "keep existing" */
  secret?: string | null;
  passphrase?: string | null;
  initCommand?: string | null;
}

/** Shape returned to the client — never includes decrypted secrets. */
export interface ConnectionDto {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUsername: string;
  authType: AuthType;
  hasSecret: boolean;
  hasPassphrase: boolean;
  initCommand: string | null;
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
    authType: c.authType,
    hasSecret: Boolean(c.secretEnc),
    hasPassphrase: Boolean(c.passphraseEnc),
    initCommand: c.initCommand ?? null,
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

  async create(userId: string, input: ConnectionInput): Promise<Connection> {
    const id = randomUUID();
    await this.db.insert(connections).values({
      id,
      userId,
      name: input.name,
      host: input.host,
      port: input.port,
      sshUsername: input.sshUsername,
      authType: input.authType,
      secretEnc: input.secret ? encryptSecret(input.secret, this.appSecret) : null,
      passphraseEnc: input.passphrase ? encryptSecret(input.passphrase, this.appSecret) : null,
      initCommand: input.initCommand ?? null,
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
      authType: input.authType,
      initCommand: input.initCommand ?? null,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    // `secret === undefined` -> keep; `secret === null` or '' -> clear; string -> replace
    if (input.secret !== undefined) {
      patch.secretEnc = input.secret ? encryptSecret(input.secret, this.appSecret) : null;
    }
    if (input.passphrase !== undefined) {
      patch.passphraseEnc = input.passphrase ? encryptSecret(input.passphrase, this.appSecret) : null;
    }

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
}
