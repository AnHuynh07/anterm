import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { users } from '../../db/schema.js';
import { CredentialRepo, credentialToDto, type CredentialInput } from '../../connections/credentials.js';
import { auditActor, requireAuth, requireWriter } from '../app.js';

const body = z.object({
  name: z.string().min(1).max(80),
  sshUsername: z.string().max(128).nullish(),
  authType: z.enum(['password', 'key', 'agent']),
  secret: z.string().max(32_768).nullish(),
  passphrase: z.string().max(4096).nullish(),
  loginUsername: z.string().max(128).nullish(),
  loginPassword: z.string().max(4096).nullish(),
  enablePassword: z.string().max(4096).nullish(),
  setupCommands: z.string().max(8000).nullish(),
});

export function registerCredentialRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new CredentialRepo(ctx.db, ctx.config.appSecret);

  app.get('/credentials', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    if (user.role === 'admin') {
      const rows = await repo.listAll();
      const names = new Map(
        (await ctx.db.query.users.findMany({ where: inArray(users.id, [...new Set(rows.map((r) => r.userId))]) })).map(
          (u) => [u.id, u.username],
        ),
      );
      return { credentials: rows.map((c) => ({ ...credentialToDto(c), ownerName: names.get(c.userId) })) };
    }
    return { credentials: (await repo.list(user.id)).map(credentialToDto) };
  });

  app.post('/credentials', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    try {
      const c = await repo.create(user.id, parsed.data as CredentialInput);
      ctx.activity.record({ actor: auditActor(req), action: 'credential.create', target: c.name });
      return reply.code(201).send({ credential: credentialToDto(c) });
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.put('/credentials/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });

    const owned = (await repo.get(user.id, id)) ?? (user.role === 'admin' ? await repo.getAny(id) : undefined);
    if (!owned) return reply.code(404).send({ error: 'credential not found' });
    try {
      const c = await repo.update(owned.userId, id, parsed.data as CredentialInput);
      if (!c) return reply.code(404).send({ error: 'credential not found' });
      ctx.activity.record({ actor: auditActor(req), action: 'credential.update', target: c.name });
      return { credential: credentialToDto(c) };
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.delete('/credentials/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const owned = (await repo.get(user.id, id)) ?? (user.role === 'admin' ? await repo.getAny(id) : undefined);
    if (!owned) return reply.code(404).send({ error: 'credential not found' });
    await repo.remove(owned.userId, id);
    ctx.activity.record({ actor: auditActor(req), action: 'credential.delete', target: owned.name });
    return { ok: true };
  });
}

function uniqueName(err: unknown): string {
  return /UNIQUE/i.test((err as Error)?.message ?? '')
    ? 'a credential with that name already exists'
    : 'could not save credential';
}
