import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { configSnapshots, type ConfigSnapshot } from '../db/schema.js';

export type SnapshotReason = 'manual' | 'auto-after-save' | 'auto';

export interface SnapshotDto {
  id: string;
  capturedAt: number;
  reason: string;
  lines: number;
  changed: boolean;
  userId: string | null;
}

export const toSnapshotDto = (s: ConfigSnapshot): SnapshotDto => ({
  id: s.id,
  capturedAt: s.capturedAt,
  reason: s.reason,
  lines: s.lines,
  changed: s.changed,
  userId: s.userId,
});

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

  list(connectionId: string, limit = 100): Promise<ConfigSnapshot[]> {
    return this.db.query.configSnapshots.findMany({
      where: eq(configSnapshots.connectionId, connectionId),
      orderBy: [desc(configSnapshots.capturedAt)],
      limit,
    });
  }

  get(connectionId: string, id: string): Promise<ConfigSnapshot | undefined> {
    return this.db.query.configSnapshots.findFirst({
      where: and(eq(configSnapshots.id, id), eq(configSnapshots.connectionId, connectionId)),
    });
  }

  latest(connectionId: string): Promise<ConfigSnapshot | undefined> {
    return this.db.query.configSnapshots.findFirst({
      where: eq(configSnapshots.connectionId, connectionId),
      orderBy: [desc(configSnapshots.capturedAt)],
    });
  }

  /** The snapshot immediately older than `before`. */
  previous(connectionId: string, before: number): Promise<ConfigSnapshot | undefined> {
    return this.db.query.configSnapshots.findFirst({
      where: and(eq(configSnapshots.connectionId, connectionId), lt(configSnapshots.capturedAt, before)),
      orderBy: [desc(configSnapshots.capturedAt)],
    });
  }

  async create(input: {
    connectionId: string;
    userId?: string | null;
    sessionId?: string | null;
    reason: SnapshotReason;
    content: string;
  }): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
    const content = input.content.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
    const prev = await this.latest(input.connectionId);
    const changed = !prev || prev.content !== content;
    const id = randomUUID();
    await this.db.insert(configSnapshots).values({
      id,
      connectionId: input.connectionId,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      reason: input.reason,
      lines: content.split('\n').length - 1,
      changed,
      content,
    });
    const snapshot = (await this.get(input.connectionId, id))!;
    return { snapshot, changed };
  }
}

/** true when a typed command line saves the running config to startup. */
export function isConfigSaveCommand(line: string): boolean {
  const s = line.trim().toLowerCase();
  return (
    /^wr(ite)?(\s+mem(ory)?)?$/.test(s) || // write / wr / write memory / wr mem  (not "write terminal")
    /^copy\s+run(ning-config)?\s+start(up-config)?/.test(s) ||
    /^(commit|save)(\s|$)/.test(s) // Juniper / others
  );
}
