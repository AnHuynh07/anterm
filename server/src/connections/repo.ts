import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, type Connection } from '../db/schema.js';
import { encryptSecret, maybeDecrypt } from '../crypto/secrets.js';

export type AuthType = 'password' | 'key' | 'agent';
export type ConnectionColor = 'red' | 'amber' | 'green' | 'blue' | 'violet';
const COLORS: ConnectionColor[] = ['red', 'amber', 'green', 'blue', 'violet'];

export type Protocol = 'ssh' | 'telnet' | 'http';

export type WebAuthMode = 'form' | 'basic' | 'none';

/** Web-managed device config as sent by the client (password omitted = keep). */
export interface WebSettingsInput {
  url: string;
  authMode: WebAuthMode;
  username?: string | null;
  password?: string | null;
  insecureTls?: boolean;
  /** form auth: where to POST and what the fields are called */
  loginPath?: string | null;
  userField?: string | null;
  passField?: string | null;
  /** where the device's config-backup button downloads from */
  configUrl?: string | null;
  /** a status/about page to scrape read-only device facts from */
  factsUrl?: string | null;
  /** newline-delimited `Label = regex` rules for scraping `factsUrl` (blank = built-in defaults) */
  factsRules?: string | null;
  /** expected firmware string; a scraped "firmware" fact that differs fires a drift alert */
  firmwareBaseline?: string | null;
}

/** Web-device config as stored (password encrypted). */
export interface WebSettingsStored {
  url: string;
  authMode: WebAuthMode;
  username: string | null;
  passwordEnc: string | null;
  insecureTls: boolean;
  loginPath: string | null;
  userField: string | null;
  passField: string | null;
  configUrl: string | null;
  factsUrl: string | null;
  factsRules: string | null;
  firmwareBaseline: string | null;
}

/** Web-device config as returned to the client (no secret). */
export interface WebSettingsDto {
  url: string;
  authMode: WebAuthMode;
  username: string | null;
  hasPassword: boolean;
  insecureTls: boolean;
  loginPath: string | null;
  userField: string | null;
  passField: string | null;
  configUrl: string | null;
  factsUrl: string | null;
  factsRules: string | null;
  firmwareBaseline: string | null;
}

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  protocol?: Protocol | null;
  settings?: WebSettingsInput | null;
  sshUsername: string;
  credentialId?: string | null;
  jumpConnectionId?: string | null;
  authType: AuthType;
  /** raw password or private key PEM; omitted on edit means "keep existing" */
  secret?: string | null;
  passphrase?: string | null;
  initCommand?: string | null;
  configCommand?: string | null;
  // in-band login automation (network devices)
  loginUsername?: string | null;
  loginPassword?: string | null;
  enablePassword?: string | null;
  setupCommands?: string | null;
  runbook?: string | null;
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

function parseWebStored(raw: string | null): WebSettingsStored | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<WebSettingsStored>;
    if (!s.url) return null;
    return {
      url: s.url,
      authMode: s.authMode === 'basic' || s.authMode === 'none' ? s.authMode : 'form',
      username: s.username ?? null,
      passwordEnc: s.passwordEnc ?? null,
      insecureTls: Boolean(s.insecureTls),
      loginPath: s.loginPath ?? null,
      userField: s.userField ?? null,
      passField: s.passField ?? null,
      configUrl: s.configUrl ?? null,
      factsUrl: s.factsUrl ?? null,
      factsRules: s.factsRules ?? null,
      firmwareBaseline: s.firmwareBaseline ?? null,
    };
  } catch {
    return null;
  }
}

function webToDto(raw: string | null): WebSettingsDto | null {
  const s = parseWebStored(raw);
  if (!s) return null;
  return {
    url: s.url,
    authMode: s.authMode,
    username: s.username,
    hasPassword: Boolean(s.passwordEnc),
    insecureTls: s.insecureTls,
    loginPath: s.loginPath,
    userField: s.userField,
    passField: s.passField,
    configUrl: s.configUrl,
    factsUrl: s.factsUrl,
    factsRules: s.factsRules,
    firmwareBaseline: s.firmwareBaseline,
  };
}

function normProtocol(p: Protocol | null | undefined): Protocol {
  return p === 'telnet' || p === 'http' ? p : 'ssh';
}

/** Decrypted web-device config for the reverse proxy. */
export interface ResolvedWebTarget {
  url: string;
  authMode: WebAuthMode;
  username: string | null;
  password: string | null;
  insecureTls: boolean;
  loginPath: string;
  userField: string;
  passField: string;
  configUrl: string | null;
  factsUrl: string | null;
  factsRules: string | null;
  firmwareBaseline: string | null;
}

/** Shape returned to the client — never includes decrypted secrets. */
export interface ConnectionDto {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: Protocol;
  sshUsername: string;
  credentialId: string | null;
  jumpConnectionId: string | null;
  authType: AuthType;
  hasSecret: boolean;
  hasPassphrase: boolean;
  initCommand: string | null;
  configCommand: string | null;
  loginUsername: string | null;
  hasLoginPassword: boolean;
  hasEnablePassword: boolean;
  setupCommands: string | null;
  runbook: string | null;
  groupName: string | null;
  tags: string[];
  color: ConnectionColor | null;
  antiIdleSeconds: number;
  /** web-managed device config (protocol === 'http'), never the password */
  web: WebSettingsDto | null;
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  /** filled in by the route (RBAC) */
  ownerName?: string;
  relation?: 'admin' | 'owner' | 'shared' | 'none';
  canEdit?: boolean;
  canOpen?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

export function toDto(c: Connection): ConnectionDto {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    protocol: c.protocol,
    sshUsername: c.sshUsername,
    credentialId: c.credentialId ?? null,
    jumpConnectionId: c.jumpConnectionId ?? null,
    authType: c.authType,
    hasSecret: Boolean(c.secretEnc),
    hasPassphrase: Boolean(c.passphraseEnc),
    initCommand: c.initCommand ?? null,
    configCommand: c.configCommand ?? null,
    loginUsername: c.loginUsername ?? null,
    hasLoginPassword: Boolean(c.loginPasswordEnc),
    hasEnablePassword: Boolean(c.enablePasswordEnc),
    setupCommands: c.setupCommands ?? null,
    runbook: c.runbook ?? null,
    groupName: c.groupName ?? null,
    tags: c.tags ? c.tags.split(',').filter(Boolean) : [],
    color: c.color ?? null,
    antiIdleSeconds: c.antiIdleSeconds,
    web: webToDto(c.settings ?? null),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    ownerId: c.userId,
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

  /** Ignores ownership — callers must check access first. */
  getAny(id: string): Promise<Connection | undefined> {
    return this.db.query.connections.findFirst({ where: eq(connections.id, id) });
  }

  /**
   * Bastions to tunnel through to reach connection `id`, in dial order
   * (outermost first). Throws on a cycle or a chain longer than `maxDepth`.
   */
  async jumpChain(id: string, maxDepth = 4): Promise<Connection[]> {
    const chain: Connection[] = [];
    const seen = new Set<string>([id]);
    let cur = await this.getAny(id);
    while (cur?.jumpConnectionId) {
      if (seen.has(cur.jumpConnectionId)) throw new Error('jump host chain has a cycle');
      if (chain.length >= maxDepth) throw new Error(`jump host chain is too long (max ${maxDepth})`);
      seen.add(cur.jumpConnectionId);
      const next = await this.getAny(cur.jumpConnectionId);
      if (!next) break;
      chain.push(next);
      cur = next;
    }
    return chain.reverse();
  }

  /** Connections an actor may see: all (admin), else owned + explicitly shared. */
  listVisible(opts: { userId: string; admin: boolean; sharedIds: string[] }): Promise<Connection[]> {
    if (opts.admin) {
      return this.db.query.connections.findMany({ orderBy: [desc(connections.updatedAt)] });
    }
    const where = opts.sharedIds.length
      ? or(eq(connections.userId, opts.userId), inArray(connections.id, opts.sharedIds))
      : eq(connections.userId, opts.userId);
    return this.db.query.connections.findMany({ where, orderBy: [desc(connections.updatedAt)] });
  }

  private enc(v: string | null | undefined): string | null {
    return v ? encryptSecret(v, this.appSecret) : null;
  }

  /** Build the `settings` JSON column for a web device (password encrypted).
   *  On edit, `existingRaw` supplies the stored password when the client omits it. */
  private webColumn(input: ConnectionInput, existingRaw?: string | null): string | null {
    if (normProtocol(input.protocol) !== 'http') return null;
    const s = input.settings;
    if (!s?.url) return null;
    const prev = parseWebStored(existingRaw ?? null);
    const passwordEnc =
      s.password === undefined ? (prev?.passwordEnc ?? null) : this.enc(s.password || null);
    const stored: WebSettingsStored = {
      url: s.url.trim(),
      authMode: s.authMode === 'basic' || s.authMode === 'none' ? s.authMode : 'form',
      username: s.username?.trim() || null,
      passwordEnc,
      insecureTls: Boolean(s.insecureTls),
      loginPath: s.loginPath?.trim() || null,
      userField: s.userField?.trim() || null,
      passField: s.passField?.trim() || null,
      configUrl: s.configUrl?.trim() || null,
      factsUrl: s.factsUrl?.trim() || null,
      factsRules: s.factsRules?.trim() || null,
      firmwareBaseline: s.firmwareBaseline?.trim() || null,
    };
    return JSON.stringify(stored);
  }

  /** Decrypt a connection's web-device config for the reverse proxy. */
  resolveWebTarget(c: Connection): ResolvedWebTarget | null {
    const s = parseWebStored(c.settings ?? null);
    if (!s) return null;
    return {
      url: s.url,
      authMode: s.authMode,
      username: s.username,
      password: maybeDecrypt(s.passwordEnc, this.appSecret) ?? null,
      insecureTls: s.insecureTls,
      loginPath: s.loginPath || '/iss/redirect.html',
      userField: s.userField || 'Login',
      passField: s.passField || 'Password',
      configUrl: s.configUrl || null,
      factsUrl: s.factsUrl || null,
      factsRules: s.factsRules || null,
      firmwareBaseline: s.firmwareBaseline || null,
    };
  }

  async create(userId: string, input: ConnectionInput): Promise<Connection> {
    const id = randomUUID();
    await this.db.insert(connections).values({
      id,
      userId,
      name: input.name,
      host: input.host,
      port: input.port,
      protocol: normProtocol(input.protocol),
      settings: this.webColumn(input),
      sshUsername: input.sshUsername,
      credentialId: input.credentialId || null,
      jumpConnectionId: input.jumpConnectionId || null,
      authType: input.authType,
      secretEnc: this.enc(input.secret),
      passphraseEnc: this.enc(input.passphrase),
      initCommand: input.initCommand ?? null,
      configCommand: input.configCommand?.trim() || null,
      loginUsername: input.loginUsername || null,
      loginPasswordEnc: this.enc(input.loginPassword),
      enablePasswordEnc: this.enc(input.enablePassword),
      setupCommands: input.setupCommands || null,
      runbook: input.runbook?.trim() || null,
      groupName: input.groupName?.trim() || null,
      tags: normTags(input.tags),
      color: normColor(input.color),
      antiIdleSeconds: clampIdle(input.antiIdleSeconds),
    });
    const created = await this.get(userId, id);
    if (!created) throw new Error('failed to read back created connection');
    return created;
  }

  update(userId: string, id: string, input: ConnectionInput): Promise<Connection | undefined> {
    return this.get(userId, id).then((existing) => (existing ? this.updateAny(id, input) : undefined));
  }

  /** Ignores ownership — callers must check `canEdit` first. */
  async updateAny(id: string, input: ConnectionInput): Promise<Connection | undefined> {
    const existing = await this.getAny(id);
    if (!existing) return undefined;

    const patch: Partial<Connection> = {
      name: input.name,
      host: input.host,
      port: input.port,
      protocol: normProtocol(input.protocol),
      settings: this.webColumn(input, existing.settings),
      sshUsername: input.sshUsername,
      credentialId: input.credentialId || null,
      jumpConnectionId: input.jumpConnectionId || null,
      authType: input.authType,
      initCommand: input.initCommand ?? null,
      configCommand: input.configCommand?.trim() || null,
      loginUsername: input.loginUsername || null,
      setupCommands: input.setupCommands || null,
      runbook: input.runbook?.trim() || null,
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
    return this.getAny(id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.get(userId, id);
    if (!existing) return false;
    return this.removeAny(id);
  }

  /** Ignores ownership — callers must check `canDelete` first. */
  async removeAny(id: string): Promise<boolean> {
    const existing = await this.getAny(id);
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
