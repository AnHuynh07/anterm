import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../auth/users.js';
import { SnippetRepo } from './repo.js';

async function setup() {
  const h = createDb(':memory:');
  runMigrations(h.sqlite);
  const user = await createUser(h.db, { username: 'u', password: 'pw123456' });
  return { repo: new SnippetRepo(h.db), userId: user.id };
}

describe('SnippetRepo', () => {
  it('creates, lists in order, updates and deletes', async () => {
    const { repo, userId } = await setup();
    await repo.create(userId, { name: 'B', command: 'show version', sortOrder: 2 });
    const a = await repo.create(userId, { name: 'A', command: 'show run', sortOrder: 1 });

    let list = await repo.list(userId);
    expect(list.map((s) => s.name)).toEqual(['A', 'B']);

    await repo.update(userId, a.id, { name: 'A2', command: 'show ip route' });
    list = await repo.list(userId);
    expect(list[0]).toMatchObject({ name: 'A2', command: 'show ip route' });

    expect(await repo.remove(userId, a.id)).toBe(true);
    expect((await repo.list(userId)).length).toBe(1);
    expect(await repo.remove(userId, 'nope')).toBe(false);
  });

  it("does not touch another user's snippets", async () => {
    const { repo, userId } = await setup();
    const mine = await repo.create(userId, { name: 'x', command: 'y' });
    expect(await repo.remove('someone-else', mine.id)).toBe(false);
  });
});
