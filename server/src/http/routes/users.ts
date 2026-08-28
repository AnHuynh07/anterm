import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { appSessions } from '../../db/schema.js';
import {
  activeAdminCount,
  createUser,
  deleteUser,
  findByUsername,
  listUsers,
  setPassword,
  updateUser,
} from '../../auth/users.js';
import { auditActor, requireRole, requireWriter } from '../app.js';

const createBody = z.object({
  username: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i, 'letters, digits, . _ - only'),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'operator', 'viewer']).default('operator'),
});
const patchBody = z.object({
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  disabled: z.boolean().optional(),
});
const pwBody = z.object({ newPassword: z.string().min(8).max(256) });

export function registerUserRoutes(app: AnyFastify, ctx: AppContext): void {
  // A trimmed user list any writer can read — powers the "share with…" picker.
  app.get('/users/pickable', async (req, reply) => {
    const me = requireWriter(req, reply);
    if (!me) return;
    const all = await listUsers(ctx.db);
    return { users: all.filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, role: u.role })) };
  });

  app.get('/users', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const all = await listUsers(ctx.db);
    const sessions = await ctx.db.select().from(appSessions);
    const activeByUser = new Map<string, number>();
    for (const s of sessions) activeByUser.set(s.userId, (activeByUser.get(s.userId) ?? 0) + 1);
    return {
      users: all.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        disabled: u.disabled,
        twoFactor: u.totpEnabled,
        createdAt: u.createdAt,
        activeSessions: activeByUser.get(u.id) ?? 0,
        isSelf: u.id === me.id,
      })),
    };
  });

  app.post('/users', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (await findByUsername(ctx.db, parsed.data.username)) {
      return reply.code(409).send({ error: 'a user with that name already exists' });
    }
    const user = await createUser(ctx.db, parsed.data);
    ctx.activity.record({
      actor: auditActor(req),
      action: 'user.create',
      target: user.username,
      detail: { role: user.role },
    });
    return reply.code(201).send({ user: { id: user.id, username: user.username, role: user.role, disabled: false } });
  });

  app.patch('/users/:id', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const { id } = req.params as { id: string };
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });

    const target = (await listUsers(ctx.db)).find((u) => u.id === id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (target.id === me.id && (parsed.data.role === 'viewer' || parsed.data.role === 'operator' || parsed.data.disabled)) {
      return reply.code(400).send({ error: "you can't demote or disable your own account" });
    }
    const losingAdmin =
      target.role === 'admin' && !target.disabled && (parsed.data.role === 'operator' || parsed.data.role === 'viewer' || parsed.data.disabled === true);
    if (losingAdmin && (await activeAdminCount(ctx.db)) <= 1) {
      return reply.code(400).send({ error: 'cannot remove the last active admin' });
    }

    const updated = await updateUser(ctx.db, id, parsed.data);
    if (parsed.data.disabled) await ctx.sessions.destroyAllForUser(id);
    ctx.activity.record({
      actor: auditActor(req),
      action: 'user.update',
      target: target.username,
      detail: parsed.data,
    });
    return { user: { id, username: target.username, role: updated?.role, disabled: updated?.disabled } };
  });

  app.post('/users/:id/password', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const { id } = req.params as { id: string };
    const parsed = pwBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const target = (await listUsers(ctx.db)).find((u) => u.id === id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    await setPassword(ctx.db, id, parsed.data.newPassword);
    await ctx.sessions.destroyAllForUser(id, id === me.id ? (req.sessionId ?? undefined) : undefined);
    ctx.activity.record({ actor: auditActor(req), action: 'user.password_reset', target: target.username });
    return { ok: true };
  });

  app.delete('/users/:id', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const { id } = req.params as { id: string };
    if (id === me.id) return reply.code(400).send({ error: "you can't delete your own account" });
    const target = (await listUsers(ctx.db)).find((u) => u.id === id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (target.role === 'admin' && !target.disabled && (await activeAdminCount(ctx.db)) <= 1) {
      return reply.code(400).send({ error: 'cannot delete the last active admin' });
    }
    await ctx.sessions.destroyAllForUser(id);
    await ctx.db.delete(appSessions).where(eq(appSessions.userId, id));
    await deleteUser(ctx.db, id);
    ctx.activity.record({ actor: auditActor(req), action: 'user.delete', target: target.username });
    return { ok: true };
  });
}
