import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { ConnectionRepo } from '../connections/repo.js';
import type { Connection } from '../db/schema.js';
import { MAX_LOGIN_ATTEMPTS, authHeaders, ensureAuthed, formLogin, rawRequest } from './session.js';

export interface WebConfigResult {
  /** normalised text to snapshot + diff */
  content: string;
  /** the device returned a binary blob; `content` is just a summary + sha256 */
  binary: boolean;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b === 127) bad++;
  }
  return bad / n > 0.1;
}

/**
 * Download a web-managed device's configuration through its authenticated proxy
 * session (`settings.configUrl`). Text configs are returned verbatim for a real
 * diff; binary `.cfg` blobs are reduced to a size + sha256 summary so drift is
 * still detectable without a noisy hex diff.
 */
export async function fetchWebConfig(ctx: AppContext, conn: Connection): Promise<WebConfigResult> {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);
  const web = repo.resolveWebTarget(conn);
  if (!web) throw new Error('web device settings are incomplete');
  if (!web.configUrl) throw new Error('no config backup URL set for this device');

  const base = new URL(web.url);
  const allow = ctx.config.allowHosts;
  if (allow.length && !allow.includes(base.hostname.toLowerCase())) {
    throw new Error(`target host not allowed: ${base.hostname}`);
  }

  const sess = ctx.webProxy.get(conn.userId, conn.id);
  await ensureAuthed(web, sess);

  const url = new URL(web.configUrl, base).toString();
  const doGet = () =>
    rawRequest({
      url,
      method: 'GET',
      headers: { host: base.host, 'accept-encoding': 'identity', 'user-agent': 'AnTerm-config', ...authHeaders(web, sess) },
      insecureTls: web.insecureTls,
    });

  let res = await doGet();
  if (res.status === 401 && web.authMode === 'form' && sess.loginAttempts < MAX_LOGIN_ATTEMPTS) {
    sess.cookies.clear();
    await formLogin(web, sess);
    res = await doGet();
  }
  if (res.status >= 400 || res.body.length === 0) {
    throw new Error(`the device returned HTTP ${res.status} for the config URL`);
  }

  if (looksBinary(res.body)) {
    const sha = createHash('sha256').update(res.body).digest('hex');
    return {
      binary: true,
      content: `# AnTerm binary configuration snapshot\n# bytes: ${res.body.length}\n# sha256: ${sha}\n`,
    };
  }
  return { binary: false, content: res.body.toString('utf8') };
}
