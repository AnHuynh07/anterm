import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { ConnectionRepo, toDto, type ConnectionInput } from '../../connections/repo.js';
import { CredentialRepo, resolveTarget } from '../../connections/credentials.js';
import { parseImport, toConnectionInput, toCsv, toPortable } from '../../connections/portable.js';
import { SshSession } from '../../ssh/client.js';
import { requireAuth } from '../app.js';

const upsertBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(22),
  sshUsername: z.string().max(128).default(''),
  credentialId: z.string().uuid().nullish(),
  authType: z.enum(['password', 'key', 'agent']),
  // undefined = keep existing (on edit); '' or null = clear; string = set
  secret: z.string().max(32_768).nullish(),
  passphrase: z.string().max(4096).nullish(),
  initCommand: z.string().max(2000).nullish(),
  // in-band login automation (network devices)
  loginUsername: z.string().max(128).nullish(),
  loginPassword: z.string().max(4096).nullish(),
  enablePassword: z.string().max(4096).nullish(),
  setupCommands: z.string().max(8000).nullish(),
  // organisation
  groupName: z.string().max(80).nullish(),
  tags: z.string().max(500).nullish(),
  color: z.enum(['red', 'amber', 'green', 'blue', 'violet']).nullish(),
  antiIdleSeconds: z.number().int().min(0).max(3600).nullish(),
});

const importBody = z.object({
  format: z.enum(['json', 'csv']),
  data: z.string().min(1).max(2_000_000),
  mode: z.enum(['skip', 'replace']).default('skip'),
});

export function registerConnectionRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);
  const creds = new CredentialRepo(ctx.db, ctx.config.appSecret);

  app.get('/connections', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const rows = await repo.list(user.id);
    return { connections: rows.map(toDto) };
  });

  // ---- export (never includes secrets) ----
  app.get('/connections/export', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const format = (req.query as { format?: string }).format === 'csv' ? 'csv' : 'json';
    const rows = await repo.list(user.id);
    const credById = new Map((await creds.list(user.id)).map((c) => [c.id, c.name]));
    const portable = rows.map((c) => toPortable(c, c.credentialId ? (credById.get(c.credentialId) ?? null) : null));

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      return reply
        .header('content-disposition', `attachment; filename="anterm-connections-${stamp}.csv"`)
        .type('text/csv')
        .send(toCsv(portable));
    }
    return reply
      .header('content-disposition', `attachment; filename="anterm-connections-${stamp}.json"`)
      .type('application/json')
      .send(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), connections: portable }, null, 2));
  });

  // ---- import ----
  app.post('/connections/import', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });

    let entries;
    try {
      entries = parseImport(parsed.data.format, parsed.data.data);
    } catch (err) {
      return reply.code(400).send({ error: `could not parse ${parsed.data.format}: ${(err as Error).message}` });
    }

    const credByName = new Map((await creds.list(user.id)).map((c) => [c.name.toLowerCase(), c.id]));
    const existing = new Map((await repo.list(user.id)).map((c) => [c.name.toLowerCase(), c.id]));
    const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[], needsCredentials: [] as string[] };

    for (const p of entries) {
      if (!p.name || !p.host) {
        result.errors.push(`skipped a row with no name/host`);
        continue;
      }
      if (!hostAllowed(ctx, p.host)) {
        result.errors.push(`${p.name}: host not allowed by server policy`);
        continue;
      }
      let credentialId: string | null = null;
      if (p.credential) {
        credentialId = credByName.get(p.credential.toLowerCase()) ?? null;
        if (!credentialId && !result.needsCredentials.includes(p.credential)) result.needsCredentials.push(p.credential);
      }
      const input = toConnectionInput(p, credentialId);
      const existingId = existing.get(p.name.toLowerCase());
      try {
        if (existingId) {
          if (parsed.data.mode !== 'replace') {
            result.skipped++;
            continue;
          }
          await repo.update(user.id, existingId, input);
          result.updated++;
        } else {
          const c = await repo.create(user.id, input);
          existing.set(p.name.toLowerCase(), c.id);
          result.created++;
        }
      } catch (err) {
        result.errors.push(`${p.name}: ${(err as Error).message}`);
      }
    }
    return result;
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

    const cred = conn.credentialId ? await creds.get(user.id, conn.credentialId) : undefined;
    const resolved = resolveTarget(conn, cred ?? null, ctx.config.appSecret);
    const username = conn.sshUsername || resolved.credSshUsername || '';
    if (!username) return { ok: false, detail: 'no SSH username configured' };

    const result = await new Promise<{ ok: boolean; detail: string; fingerprint?: string }>((resolve) => {
      const ssh = new SshSession({
        host: conn.host,
        port: conn.port,
        username,
        command: 'exit 0',
        password: resolved.password,
        privateKey: resolved.privateKey,
        passphrase: resolved.passphrase,
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
