export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
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
}

export interface Connection {
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

export interface Snippet {
  id: string;
  name: string;
  command: string;
  sortOrder: number;
}

export interface CommandRecord {
  id: string;
  ts: number;
  text: string;
  target: string;
  sessionId?: string;
}

export interface SshSessionRecord {
  id: string;
  connectionId: string | null;
  hasRecording?: boolean;
  commandCount?: number;
  target: string;
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
  | HostKeyPromptMsg
  | { t: 'error'; message: string }
  | { t: 'pong' };

export type ClientMessage =
  | { t: 'open'; connectionId?: string; adhoc?: AdhocTarget; cols: number; rows: number }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'hostkey'; accept: boolean }
  | { t: 'ping' };

export interface AdhocTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
