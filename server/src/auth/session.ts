import { randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSessions, users, type User } from '../db/schema.js';

export const SID_COOKIE = 'anterm_sid';
export const CSRF_COOKIE = 'anterm_csrf';

export interface ResolvedSession {
  sessionId: string;
  csrf: string;
  user: User;
}

// csrf token travels in a readable cookie; we keep a server copy keyed by sid
// so a stolen csrf cookie alone is useless without the (HttpOnly) sid.
const csrfBySid = new Map<string, string>();

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
  ) {}

  async create(userId: string, meta: { userAgent?: string; clientIp?: string }): Promise<ResolvedSession> {
    const sessionId = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const expiresAt = Math.floor((Date.now() + this.ttlMs) / 1000);
    await this.db.insert(appSessions).values({
      id: sessionId,
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 512),
      clientIp: meta.clientIp,
    });
    csrfBySid.set(sessionId, csrf);
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new Error('user vanished during session create');
    return { sessionId, csrf, user };
  }

  async resolve(sessionId: string | undefined): Promise<ResolvedSession | null> {
    if (!sessionId) return null;
    const row = await this.db.query.appSessions.findFirst({ where: eq(appSessions.id, sessionId) });
    if (!row) return null;
    if (row.expiresAt * 1000 < Date.now()) {
      await this.destroy(sessionId);
      return null;
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!user || user.disabled) {
      await this.destroy(sessionId);
      return null;
    }
    // throttle last-seen writes to once per minute
    if (row.lastSeenAt * 1000 < Date.now() - 60_000) {
      await this.db
        .update(appSessions)
        .set({ lastSeenAt: Math.floor(Date.now() / 1000) })
        .where(eq(appSessions.id, sessionId));
    }
    let csrf = csrfBySid.get(sessionId);
    if (!csrf) {
      // process restarted — mint a fresh csrf token bound to this still-valid sid
      csrf = randomBytes(24).toString('base64url');
      csrfBySid.set(sessionId, csrf);
    }
    return { sessionId, csrf, user };
  }

  async destroy(sessionId: string): Promise<void> {
    csrfBySid.delete(sessionId);
    await this.db.delete(appSessions).where(eq(appSessions.id, sessionId));
  }

  async destroyAllForUser(userId: string, exceptSid?: string): Promise<void> {
    const rows = await this.db.query.appSessions.findMany({ where: eq(appSessions.userId, userId) });
    for (const r of rows) {
      if (r.id === exceptSid) continue;
      csrfBySid.delete(r.id);
    }
    await this.db
      .delete(appSessions)
      .where(
        exceptSid
          ? and(eq(appSessions.userId, userId), ne(appSessions.id, exceptSid))
          : eq(appSessions.userId, userId),
      );
  }

  async sweepExpired(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    await this.db.delete(appSessions).where(lt(appSessions.expiresAt, nowSec));
  }
}
