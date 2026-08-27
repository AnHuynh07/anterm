import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import type { User } from '../../db/schema.js';
import { authenticate, setPassword } from '../../auth/users.js';
import { verifyPassword } from '../../auth/password.js';
import { CSRF_COOKIE, SID_COOKIE } from '../../auth/session.js';
import { clearCookieOptions, csrfCookieOptions, sessionCookieOptions } from '../cookies.js';
import { requireAuth } from '../app.js';

const loginBody = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) });
const passwordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(256) });

function publicUser(u: User) {
  return { id: u.id, username: u.username, role: u.role };
}

export function registerAuthRoutes(app: AnyFastify, ctx: AppContext): void {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials payload' });

      const user = await authenticate(ctx.db, parsed.data.username, parsed.data.password);
      if (!user) {
        ctx.activity.record({
          actor: { id: null, name: parsed.data.username.toLowerCase().slice(0, 64), ip: req.ip },
          action: 'auth.login_failed',
        });
        return reply.code(401).send({ error: 'invalid username or password' });
      }

      const session = await ctx.sessions.create(user.id, {
        userAgent: req.headers['user-agent'],
        clientIp: req.ip,
      });
      reply.setCookie(SID_COOKIE, session.sessionId, sessionCookieOptions(ctx.config));
      reply.setCookie(CSRF_COOKIE, session.csrf, csrfCookieOptions(ctx.config));
      ctx.activity.record({
        actor: { id: user.id, name: user.username, ip: req.ip },
        action: 'auth.login',
      });
      return { user: publicUser(user), csrf: session.csrf };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    if (req.authUser) {
      ctx.activity.record({
        actor: { id: req.authUser.id, name: req.authUser.username, ip: req.ip },
        action: 'auth.logout',
      });
    }
    if (req.sessionId) await ctx.sessions.destroy(req.sessionId);
    reply.clearCookie(SID_COOKIE, clearCookieOptions(ctx.config));
    reply.clearCookie(CSRF_COOKIE, clearCookieOptions(ctx.config));
    return { ok: true };
  });

  app.get('/auth/me', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    return { user: publicUser(user), csrf: req.csrfToken };
  });

  app.post('/auth/password', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'password must be at least 8 characters' });

    const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!ok) return reply.code(403).send({ error: 'current password is incorrect' });

    await setPassword(ctx.db, user.id, parsed.data.newPassword);
    await ctx.sessions.destroyAllForUser(user.id, req.sessionId ?? undefined);
    ctx.activity.record({
      actor: { id: user.id, name: user.username, ip: req.ip },
      action: 'auth.password_changed',
    });
    return { ok: true };
  });
}
