import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { CredentialRepo, credentialToDto, type CredentialInput } from '../../connections/credentials.js';
import { requireAuth } from '../app.js';

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
    return { credentials: (await repo.list(user.id)).map(credentialToDto) };
  });

  app.post('/credentials', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    try {
      const c = await repo.create(user.id, parsed.data as CredentialInput);
      return reply.code(201).send({ credential: credentialToDto(c) });
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.put('/credentials/:id', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    try {
      const c = await repo.update(user.id, id, parsed.data as CredentialInput);
      if (!c) return reply.code(404).send({ error: 'credential not found' });
      return { credential: credentialToDto(c) };
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.delete('/credentials/:id', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const ok = await repo.remove(user.id, id);
    if (!ok) return reply.code(404).send({ error: 'credential not found' });
    return { ok: true };
  });
}

function uniqueName(err: unknown): string {
  return /UNIQUE/i.test((err as Error)?.message ?? '')
    ? 'a credential with that name already exists'
    : 'could not save credential';
}
