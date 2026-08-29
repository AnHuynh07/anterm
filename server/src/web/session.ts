import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { ResolvedWebTarget } from '../connections/repo.js';

export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_LOGIN_ATTEMPTS = 2;
export const MAX_BODY = 60 * 1024 * 1024;

export interface ProxySession {
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

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function rawRequest(opts: {
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

export function captureCookies(sess: ProxySession, setCookie: string | string[] | undefined): void {
  if (!setCookie) return;
  for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) sess.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

export function cookieHeader(sess: ProxySession): string | undefined {
  if (sess.cookies.size === 0) return undefined;
  return [...sess.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** POST the device's login form and hold the session cookie. */
export async function formLogin(web: ResolvedWebTarget, sess: ProxySession): Promise<void> {
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
  const looksLikeLogin =
    res.status === 200 && /name=["'](Login|Password|username|passwd)["']/i.test(res.body.toString('latin1'));
  if ((res.status >= 400 || looksLikeLogin) && !cookieHeader(sess)) {
    throw new Error('the device rejected the credentials');
  }
}

/** Auth headers to inject into an upstream request for this session. */
export function authHeaders(web: ResolvedWebTarget, sess: ProxySession): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = {};
  const ck = cookieHeader(sess);
  if (ck) h['cookie'] = ck;
  if (web.authMode === 'basic' && web.username != null) {
    h['authorization'] = 'Basic ' + Buffer.from(`${web.username}:${web.password ?? ''}`).toString('base64');
  }
  return h;
}

/** Make sure the session can talk to the device (form-login if needed). */
export async function ensureAuthed(web: ResolvedWebTarget, sess: ProxySession): Promise<void> {
  if (web.authMode === 'form' && sess.cookies.size === 0 && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
    await formLogin(web, sess);
  }
}
