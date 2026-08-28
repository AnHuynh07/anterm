import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from './db/client.js';
import { auditEvents, type AuditEvent } from './db/schema.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'connection.create'
  | 'connection.update'
  | 'connection.delete'
  | 'connection.share'
  | 'connection.import'
  | 'credential.create'
  | 'credential.update'
  | 'credential.delete'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.password_reset'
  | 'hostkey.trusted'
  | 'hostkey.changed_accepted'
  | 'session.recordings_pruned'
  | 'vault.export'
  | 'vault.import'
  | 'vault.db_backup'
  | 'connection.bulk_run';

export interface AuditActor {
  id?: string | null;
  name?: string | null;
  ip?: string | null;
}

export interface AuditInput {
  actor?: AuditActor;
  action: AuditAction;
  target?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ActivityQuery {
  action?: string;
  actorId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export class ActivityLog {
  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
  ) {}

  /** Fire-and-forget: an audit write must never break the action being audited. */
  record(input: AuditInput): void {
    void this.db
      .insert(auditEvents)
      .values({
        id: randomUUID(),
        actorId: input.actor?.id ?? null,
        actorName: input.actor?.name ?? null,
        action: input.action,
        target: input.target ?? null,
        detail: input.detail ? JSON.stringify(input.detail).slice(0, 4000) : null,
        ip: input.actor?.ip ?? null,
      })
      .catch((err) => this.log?.warn({ err }, 'audit write failed'));
  }

  list(q: ActivityQuery = {}): Promise<AuditEvent[]> {
    const clauses = [
      q.action ? eq(auditEvents.action, q.action) : undefined,
      q.actorId ? eq(auditEvents.actorId, q.actorId) : undefined,
      q.from ? gte(auditEvents.ts, q.from) : undefined,
      q.to ? lte(auditEvents.ts, q.to) : undefined,
    ].filter(Boolean);
    return this.db.query.auditEvents.findMany({
      where: clauses.length ? and(...clauses) : undefined,
      orderBy: [desc(auditEvents.ts)],
      limit: Math.min(Math.max(q.limit ?? 300, 1), 2000),
    });
  }
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function activityToCsv(rows: AuditEvent[]): string {
  const head = ['ts', 'actor', 'action', 'target', 'ip', 'detail'];
  const lines = rows.map((r) =>
    [new Date(r.ts * 1000).toISOString(), r.actorName ?? r.actorId ?? '', r.action, r.target ?? '', r.ip ?? '', r.detail ?? '']
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}
