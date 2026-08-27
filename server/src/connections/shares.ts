import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connectionShares, users, type ConnectionShare } from '../db/schema.js';

export interface ShareDto {
  userId: string;
  username: string;
  canEdit: boolean;
}

export class ShareRepo {
  constructor(private readonly db: Db) {}

  getFor(connectionId: string, userId: string): Promise<ConnectionShare | undefined> {
    return this.db.query.connectionShares.findFirst({
      where: and(eq(connectionShares.connectionId, connectionId), eq(connectionShares.userId, userId)),
    });
  }

  /** Map of connectionId -> canEdit for every connection shared with a user. */
  async forUser(userId: string): Promise<Map<string, boolean>> {
    const rows = await this.db.query.connectionShares.findMany({ where: eq(connectionShares.userId, userId) });
    return new Map(rows.map((r) => [r.connectionId, r.canEdit]));
  }

  async dtos(connectionId: string): Promise<ShareDto[]> {
    const rows = await this.db.query.connectionShares.findMany({
      where: eq(connectionShares.connectionId, connectionId),
    });
    if (!rows.length) return [];
    const us = await this.db.query.users.findMany({ where: inArray(users.id, rows.map((r) => r.userId)) });
    const nameById = new Map(us.map((u) => [u.id, u.username]));
    return rows.map((r) => ({ userId: r.userId, username: nameById.get(r.userId) ?? '(deleted user)', canEdit: r.canEdit }));
  }

  /** Replace the whole share set for a connection in one shot. */
  async replace(connectionId: string, shares: { userId: string; canEdit: boolean }[]): Promise<void> {
    await this.db.delete(connectionShares).where(eq(connectionShares.connectionId, connectionId));
    if (!shares.length) return;
    await this.db.insert(connectionShares).values(
      shares.map((s) => ({
        id: randomUUID(),
        connectionId,
        userId: s.userId,
        canEdit: s.canEdit,
      })),
    );
  }
}
