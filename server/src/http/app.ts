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
import { registerSessionRoutes } from './routes/sessions.js';
import { registerHealthRoutes } from './routes/health.js';

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

  // CSRF: double-submit — header must match the csrf cookie for state changes.
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const path = req.url.split('?')[0] ?? '';
    if (!path.includes('/api/')) return;
    if (path.endsWith('/api/auth/login')) return; // no session yet
    const headerToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies[CSRF_COOKIE];
    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      return reply.code(403).send({ error: 'csrf token mismatch' });
    }
  });

  const api = async (scoped: AnyFastify): Promise<void> => {
    registerHealthRoutes(scoped, ctx);
    registerAuthRoutes(scoped, ctx);
    registerConnectionRoutes(scoped, ctx);
    registerSessionRoutes(scoped, ctx);
  };

  const prefix = config.base === '/' ? undefined : config.base;
  await app.register(async (scoped) => {
    await scoped.register(api, { prefix: '/api' });
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
