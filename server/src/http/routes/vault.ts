import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { verifyPassword } from '../../auth/password.js';
import {
  applyVaultBundle,
  buildVaultBundle,
  decryptBundle,
  parseJsonBundle,
  serialiseBundle,
} from '../../vault.js';
import { auditActor, requireRole } from '../app.js';

const exportBody = z.object({
  password: z.string().min(1),
  format: z.enum(['encrypted', 'json', 'csv']),
  passphrase: z.string().optional(),
  acknowledgePlaintext: z.boolean().optional(),
});

const importBody = z.object({
  password: z.string().min(1),
  format: z.enum(['encrypted', 'json']),
  data: z.string().min(1).max(20_000_000),
  passphrase: z.string().optional(),
  mode: z.enum(['skip', 'replace']).default('skip'),
});

export function registerVaultRoutes(app: AnyFastify, ctx: AppContext): void {
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return null;
    if (!ctx.config.allowSecretExport) {
      reply.code(403).send({ error: 'secret export is disabled on this server (--allow-secret-export=false)' });
      return null;
    }
    return me;
  };

  app.post('/vault/export', async (req, reply) => {
    const me = guard(req, reply);
    if (!me) return;
    const parsed = exportBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    const { password, format, passphrase, acknowledgePlaintext } = parsed.data;

    if (!(await verifyPassword(me.passwordHash, password))) {
      return reply.code(403).send({ error: 'your password is incorrect' });
    }
    if (format === 'encrypted' && (!passphrase || passphrase.length < 8)) {
      return reply.code(400).send({ error: 'choose a passphrase of at least 8 characters for the encrypted archive' });
    }
    if ((format === 'json' || format === 'csv') && acknowledgePlaintext !== true) {
      return reply.code(400).send({ error: 'plaintext export must be explicitly acknowledged' });
    }

    const bundle = await buildVaultBundle(ctx.db, ctx.config.appSecret);
    let body: string;
    try {
      body = serialiseBundle(bundle, format, passphrase);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    ctx.activity.record({
      actor: auditActor(req),
      action: 'vault.export',
      detail: { format, connections: bundle.connections.length, credentials: bundle.credentials.length },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const ext = format === 'encrypted' ? 'anterm' : format;
    const type =
      format === 'csv' ? 'text/csv' : format === 'json' ? 'application/json' : 'application/octet-stream';
    return reply
      .header('content-disposition', `attachment; filename="anterm-vault-${stamp}.${ext}"`)
      .type(type)
      .send(body);
  });

  app.post('/vault/import', { bodyLimit: 24_000_000 }, async (req, reply) => {
    const me = guard(req, reply);
    if (!me) return;
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    const { password, format, data, passphrase, mode } = parsed.data;

    if (!(await verifyPassword(me.passwordHash, password))) {
      return reply.code(403).send({ error: 'your password is incorrect' });
    }

    let bundle;
    try {
      bundle =
        format === 'encrypted'
          ? decryptBundle(data, passphrase ?? '')
          : parseJsonBundle(data);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const summary = await applyVaultBundle(ctx.db, ctx.config.appSecret, bundle, {
      mode,
      fallbackOwnerId: me.id,
    });
    ctx.activity.record({
      actor: auditActor(req),
      action: 'vault.import',
      detail: {
        mode,
        credentials: summary.credentials,
        connections: summary.connections,
        errors: summary.errors.length,
      },
    });
    return summary;
  });

  app.get('/vault/db-backup', async (req, reply) => {
    const me = requireRole(req, reply, 'admin');
    if (!me) return;
    if (!ctx.config.allowSecretExport) {
      return reply.code(403).send({ error: 'secret export is disabled on this server' });
    }
    ctx.dbHandle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const snapshot = ctx.dbHandle.sqlite.serialize();
    ctx.activity.record({ actor: auditActor(req), action: 'vault.db_backup', detail: { bytes: snapshot.length } });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-disposition', `attachment; filename="anterm-db-${stamp}.sqlite"`)
      .type('application/octet-stream')
      .send(snapshot);
  });
}
