import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { snippets, type Snippet } from '../db/schema.js';

export interface SnippetInput {
  name: string;
  command: string;
  sortOrder?: number;
}

export class SnippetRepo {
  constructor(private readonly db: Db) {}

  list(userId: string): Promise<Snippet[]> {
    return this.db.query.snippets.findMany({
      where: eq(snippets.userId, userId),
      orderBy: [asc(snippets.sortOrder), asc(snippets.createdAt)],
    });
  }

  async create(userId: string, input: SnippetInput): Promise<Snippet> {
    const id = randomUUID();
    await this.db.insert(snippets).values({
      id,
      userId,
      name: input.name.trim(),
      command: input.command,
      sortOrder: input.sortOrder ?? 0,
    });
    const created = await this.db.query.snippets.findFirst({ where: eq(snippets.id, id) });
    if (!created) throw new Error('failed to read back snippet');
    return created;
  }

  async update(userId: string, id: string, input: SnippetInput): Promise<Snippet | undefined> {
    const existing = await this.db.query.snippets.findFirst({
      where: and(eq(snippets.id, id), eq(snippets.userId, userId)),
    });
    if (!existing) return undefined;
    await this.db
      .update(snippets)
      .set({ name: input.name.trim(), command: input.command, sortOrder: input.sortOrder ?? existing.sortOrder })
      .where(eq(snippets.id, id));
    return this.db.query.snippets.findFirst({ where: eq(snippets.id, id) });
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.db.query.snippets.findFirst({
      where: and(eq(snippets.id, id), eq(snippets.userId, userId)),
    });
    if (!existing) return false;
    await this.db.delete(snippets).where(eq(snippets.id, id));
    return true;
  }
}
