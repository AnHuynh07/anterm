import http from 'node:http';
import { Buffer } from 'node:buffer';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { AnyFastify } from '../http/types.js';
import { auditActor, requireAuth } from '../http/app.js';
import { ConnectionRepo } from '../connections/repo.js';
import { ShareRepo } from '../connections/shares.js';
import { connAccess } from '../access.js';
import {
  MAX_BODY,
  MAX_LOGIN_ATTEMPTS,
  authHeaders,
  canFormLogin,
  captureCookies,
  formLogin,
  rawRequest,
  type RawResponse,
} from './session.js';

export { WebProxyRegistry } from './session.js';

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

      const formLoginOk = canFormLogin(web);

      // Picky embedded servers (e.g. AT-GS950) answer HEAD with 405 — ask for GET
      // and drop the body ourselves.
      const method = req.method === 'HEAD' ? 'GET' : req.method;

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
        // Rewrite Referer/Origin to the device's own site rather than dropping them —
        // some embedded UIs reject an action POST that arrives with neither.
        const refMatch = String(req.headers['referer'] ?? '').match(/\/webproxy\/[^/]+\/(.*)$/);
        headers['referer'] = refMatch ? new URL(refMatch[1] ?? '', base).toString() : base.origin + '/';
        headers['origin'] = base.origin;
        Object.assign(headers, authHeaders(web, sess));
        const rawBody = req.body instanceof Buffer ? req.body : undefined;
        if (rawBody?.length) headers['content-length'] = rawBody.length;

        return rawRequest({ url: upstream, method, headers, body: rawBody, insecureTls: web.insecureTls });
      };

      // the device bounced us to its login screen (some answer 200/403, not 401)
      const needsLogin = (res: RawResponse): boolean => {
        if (res.status === 401 || res.status === 403) return true;
        if (res.status !== 200) return false;
        const ct = String(res.headers['content-type'] ?? '');
        return /text\/html/i.test(ct) && /name=["'](Login|Password|username|passwd)["']/i.test(res.body.toString('latin1'));
      };

      try {
        if (formLoginOk && sess.cookies.size === 0 && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
          await formLogin(web, sess);
          ctx.activity.record({ actor: auditActor(req), action: 'webdevice.open', target: web.url });
        }

        let res = await doForward();
        if (formLoginOk && needsLogin(res) && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
          sess.cookies.clear();
          await formLogin(web, sess);
          res = await doForward();
        }
        // login succeeded once we get real content back
        if (res.status < 400) sess.loginAttempts = 0;

        // Remember the last real inner page we served so a plain reload of
        // /webproxy/:id/ lands back there — many switch roots only ever show login.
        if (
          req.method === 'GET' &&
          rest !== '' &&
          !qs &&
          res.status === 200 &&
          /text\/html/i.test(String(res.headers['content-type'] ?? '')) &&
          !needsLogin(res)
        ) {
          sess.landingPath = rest;
        }

        if (req.method === 'HEAD') res = { ...res, body: Buffer.alloc(0) };

        if (res.status >= 400) {
          const target = new URL((rest === '' ? (sess.landingPath ?? '') : rest) + qs, base).toString();
          ctx.log.info(
            { device: web.url, method: req.method, target, status: res.status, authMode: web.authMode },
            'web proxy: device returned an error',
          );
          reply.header('x-anterm-upstream', `${res.status} ${req.method} ${target}`);
        }

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
