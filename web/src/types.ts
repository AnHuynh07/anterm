export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  totpEnabled?: boolean;
}

export interface ManagedUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  twoFactor: boolean;
  createdAt: number;
  activeSessions: number;
  isSelf: boolean;
}

export interface PickableUser {
  id: string;
  username: string;
  role: Role;
}

export interface AuditEvent {
  id: string;
  ts: number;
  actor: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

export interface ConnectionShareEntry {
  userId: string;
  username: string;
  canEdit: boolean;
}

export type AuthType = 'password' | 'key' | 'agent';
export type ConnectionColor = 'red' | 'amber' | 'green' | 'blue' | 'violet';

export interface Credential {
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
  ownerId?: string;
  ownerName?: string;
}

export type Protocol = 'ssh' | 'telnet' | 'http';
export type WebAuthMode = 'form' | 'basic' | 'none';

export interface WebSettings {
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

export interface WebFact {
  label: string;
  value: string;
}

export interface WebFactsResponse {
  facts: WebFact[];
  fetchedAt: number;
  firmware: string | null;
  baseline: string | null;
  firmwareOk: boolean;
}

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: Protocol;
  web: WebSettings | null;
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
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  ownerName?: string;
  relation?: 'admin' | 'owner' | 'shared' | 'none';
  canEdit?: boolean;
  canOpen?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  sortOrder: number;
}

export interface ConfigSnapshot {
  id: string;
  capturedAt: number;
  reason: string;
  lines: number;
  changed: boolean;
  user: string | null;
}

export interface DiffLine {
  type: ' ' | '-' | '+' | '@';
  text: string;
}

export interface ReachResult {
  status: 'up' | 'down' | 'unknown';
  checkedAt: number;
  latencyMs: number | null;
  detail: string | null;
}

export interface ReachEvent {
  id: string;
  connectionId: string;
  name?: string;
  ts: number;
  status: 'up' | 'down' | 'unknown';
  prevStatus: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface AlertSettings {
  enabled: boolean;
  webhookUrl: string;
}

export interface CommandRecord {
  id: string;
  ts: number;
  text: string;
  target: string;
  sessionId?: string;
}

export interface LiveSession {
  token: string;
  connectionId: string | null;
  target: string;
  startedAt: number;
  detachedAt: number | null;
  attached: number;
  observers: number;
  shared: boolean;
}

export interface SshSessionRecord {
  id: string;
  connectionId: string | null;
  hasRecording?: boolean;
  commandCount?: number;
  target: string;
  user?: string;
  startedAt: number;
  endedAt: number | null;
  clientIp: string | null;
  bytesIn: number;
  bytesOut: number;
  exitReason: string | null;
}

// ---- WebSocket protocol (mirror of server/src/ws/protocol.ts) ----

export interface HostKeyPromptMsg {
  t: 'hostkey-prompt';
  hostport: string;
  status: 'unknown' | 'changed';
  keyType: string;
  fingerprint: string;
  knownFingerprint?: string;
}

export type ServerMessage =
  | { t: 'status'; state: 'connecting' | 'ready' | 'closed'; detail?: string }
  | { t: 'attached'; token: string; resumed?: boolean; readOnly?: boolean; owner?: string }
  | { t: 'presence'; viewers: string[] }
  | HostKeyPromptMsg
  | { t: 'error'; message: string }
  | { t: 'pong' };

export type ClientMessage =
  | { t: 'open'; connectionId?: string; adhoc?: AdhocTarget; cols: number; rows: number }
  | { t: 'attach'; token: string; cols: number; rows: number; fresh?: boolean }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'hostkey'; accept: boolean }
  | { t: 'share'; enabled: boolean }
  | { t: 'ping' };

export interface AdhocTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
