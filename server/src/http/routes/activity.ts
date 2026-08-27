import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { activityToCsv } from '../../activity.js';
import { requireRole } from '../app.js';

export function registerActivityRoutes(app: AnyFastify, ctx: AppContext): void {
  const parseQuery = (q: Record<string, unknown>) => ({
    action: typeof q.action === 'string' && q.action ? q.action : undefined,
    actorId: typeof q.actorId === 'string' && q.actorId ? q.actorId : undefined,
    from: q.from ? Number(q.from) || undefined : undefined,
    to: q.to ? Number(q.to) || undefined : undefined,
    limit: q.limit ? Number(q.limit) || undefined : undefined,
  });

  app.get('/activity', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const rows = await ctx.activity.list(parseQuery(req.query as Record<string, unknown>));
    return {
      events: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        actor: r.actorName ?? r.actorId ?? null,
        action: r.action,
        target: r.target,
        detail: r.detail ? safeParse(r.detail) : null,
        ip: r.ip,
      })),
    };
  });

  app.get('/activity.csv', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    const rows = await ctx.activity.list({ ...parseQuery(req.query as Record<string, unknown>), limit: 2000 });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="anterm-activity-${stamp}.csv"`)
      .type('text/csv')
      .send(activityToCsv(rows));
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
