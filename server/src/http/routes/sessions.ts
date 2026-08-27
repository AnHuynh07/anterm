import type { AppContext } from '../../context.js';
import { AuditLog } from '../../audit.js';
import { requireAuth } from '../app.js';
import type { AnyFastify } from '../types.js';

export function registerSessionRoutes(app: AnyFastify, ctx: AppContext): void {
  const audit = new AuditLog(ctx.db);

  app.get('/sessions', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const rows = await audit.list(user.id, 200);
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        target: r.target,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        clientIp: r.clientIp,
        bytesIn: r.bytesIn,
        bytesOut: r.bytesOut,
        exitReason: r.exitReason,
      })),
    };
  });
}
