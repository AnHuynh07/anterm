import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { AnyFastify } from '../http/types.js';
import { auditActor, requireAuth } from '../http/app.js';
import { ConnectionRepo, type ResolvedWebTarget } from '../connections/repo.js';
import { ShareRepo } from '../connections/shares.js';
import { connAccess } from '../access.js';

const SESSION_TTL_MS = 30 * 60_000;
const MAX_LOGIN_ATTEMPTS = 2;
const MAX_BODY = 60 * 1024 * 1024;

interface ProxySession {
  /** switch cookie jar: name -> value */
  cookies: Map<string, string>;
  /** where the switch redirected us after a successful login */
  landingPath: string | null;
  loginAttempts: number;
  lastUsed: number;
}

/** Process-wide table of per-(user, connection) proxy sessions to web devices. */
export class WebProxyRegistry {
  private map = new Map<string, ProxySession>();

  private sweep(): void {
    const cut = Date.now() - SESSION_TTL_MS;
    for (const [k, s] of this.map) if (s.lastUsed < cut) this.map.delete(k);
  }
  get(userId: string, connId: string): ProxySession {
    this.sweep();
    const key = `${userId}:${connId}`;
    let s = this.map.get(key);
    if (!s) {
      s = { cookies: new Map(), landingPath: null, loginAttempts: 0, lastUsed: Date.now() };
      this.map.set(key, s);
    }
    s.lastUsed = Date.now();
    return s;
  }
  reset(userId: string, connId: string): void {
    this.map.delete(`${userId}:${connId}`);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawRequest(opts: {
  url: string;
  method: string;
  headers: http.OutgoingHttpHeaders;
  body?: Buffer;
  insecureTls: boolean;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      reject(new Error(`bad upstream url: ${opts.url}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: opts.method,
        headers: opts.headers,
        timeout: 15_000,
        ...(u.protocol === 'https:' && opts.insecureTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n <= MAX_BODY) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timed out')));
    if (opts.body?.length) req.write(opts.body);
    req.end();
  });
}

function captureCookies(sess: ProxySession, setCookie: string | string[] | undefined): void {
  if (!setCookie) return;
  for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) sess.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(sess: ProxySession): string | undefined {
  if (sess.cookies.size === 0) return undefined;
  return [...sess.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Absolute or root-relative URL on the same host -> proxy-relative path. */
function toProxyPath(loc: string, base: URL, prefix: string): string {
  try {
    const u = new URL(loc, base);
    if (u.host === base.host) return prefix + u.pathname.replace(/^\//, '') + u.search + u.hash;
    return loc; // external redirect: leave it (UI shows a "degraded" hint)
  } catch {
    return loc;
  }
}

const HTML_RE = /\b(href|src|action|background|data-src)\s*=\s*(['"])\/(?!\/)/gi;
const CSS_URL_RE = /url\(\s*(['"]?)\/(?!\/)/gi;
const META_REFRESH_RE = /(<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=)\/(?!\/)/gi;

function shim(prefix: string): string {
  return `<script>(function(){var B=${JSON.stringify(prefix)};function fix(u){if(typeof u!=='string')return u;if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return B+u.slice(1);return u;}
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){if(arguments[1])arguments[1]=fix(arguments[1]);return xo.apply(this,arguments);};
var wo=window.open;window.open=function(){if(arguments[0])arguments[0]=fix(arguments[0]);return wo.apply(this,arguments);};
if(window.fetch){var f=window.fetch;window.fetch=function(u,o){return f(fix(u),o);};}
document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest&&t.closest('a[href]');if(a){var h=a.getAttribute('href');if(h&&h.charAt(0)==='/'&&h.charAt(1)!=='/')a.setAttribute('href',fix(h));}},true);
document.addEventListener('submit',function(e){var fm=e.target;if(fm&&fm.getAttribute){var ac=fm.getAttribute('action');if(ac&&ac.charAt(0)==='/'&&ac.charAt(1)!=='/')fm.setAttribute('action',fix(ac));}},true);})();</script>`;
}

function rewriteHtml(html: string, prefix: string): string {
  let out = html
    .replace(HTML_RE, (_m, attr: string, q: string) => `${attr}=${q}${prefix}`)
    .replace(META_REFRESH_RE, (_m, head: string) => head + prefix);
  const inject = `<base href="${prefix}">${shim(prefix)}`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + inject);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + inject);
  else out = inject + out;
  return out;
}

function rewriteCss(css: string, prefix: string): string {
  return css.replace(CSS_URL_RE, (_m, q: string) => `url(${q}${prefix}`);
}

async function formLogin(web: ResolvedWebTarget, sess: ProxySession): Promise<void> {
  sess.loginAttempts += 1;
  const body = Buffer.from(
    new URLSearchParams({
      [web.userField]: web.username ?? '',
      [web.passField]: web.password ?? '',
    }).toString(),
  );
  const res = await rawRequest({
    url: new URL(web.loginPath, web.url).toString(),
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': body.length,
      'accept-encoding': 'identity',
      cookie: cookieHeader(sess) ?? '',
      'user-agent': 'AnTerm-web-proxy',
    },
    body,
    insecureTls: web.insecureTls,
  });
  captureCookies(sess, res.headers['set-cookie']);
  const loc = res.headers['location'];
  if (loc) {
    try {
      sess.landingPath = new URL(loc, web.url).pathname.replace(/^\//, '');
    } catch {
      /* ignore */
    }
  }
  // heuristic: redirect, or a 200 that is no longer the login form
  const looksLikeLogin = res.status === 200 && /name=["'](Login|Password|username|passwd)["']/i.test(res.body.toString('latin1'));
  if ((res.status >= 400 || looksLikeLogin) && !cookieHeader(sess)) {
    throw new Error('the device rejected the credentials');
  }
}

export function registerWebProxy(app: AnyFastify, ctx: AppContext): void {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);
  const shares = new ShareRepo(ctx.db);
  const registry = ctx.webProxy;

  // The reverse proxy lives outside /api so the browser loads it as a page and
  // sends the AnTerm session cookie. Its own content-type parser keeps bodies raw.
  app.register(async (scoped) => {
    scoped.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) =>
      done(null, body),
    );
    // beat helmet: let the device UI be framed by AnTerm, drop the device's own XFO/CSP
    scoped.addHook('onSend', async (_req, reply, payload) => {
      reply.header('content-security-policy', "frame-ancestors 'self'");
      reply.removeHeader('x-frame-options');
      return payload;
    });

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(req, reply);
      if (!user) return;
      if (!ctx.config.allowWebProxy) return reply.code(403).type('text/plain').send('web proxy is disabled on this server');

      const { id } = req.params as { id: string; '*'?: string };
      const rest = ((req.params as { '*'?: string })['*'] ?? '').replace(/^\/+/, '');
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

      const conn = await repo.getAny(id);
      if (!conn || conn.protocol !== 'http') return reply.code(404).type('text/plain').send('not a web device');
      const share =
        user.role === 'admin' || conn.userId === user.id ? null : ((await shares.getFor(conn.id, user.id)) ?? null);
      if (!connAccess(user, conn.userId, share).canOpen)
        return reply.code(403).type('text/plain').send('you do not have access to this device');

      const web = repo.resolveWebTarget(conn);
      if (!web) return reply.code(400).type('text/plain').send('web device settings are incomplete');

      const base = new URL(web.url);
      const allow = ctx.config.allowHosts;
      if (allow.length && !allow.includes(base.hostname.toLowerCase()))
        return reply.code(403).type('text/plain').send(`target host not allowed: ${base.hostname}`);

      const prefix = `${ctx.config.base === '/' ? '' : ctx.config.base}/webproxy/${id}/`;
      const sess = registry.get(user.id, id);

      const doForward = async (): Promise<RawResponse> => {
        const rootTarget = rest === '' ? (sess.landingPath ?? '') : rest;
        const upstream = new URL(rootTarget + qs, base).toString();

        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (['host', 'cookie', 'origin', 'referer', 'connection', 'accept-encoding', 'content-length', 'x-csrf-token'].includes(lk))
            continue;
          if (lk.startsWith('x-forwarded') || lk.startsWith('sec-')) continue;
          if (v !== undefined) headers[k] = v as string | string[];
        }
        headers['host'] = base.host;
        headers['accept-encoding'] = 'identity';
        const ck = cookieHeader(sess);
        if (ck) headers['cookie'] = ck;
        if (web.authMode === 'basic' && web.username != null) {
          headers['authorization'] = 'Basic ' + Buffer.from(`${web.username}:${web.password ?? ''}`).toString('base64');
        }
        const rawBody = req.body instanceof Buffer ? req.body : undefined;
        if (rawBody?.length) headers['content-length'] = rawBody.length;

        return rawRequest({ url: upstream, method: req.method, headers, body: rawBody, insecureTls: web.insecureTls });
      };

      try {
        if (web.authMode === 'form' && sess.cookies.size === 0 && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
          await formLogin(web, sess);
          ctx.activity.record({ actor: auditActor(req), action: 'webdevice.open', target: web.url });
        }

        let res = await doForward();
        if (res.status === 401 && web.authMode === 'form' && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
          sess.cookies.clear();
          await formLogin(web, sess);
          res = await doForward();
        }
        // login succeeded once we get real content back
        if (res.status < 400) sess.loginAttempts = 0;

        // ---- rewrite the response ----
        const ct = String(res.headers['content-type'] ?? '');
        const status = res.status;

        for (const [k, v] of Object.entries(res.headers)) {
          const lk = k.toLowerCase();
          if (
            ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'x-frame-options', 'content-security-policy', 'strict-transport-security'].includes(
              lk,
            )
          )
            continue;
          if (lk === 'set-cookie') {
            captureCookies(sess, v as string | string[]); // keep server-side, don't leak to the browser
            continue;
          }
          if (lk === 'location' && typeof v === 'string') {
            reply.header('location', toProxyPath(v, base, prefix));
            continue;
          }
          if (v !== undefined) reply.header(k, v as string | string[]);
        }

        let out: Buffer | string = res.body;
        if (/text\/html/i.test(ct)) out = rewriteHtml(res.body.toString('utf8'), prefix);
        else if (/text\/css/i.test(ct)) out = rewriteCss(res.body.toString('utf8'), prefix);

        return reply.code(status).send(out);
      } catch (err) {
        registry.reset(user.id, id);
        ctx.log.info({ err: (err as Error).message, device: web.url }, 'web proxy error');
        return reply
          .code(502)
          .type('text/html')
          .send(
            `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:2rem;color:#334155">` +
              `<h3>Can't reach the device web UI</h3><p>${(err as Error).message}</p>` +
              `<p><a href="${web.url}" target="_blank" rel="noreferrer">Open ${web.url} in a new tab</a></p>`,
          );
      }
    };

    scoped.all('/webproxy/:id', handler);
    scoped.all('/webproxy/:id/*', handler);
  });
}
