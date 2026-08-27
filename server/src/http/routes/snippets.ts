import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { SnippetRepo } from '../../snippets/repo.js';
import { requireAuth, requireWriter } from '../app.js';

const body = z.object({
  name: z.string().min(1).max(60),
  command: z.string().min(1).max(4000),
  sortOrder: z.number().int().optional(),
});

export function registerSnippetRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new SnippetRepo(ctx.db);
  const dto = (s: { id: string; name: string; command: string; sortOrder: number }) => ({
    id: s.id,
    name: s.name,
    command: s.command,
    sortOrder: s.sortOrder,
  });

  app.get('/snippets', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    return { snippets: (await repo.list(user.id)).map(dto) };
  });

  app.post('/snippets', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid snippet' });
    return reply.code(201).send({ snippet: dto(await repo.create(user.id, parsed.data)) });
  });

  app.put('/snippets/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid snippet' });
    const s = await repo.update(user.id, (req.params as { id: string }).id, parsed.data);
    if (!s) return reply.code(404).send({ error: 'snippet not found' });
    return { snippet: dto(s) };
  });

  app.delete('/snippets/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const ok = await repo.remove(user.id, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: 'snippet not found' });
    return { ok: true };
  });
}
