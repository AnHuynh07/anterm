import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';

export function registerHealthRoutes(app: AnyFastify, ctx: AppContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    adhoc: ctx.config.adhocEnabled,
    secretExport: ctx.config.allowSecretExport,
    telnet: ctx.config.allowTelnet,
    webProxy: ctx.config.allowWebProxy,
  }));

  // Plain liveness probe outside the /api namespace-friendly shape
  app.get('/healthz', async () => 'ok');
}
