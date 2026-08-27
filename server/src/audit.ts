import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, like, lt } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { commands, sshSessions, type Command, type SshSession as SshSessionRow } from './db/schema.js';

export class AuditLog {
  constructor(private readonly db: Db) {}

  async open(input: {
    userId: string;
    connectionId?: string | null;
    target: string;
    clientIp?: string | null;
    recordingPath?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(sshSessions).values({
      id,
      userId: input.userId,
      connectionId: input.connectionId ?? null,
      target: input.target,
      clientIp: input.clientIp ?? null,
      recordingPath: input.recordingPath ?? null,
    });
    return id;
  }

  async close(
    id: string,
    stats: { bytesIn: number; bytesOut: number; exitReason: string; commandCount?: number },
  ): Promise<void> {
    await this.db
      .update(sshSessions)
      .set({
        endedAt: Math.floor(Date.now() / 1000),
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        exitReason: stats.exitReason.slice(0, 300),
        ...(stats.commandCount != null ? { commandCount: stats.commandCount } : {}),
      })
      .where(eq(sshSessions.id, id));
  }

  async logCommands(input: { sessionId: string; userId: string; target: string; texts: string[] }): Promise<void> {
    if (!input.texts.length) return;
    await this.db.insert(commands).values(
      input.texts.map((text) => ({
        id: randomUUID(),
        sessionId: input.sessionId,
        userId: input.userId,
        target: input.target,
        text: text.slice(0, 2000),
      })),
    );
  }

  list(userId: string, limit = 200): Promise<SshSessionRow[]> {
    return this.db.query.sshSessions.findMany({
      where: eq(sshSessions.userId, userId),
      orderBy: [desc(sshSessions.startedAt)],
      limit,
    });
  }

  /** Every session (admin only). */
  listAll(limit = 300): Promise<SshSessionRow[]> {
    return this.db.query.sshSessions.findMany({
      orderBy: [desc(sshSessions.startedAt)],
      limit,
    });
  }

  getSession(userId: string, id: string): Promise<SshSessionRow | undefined> {
    return this.db.query.sshSessions.findFirst({
      where: and(eq(sshSessions.id, id), eq(sshSessions.userId, userId)),
    });
  }

  getSessionAny(id: string): Promise<SshSessionRow | undefined> {
    return this.db.query.sshSessions.findFirst({ where: eq(sshSessions.id, id) });
  }

  sessionCommands(userId: string, sessionId: string): Promise<Command[]> {
    return this.db.query.commands.findMany({
      where: and(eq(commands.sessionId, sessionId), eq(commands.userId, userId)),
      orderBy: [commands.ts],
      limit: 1000,
    });
  }

  sessionCommandsAny(sessionId: string): Promise<Command[]> {
    return this.db.query.commands.findMany({
      where: eq(commands.sessionId, sessionId),
      orderBy: [commands.ts],
      limit: 1000,
    });
  }

  searchCommands(userId: string, q: string, limit = 200): Promise<Command[]> {
    const where = q.trim()
      ? and(eq(commands.userId, userId), like(commands.text, `%${q.trim()}%`))
      : eq(commands.userId, userId);
    return this.db.query.commands.findMany({
      where,
      orderBy: [desc(commands.ts)],
      limit,
    });
  }

  searchCommandsAll(q: string, limit = 300): Promise<Command[]> {
    return this.db.query.commands.findMany({
      where: q.trim() ? like(commands.text, `%${q.trim()}%`) : undefined,
      orderBy: [desc(commands.ts)],
      limit,
    });
  }

  /** Delete sessions (and cascade commands) older than `days`; returns recording paths to unlink. */
  async expiredRecordings(days: number): Promise<{ ids: string[]; paths: string[] }> {
    if (days <= 0) return { ids: [], paths: [] };
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = await this.db.query.sshSessions.findMany({ where: lt(sshSessions.startedAt, cutoff) });
    return {
      ids: rows.map((r) => r.id),
      paths: rows.map((r) => r.recordingPath).filter((p): p is string => Boolean(p)),
    };
  }

  async deleteSessions(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.delete(sshSessions).where(eq(sshSessions.id, id));
  }

  /** convenience for tests / recent-command widgets */
  recentCommands(userId: string, sinceSecs: number): Promise<Command[]> {
    return this.db.query.commands.findMany({
      where: and(eq(commands.userId, userId), gte(commands.ts, sinceSecs)),
      orderBy: [desc(commands.ts)],
    });
  }
}
