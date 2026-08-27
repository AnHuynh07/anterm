import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { AuditLog } from '../../audit.js';
import { users } from '../../db/schema.js';
import { requireAuth } from '../app.js';
import type { AnyFastify } from '../types.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function registerSessionRoutes(app: AnyFastify, ctx: AppContext): void {
  const audit = new AuditLog(ctx.db);
  const castPath = (rel: string) => join(ctx.config.recordingsDir, rel);

  const sessionFor = (userId: string, admin: boolean, id: string) =>
    admin ? audit.getSessionAny(id) : audit.getSession(userId, id);

  app.get('/sessions', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const admin = user.role === 'admin';
    const rows = admin ? await audit.listAll(300) : await audit.list(user.id, 300);
    const names = admin
      ? new Map(
          (
            await ctx.db.query.users.findMany({ where: inArray(users.id, [...new Set(rows.map((r) => r.userId))]) })
          ).map((u) => [u.id, u.username]),
        )
      : null;
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        target: r.target,
        user: names?.get(r.userId),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        clientIp: r.clientIp,
        bytesIn: r.bytesIn,
        bytesOut: r.bytesOut,
        exitReason: r.exitReason,
        hasRecording: Boolean(r.recordingPath),
        commandCount: r.commandCount,
      })),
    };
  });

  app.get('/sessions/:id/recording', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const s = await sessionFor(user.id, user.role === 'admin', (req.params as { id: string }).id);
    if (!s?.recordingPath) return reply.code(404).send({ error: 'no recording for this session' });
    try {
      const body = await readFile(castPath(s.recordingPath), 'utf8');
      return reply.type('application/x-asciicast').send(body);
    } catch {
      return reply.code(410).send({ error: 'recording file is gone (retention or disk cleanup)' });
    }
  });

  app.get('/sessions/:id/recording.txt', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const s = await sessionFor(user.id, user.role === 'admin', (req.params as { id: string }).id);
    if (!s?.recordingPath) return reply.code(404).send({ error: 'no recording' });
    try {
      const raw = await readFile(castPath(s.recordingPath), 'utf8');
      const lines = raw.split('\n').slice(1); // drop the header
      let out = '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as [number, string, string];
          if (ev[1] === 'o') out += ev[2];
        } catch {
          /* skip malformed line */
        }
      }
      return reply.type('text/plain').send(out.replace(ANSI, ''));
    } catch {
      return reply.code(410).send({ error: 'recording file is gone' });
    }
  });

  app.get('/sessions/:id/commands', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const rows =
      user.role === 'admin' ? await audit.sessionCommandsAny(id) : await audit.sessionCommands(user.id, id);
    return { commands: rows.map((c) => ({ id: c.id, ts: c.ts, text: c.text, target: c.target })) };
  });

  app.get('/commands', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? '');
    const rows = user.role === 'admin' ? await audit.searchCommandsAll(q, 300) : await audit.searchCommands(user.id, q, 300);
    return { commands: rows.map((c) => ({ id: c.id, ts: c.ts, text: c.text, target: c.target, sessionId: c.sessionId })) };
  });
}
