import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import type { User } from '../../db/schema.js';
import { authenticate, findById, setPassword, setTotp } from '../../auth/users.js';
import { verifyPassword } from '../../auth/password.js';
import { CSRF_COOKIE, SID_COOKIE } from '../../auth/session.js';
import { encryptSecret, maybeDecrypt } from '../../crypto/secrets.js';
import { generateSecret, makeRecoveryCodes, otpauthUri, verifyTotp } from '../../auth/totp.js';
import { clearCookieOptions, csrfCookieOptions, sessionCookieOptions } from '../cookies.js';
import { requireAuth } from '../app.js';

const loginBody = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) });
const login2faBody = z.object({ ticket: z.string().min(8).max(128), code: z.string().min(6).max(20) });
const passwordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(256) });
const enableBody = z.object({ code: z.string().min(6).max(10) });
const disableBody = z.object({ password: z.string().min(1) });

const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role, totpEnabled: u.totpEnabled });

export function registerAuthRoutes(app: AnyFastify, ctx: AppContext): void {
  const secret = ctx.config.appSecret;

  async function startSession(user: User, req: FastifyRequest, reply: FastifyReply) {
    const session = await ctx.sessions.create(user.id, { userAgent: req.headers['user-agent'], clientIp: req.ip });
    reply.setCookie(SID_COOKIE, session.sessionId, sessionCookieOptions(ctx.config));
    reply.setCookie(CSRF_COOKIE, session.csrf, csrfCookieOptions(ctx.config));
    ctx.activity.record({ actor: { id: user.id, name: user.username, ip: req.ip }, action: 'auth.login' });
    return { user: publicUser(user), csrf: session.csrf };
  }

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
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

    if (user.totpEnabled) {
      return { mfaRequired: true, ticket: ctx.sessions.createMfaTicket(user.id) };
    }
    return startSession(user, req, reply);
  });

  app.post('/auth/login/2fa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = login2faBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const userId = ctx.sessions.consumeMfaTicket(parsed.data.ticket);
    if (!userId) return reply.code(401).send({ error: 'this login attempt expired — start over' });
    const user = await findById(ctx.db, userId);
    if (!user || user.disabled) return reply.code(401).send({ error: 'account unavailable' });

    const totpSecret = maybeDecrypt(user.totpSecretEnc, secret);
    const codes: string[] = user.totpRecoveryEnc ? JSON.parse(maybeDecrypt(user.totpRecoveryEnc, secret) ?? '[]') : [];
    const code = parsed.data.code.replace(/\s+/g, '').toLowerCase();

    if (totpSecret && verifyTotp(totpSecret, code)) {
      return startSession(user, req, reply);
    }
    const rIdx = codes.indexOf(code);
    if (rIdx !== -1) {
      codes.splice(rIdx, 1);
      await setTotp(ctx.db, user.id, { totpRecoveryEnc: encryptSecret(JSON.stringify(codes), secret) });
      ctx.activity.record({
        actor: { id: user.id, name: user.username, ip: req.ip },
        action: 'auth.2fa_recovery_used',
        detail: { remaining: codes.length },
      });
      return startSession(user, req, reply);
    }
    ctx.activity.record({ actor: { id: user.id, name: user.username, ip: req.ip }, action: 'auth.login_failed', detail: { step: '2fa' } });
    return reply.code(401).send({ error: 'incorrect code' });
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.authUser) {
      ctx.activity.record({ actor: { id: req.authUser.id, name: req.authUser.username, ip: req.ip }, action: 'auth.logout' });
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
    if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
      return reply.code(403).send({ error: 'current password is incorrect' });
    }
    await setPassword(ctx.db, user.id, parsed.data.newPassword);
    await ctx.sessions.destroyAllForUser(user.id, req.sessionId ?? undefined);
    ctx.activity.record({ actor: { id: user.id, name: user.username, ip: req.ip }, action: 'auth.password_changed' });
    return { ok: true };
  });

  // ---- two-factor ----

  app.post('/auth/2fa/setup', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    if (user.totpEnabled) return reply.code(400).send({ error: '2FA is already enabled — disable it first' });
    const s = generateSecret();
    await setTotp(ctx.db, user.id, { totpSecretEnc: encryptSecret(s, secret), totpEnabled: false });
    return { secret: s, otpauthUri: otpauthUri(s, user.username) };
  });

  app.post('/auth/2fa/enable', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = enableBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'enter the 6-digit code' });
    const s = maybeDecrypt(user.totpSecretEnc, secret);
    if (!s) return reply.code(400).send({ error: 'run setup first' });
    if (!verifyTotp(s, parsed.data.code)) return reply.code(400).send({ error: 'that code is not valid — check your app clock' });

    const recovery = makeRecoveryCodes();
    await setTotp(ctx.db, user.id, {
      totpEnabled: true,
      totpRecoveryEnc: encryptSecret(JSON.stringify(recovery), secret),
    });
    ctx.activity.record({ actor: { id: user.id, name: user.username, ip: req.ip }, action: 'auth.2fa_enabled' });
    return { ok: true, recoveryCodes: recovery };
  });

  app.post('/auth/2fa/disable', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = disableBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'confirm your password' });
    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      return reply.code(403).send({ error: 'password is incorrect' });
    }
    await setTotp(ctx.db, user.id, { totpEnabled: false, totpSecretEnc: null, totpRecoveryEnc: null });
    ctx.activity.record({ actor: { id: user.id, name: user.username, ip: req.ip }, action: 'auth.2fa_disabled' });
    return { ok: true };
  });
}
