import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { AnyFastify } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppContext } from '../context.js';
import type { User } from '../db/schema.js';
import { CSRF_COOKIE, SID_COOKIE } from '../auth/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerSnippetRoutes } from './routes/snippets.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerUserRoutes } from './routes/users.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerVaultRoutes } from './routes/vault.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerWebProxy } from '../web/proxy.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: User | null;
    sessionId: string | null;
    csrfToken: string | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(ctx: AppContext): Promise<AnyFastify> {
  const { config } = ctx;
  const https =
    config.sslKey && config.sslCert
      ? { key: readFileSync(config.sslKey), cert: readFileSync(config.sslCert) }
      : null;
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: config.trustProxy,
    bodyLimit: 1_000_000,
    ...(https ? { https } : {}),
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'font-src': ["'self'", 'data:'],
        'frame-ancestors': config.allowIframe ? ["'self'"] : ["'none'"],
        // keep ws:// working when AnTerm is deployed on plain HTTP (dev / trusted LAN)
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: config.allowIframe ? false : { action: 'deny' },
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('authUser', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);

  // Resolve the session for every request.
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies[SID_COOKIE];
    const resolved = await ctx.sessions.resolve(sid);
    if (resolved) {
      req.authUser = resolved.user;
      req.sessionId = resolved.sessionId;
      req.csrfToken = resolved.csrf;
    }
  });

  // Web-proxy escape hatch: a device page may request an absolute path our
  // rewriting missed (e.g. `/iss/x.js`). If it came from a proxy iframe, send it
  // back through the proxy for that connection.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (
      path.startsWith('/api/') ||
      path.startsWith('/ws/') ||
      path.startsWith('/webproxy/') ||
      path.startsWith('/assets/') ||
      path === '/' ||
      path === '/index.html'
    )
      return;
    const ref = req.headers.referer;
    const m = ref && /\/webproxy\/([^/]+)\//.exec(ref);
    if (m) return reply.redirect(`/webproxy/${m[1]}${req.url}`, 307);
  });

  // CSRF: double-submit — header must match the csrf cookie for state changes.
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const path = req.url.split('?')[0] ?? '';
    if (!path.includes('/api/')) return;
    if (path.endsWith('/api/auth/login') || path.endsWith('/api/auth/login/2fa')) return; // no session yet
    const headerToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies[CSRF_COOKIE];
    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      return reply.code(403).send({ error: 'csrf token mismatch' });
    }
  });

  const api = async (scoped: AnyFastify): Promise<void> => {
    registerHealthRoutes(scoped, ctx);
    registerAuthRoutes(scoped, ctx);
    registerUserRoutes(scoped, ctx);
    registerActivityRoutes(scoped, ctx);
    registerVaultRoutes(scoped, ctx);
    registerSettingsRoutes(scoped, ctx);
    registerCredentialRoutes(scoped, ctx);
    registerSnippetRoutes(scoped, ctx);
    registerConnectionRoutes(scoped, ctx);
    registerSessionRoutes(scoped, ctx);
  };

  const prefix = config.base === '/' ? undefined : config.base;
  await app.register(async (scoped) => {
    await scoped.register(api, { prefix: '/api' });
    registerWebProxy(scoped, ctx);
    await registerSpa(scoped, config.isDev);
  }, prefix ? { prefix } : {});

  return app;
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): User | undefined {
  if (!req.authUser) {
    reply.code(401).send({ error: 'authentication required' });
    return undefined;
  }
  return req.authUser;
}

/** Authenticated and holding one of `roles` — else 403. */
export function requireRole(req: FastifyRequest, reply: FastifyReply, ...roles: User['role'][]): User | undefined {
  const user = requireAuth(req, reply);
  if (!user) return undefined;
  if (!roles.includes(user.role)) {
    reply.code(403).send({ error: 'insufficient permissions' });
    return undefined;
  }
  return user;
}

/** Authenticated and able to make changes (admin or operator, never viewer). */
export function requireWriter(req: FastifyRequest, reply: FastifyReply): User | undefined {
  return requireRole(req, reply, 'admin', 'operator');
}

export function auditActor(req: FastifyRequest): { id: string | null; name: string | null; ip: string | null } {
  return { id: req.authUser?.id ?? null, name: req.authUser?.username ?? null, ip: req.ip ?? null };
}

async function registerSpa(app: AnyFastify, isDev: boolean): Promise<void> {
  // In dev the Vite server serves the SPA; only wire static hosting for prod builds.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(here, '..', 'public');
  if (isDev || !existsSync(publicDir)) return;

  await app.register(fastifyStatic, { root: publicDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.includes('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}
