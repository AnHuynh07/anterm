import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { ALERTS_KEY, type AlertConfig } from '../../settings.js';
import { auditActor, requireRole } from '../app.js';

const alertsBody = z.object({
  enabled: z.boolean(),
  webhookUrl: z.string().trim().max(2000),
});
const testBody = z.object({ webhookUrl: z.string().url().max(2000) });

export function registerSettingsRoutes(app: AnyFastify, ctx: AppContext): void {
  app.get('/settings/alerts', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;
    const cfg = (await ctx.settings.getJson<AlertConfig>(ALERTS_KEY)) ?? { enabled: false, webhookUrl: '' };
    return { enabled: cfg.enabled, webhookUrl: cfg.webhookUrl };
  });

  app.put('/settings/alerts', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;
    const parsed = alertsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (parsed.data.enabled && !/^https?:\/\//i.test(parsed.data.webhookUrl)) {
      return reply.code(400).send({ error: 'enter a valid https:// webhook URL to enable alerts' });
    }
    await ctx.settings.setJson(ALERTS_KEY, parsed.data);
    ctx.activity.record({
      actor: auditActor(req),
      action: 'settings.alerts_updated',
      detail: { enabled: parsed.data.enabled, hasWebhook: Boolean(parsed.data.webhookUrl) },
    });
    return { ok: true };
  });

  app.post('/settings/alerts/test', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;
    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'enter a valid URL first' });
    return ctx.alerter.test(parsed.data.webhookUrl);
  });
}
