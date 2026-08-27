import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { ConnectionRepo, toDto, type ConnectionInput } from '../../connections/repo.js';
import { SshSession } from '../../ssh/client.js';
import { requireAuth } from '../app.js';

const upsertBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(22),
  sshUsername: z.string().min(1).max(128),
  authType: z.enum(['password', 'key', 'agent']),
  // undefined = keep existing (on edit); '' or null = clear; string = set
  secret: z.string().max(32_768).nullish(),
  passphrase: z.string().max(4096).nullish(),
  initCommand: z.string().max(2000).nullish(),
});

export function registerConnectionRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);

  app.get('/connections', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const rows = await repo.list(user.id);
    return { connections: rows.map(toDto) };
  });

  app.post('/connections', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (!hostAllowed(ctx, parsed.data.host)) return reply.code(400).send({ error: 'host not allowed by server policy' });
    try {
      const created = await repo.create(user.id, parsed.data as ConnectionInput);
      return reply.code(201).send({ connection: toDto(created) });
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.put('/connections/:id', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (!hostAllowed(ctx, parsed.data.host)) return reply.code(400).send({ error: 'host not allowed by server policy' });
    try {
      const updated = await repo.update(user.id, id, parsed.data as ConnectionInput);
      if (!updated) return reply.code(404).send({ error: 'connection not found' });
      return { connection: toDto(updated) };
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.delete('/connections/:id', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const ok = await repo.remove(user.id, id);
    if (!ok) return reply.code(404).send({ error: 'connection not found' });
    return { ok: true };
  });

  // Fire a throwaway SSH connection and report whether auth + host key check pass.
  app.post('/connections/:id/test', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const conn = await repo.get(user.id, id);
    if (!conn) return reply.code(404).send({ error: 'connection not found' });

    const secrets = repo.resolveSecrets(conn);
    const result = await new Promise<{ ok: boolean; detail: string; fingerprint?: string }>((resolve) => {
      const ssh = new SshSession({
        host: conn.host,
        port: conn.port,
        username: conn.sshUsername,
        command: 'exit 0',
        ...secrets,
        verifyHostKey: async (info) => {
          resolve({ ok: true, detail: 'authenticated (host key not yet trusted)', fingerprint: info.fingerprint });
          return false; // abort after we learn what we need
        },
      });
      const timer = setTimeout(() => {
        ssh.close('timeout');
        resolve({ ok: false, detail: 'timed out' });
      }, 15_000);
      ssh.on('ready', () => {
        clearTimeout(timer);
        resolve({ ok: true, detail: 'connected' });
        ssh.close('test complete');
      });
      ssh.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: err.message });
      });
      ssh.connect();
    });
    return result;
  });
}

function hostAllowed(ctx: AppContext, host: string): boolean {
  const list = ctx.config.allowHosts;
  return !list.length || list.includes(host.toLowerCase());
}

function uniqueName(err: unknown): string {
  const msg = (err as Error)?.message ?? '';
  return /UNIQUE/i.test(msg) ? 'a connection with that name already exists' : 'could not save connection';
}
