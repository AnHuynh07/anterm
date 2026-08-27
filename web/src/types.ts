export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export type AuthType = 'password' | 'key' | 'agent';

export interface Connection {
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

export interface SshSessionRecord {
  id: string;
  connectionId: string | null;
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
