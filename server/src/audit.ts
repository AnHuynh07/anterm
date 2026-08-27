import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { sshSessions, type SshSession as SshSessionRow } from './db/schema.js';

export class AuditLog {
  constructor(private readonly db: Db) {}

  async open(input: {
    userId: string;
    connectionId?: string | null;
    target: string;
    clientIp?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(sshSessions).values({
      id,
      userId: input.userId,
      connectionId: input.connectionId ?? null,
      target: input.target,
      clientIp: input.clientIp ?? null,
    });
    return id;
  }

  async close(id: string, stats: { bytesIn: number; bytesOut: number; exitReason: string }): Promise<void> {
    await this.db
      .update(sshSessions)
      .set({
        endedAt: Math.floor(Date.now() / 1000),
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        exitReason: stats.exitReason.slice(0, 300),
      })
      .where(eq(sshSessions.id, id));
  }

  list(userId: string, limit = 100): Promise<SshSessionRow[]> {
    return this.db.query.sshSessions.findMany({
      where: eq(sshSessions.userId, userId),
      orderBy: [desc(sshSessions.startedAt)],
      limit,
    });
  }
}
