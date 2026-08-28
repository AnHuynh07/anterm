import type { Connection } from '../db/schema.js';
import type { ConnectionInput } from './repo.js';

/**
 * Portable inventory format for import/export. Carries organisation + login
 * automation *shape* but **never secrets** — passwords/keys stay in the vault or
 * are re-entered after import. `credential` references a vault credential by name.
 */
export interface PortableConnection {
  name: string;
  host: string;
  port: number;
  protocol: 'ssh' | 'telnet' | 'http';
  sshUsername: string;
  credential: string | null;
  authType: 'password' | 'key' | 'agent';
  group: string | null;
  tags: string;
  color: string | null;
  loginUsername: string | null;
  setupCommands: string | null;
  initCommand: string | null;
  runbook: string | null;
  /** web-managed device (protocol 'http') — never the password */
  webUrl: string | null;
  webAuthMode: string | null;
  webUsername: string | null;
}

const FIELDS: (keyof PortableConnection)[] = [
  'name',
  'host',
  'port',
  'protocol',
  'sshUsername',
  'credential',
  'authType',
  'group',
  'tags',
  'color',
  'loginUsername',
  'setupCommands',
  'initCommand',
  'runbook',
  'webUrl',
  'webAuthMode',
  'webUsername',
];

function webOf(raw: string | null): { url: string | null; authMode: string | null; username: string | null } {
  if (!raw) return { url: null, authMode: null, username: null };
  try {
    const s = JSON.parse(raw) as { url?: string; authMode?: string; username?: string };
    return { url: s.url ?? null, authMode: s.authMode ?? null, username: s.username ?? null };
  } catch {
    return { url: null, authMode: null, username: null };
  }
}

export function toPortable(c: Connection, credName: string | null): PortableConnection {
  const w = webOf(c.settings ?? null);
  return {
    name: c.name,
    host: c.host,
    port: c.port,
    protocol: c.protocol === 'telnet' ? 'telnet' : c.protocol === 'http' ? 'http' : 'ssh',
    sshUsername: c.sshUsername,
    credential: credName,
    authType: c.authType,
    group: c.groupName ?? null,
    tags: c.tags ?? '',
    color: c.color ?? null,
    loginUsername: c.loginUsername ?? null,
    setupCommands: c.setupCommands ?? null,
    initCommand: c.initCommand ?? null,
    runbook: c.runbook ?? null,
    webUrl: w.url,
    webAuthMode: w.authMode,
    webUsername: w.username,
  };
}

// ---------- CSV ----------

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: PortableConnection[]): string {
  const lines = [FIELDS.join(',')];
  for (const r of rows) lines.push(FIELDS.map((f) => csvCell(r[f])).join(','));
  return lines.join('\r\n');
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/\r\n/g, '\n').trim();
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);

  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// ---------- import ----------

export function parseImport(format: 'json' | 'csv', data: string): PortableConnection[] {
  const rows: Record<string, unknown>[] =
    format === 'csv' ? parseCsv(data) : normaliseJson(JSON.parse(data));

  return rows.map((r) => {
    const proto = String(r.protocol).toLowerCase();
    return {
      name: str(r.name),
      host: str(r.host),
      port: Number(r.port) || 22,
      protocol: proto === 'telnet' ? 'telnet' : proto === 'http' ? 'http' : 'ssh',
      sshUsername: str(r.sshUsername ?? r.ssh_username ?? r.user),
      credential: opt(r.credential),
      authType: (['password', 'key', 'agent'] as const).includes(r.authType as never)
        ? (r.authType as PortableConnection['authType'])
        : 'password',
      group: opt(r.group ?? r.groupName),
      tags: str(r.tags),
      color: opt(r.color),
      loginUsername: opt(r.loginUsername),
      setupCommands: opt(r.setupCommands),
      initCommand: opt(r.initCommand),
      runbook: opt(r.runbook),
      webUrl: opt(r.webUrl),
      webAuthMode: opt(r.webAuthMode),
      webUsername: opt(r.webUsername),
    };
  });
}

function normaliseJson(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { connections?: unknown }).connections)) {
    return (parsed as { connections: Record<string, unknown>[] }).connections;
  }
  throw new Error('expected a JSON array or { connections: [...] }');
}

const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const opt = (v: unknown): string | null => {
  const s = str(v);
  return s === '' ? null : s;
};

export function toConnectionInput(
  p: PortableConnection,
  credentialId: string | null,
): ConnectionInput {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    protocol: p.protocol,
    settings:
      p.protocol === 'http' && p.webUrl
        ? {
            url: p.webUrl,
            authMode:
              p.webAuthMode === 'basic' || p.webAuthMode === 'none' ? p.webAuthMode : 'form',
            username: p.webUsername,
            // password is never in the portable format — re-enter after import
          }
        : null,
    sshUsername: p.sshUsername,
    credentialId,
    authType: p.authType,
    groupName: p.group,
    tags: p.tags,
    color: p.color,
    loginUsername: p.loginUsername,
    setupCommands: p.setupCommands,
    initCommand: p.initCommand,
    runbook: p.runbook,
  };
}
