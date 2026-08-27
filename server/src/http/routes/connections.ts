import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { users } from '../../db/schema.js';
import { ConnectionRepo, toDto, type ConnectionDto, type ConnectionInput } from '../../connections/repo.js';
import { CredentialRepo, resolveTarget } from '../../connections/credentials.js';
import { ShareRepo } from '../../connections/shares.js';
import { connAccess, type Actor } from '../../access.js';
import { parseImport, toConnectionInput, toCsv, toPortable } from '../../connections/portable.js';
import { SshSession } from '../../ssh/client.js';
import { auditActor, requireAuth, requireWriter } from '../app.js';

const upsertBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(22),
  sshUsername: z.string().max(128).default(''),
  credentialId: z.string().uuid().nullish(),
  jumpConnectionId: z.string().uuid().nullish(),
  authType: z.enum(['password', 'key', 'agent']),
  secret: z.string().max(32_768).nullish(),
  passphrase: z.string().max(4096).nullish(),
  initCommand: z.string().max(2000).nullish(),
  loginUsername: z.string().max(128).nullish(),
  loginPassword: z.string().max(4096).nullish(),
  enablePassword: z.string().max(4096).nullish(),
  setupCommands: z.string().max(8000).nullish(),
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

const sharesBody = z.object({
  shares: z
    .array(z.object({ userId: z.string().uuid(), canEdit: z.boolean().default(false) }))
    .max(200),
});

export function registerConnectionRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);
  const creds = new CredentialRepo(ctx.db, ctx.config.appSecret);
  const shares = new ShareRepo(ctx.db);

  const usernamesByIds = async (ids: string[]): Promise<Map<string, string>> => {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await ctx.db.query.users.findMany({ where: inArray(users.id, uniq) });
    return new Map(rows.map((u) => [u.id, u.username]));
  };

  /** Load a connection + the actor's access to it, or null if invisible. */
  const loadForActor = async (actor: Actor, id: string) => {
    const conn = await repo.getAny(id);
    if (!conn) return null;
    const share = actor.role === 'admin' || conn.userId === actor.id ? null : (await shares.getFor(id, actor.id)) ?? null;
    const access = connAccess(actor, conn.userId, share);
    return access.canView ? { conn, access } : null;
  };

  /** Returns an error string if `jumpId` is not a usable bastion for connection `selfId`. */
  const validateJump = async (actor: Actor, jumpId: string | null | undefined, selfId?: string): Promise<string | null> => {
    if (!jumpId) return null;
    if (jumpId === selfId) return 'a connection cannot jump through itself';
    const j = await loadForActor(actor, jumpId);
    if (!j) return 'jump host connection not found or not visible to you';
    if (selfId) {
      const seen = new Set<string>([jumpId]);
      let hop: string | null | undefined = j.conn.jumpConnectionId;
      while (hop) {
        if (hop === selfId) return 'that would create a jump host loop';
        if (seen.has(hop)) break;
        seen.add(hop);
        hop = (await repo.getAny(hop))?.jumpConnectionId ?? null;
      }
    }
    return null;
  };

  const enrich = (dto: ConnectionDto, access: ReturnType<typeof connAccess>, ownerName?: string): ConnectionDto => ({
    ...dto,
    ownerName,
    relation: access.relation,
    canEdit: access.canEdit,
    canOpen: access.canOpen,
    canDelete: access.canDelete,
    canShare: access.canShare,
  });

  const visibleList = async (actor: Actor) => {
    const shareMap = actor.role === 'admin' ? new Map<string, boolean>() : await shares.forUser(actor.id);
    const rows = await repo.listVisible({
      userId: actor.id,
      admin: actor.role === 'admin',
      sharedIds: [...shareMap.keys()],
    });
    const names = await usernamesByIds(rows.map((r) => r.userId));
    return rows.map((c) => {
      const isOwner = c.userId === actor.id;
      const share = !isOwner && shareMap.has(c.id) ? { canEdit: shareMap.get(c.id) ?? false } : null;
      const access = connAccess(actor, c.userId, share);
      return enrich(toDto(c), access, isOwner ? undefined : names.get(c.userId));
    });
  };

  app.get('/connections', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    return { connections: await visibleList(user) };
  });

  // ---- reachability dashboard ----
  app.get('/connections/health', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const ids = (await visibleList(user)).map((c) => c.id);
    return { health: ctx.reachability.snapshot(ids) };
  });

  app.post('/connections/health/check', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const ids = (await visibleList(user)).map((c) => c.id);
    return { health: await ctx.reachability.checkByIds(ids) };
  });

  // ---- export (never includes secrets) ----
  app.get('/connections/export', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const format = (req.query as { format?: string }).format === 'csv' ? 'csv' : 'json';
    const list = await visibleList(user);
    const credById = new Map((await creds.list(user.id)).map((c) => [c.id, c.name]));
    const rows = await Promise.all(list.map((d) => repo.getAny(d.id)));
    const portable = rows
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => toPortable(c, c.credentialId ? (credById.get(c.credentialId) ?? null) : null));

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

  // ---- import (own inventory only) ----
  app.post('/connections/import', async (req, reply) => {
    const user = requireWriter(req, reply);
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
    ctx.activity.record({
      actor: auditActor(req),
      action: 'connection.import',
      detail: { created: result.created, updated: result.updated, skipped: result.skipped },
    });
    return result;
  });

  app.post('/connections', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (!hostAllowed(ctx, parsed.data.host)) return reply.code(400).send({ error: 'host not allowed by server policy' });
    const jumpErr = await validateJump(user, parsed.data.jumpConnectionId);
    if (jumpErr) return reply.code(400).send({ error: jumpErr });
    try {
      const created = await repo.create(user.id, parsed.data as ConnectionInput);
      ctx.activity.record({ actor: auditActor(req), action: 'connection.create', target: created.name });
      return reply.code(201).send({ connection: enrich(toDto(created), connAccess(user, user.id, null)) });
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.put('/connections/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = upsertBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    if (!hostAllowed(ctx, parsed.data.host)) return reply.code(400).send({ error: 'host not allowed by server policy' });

    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canEdit) return reply.code(403).send({ error: 'you do not have edit access to this connection' });
    const jumpErr = await validateJump(user, parsed.data.jumpConnectionId, id);
    if (jumpErr) return reply.code(400).send({ error: jumpErr });

    try {
      const updated = await repo.updateAny(id, parsed.data as ConnectionInput);
      if (!updated) return reply.code(404).send({ error: 'connection not found' });
      ctx.activity.record({ actor: auditActor(req), action: 'connection.update', target: updated.name });
      const names = await usernamesByIds([updated.userId]);
      return {
        connection: enrich(
          toDto(updated),
          loaded.access,
          updated.userId === user.id ? undefined : names.get(updated.userId),
        ),
      };
    } catch (err) {
      return reply.code(409).send({ error: uniqueName(err) });
    }
  });

  app.delete('/connections/:id', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canDelete) return reply.code(403).send({ error: 'only the owner or an admin can delete this connection' });
    await repo.removeAny(id);
    ctx.activity.record({ actor: auditActor(req), action: 'connection.delete', target: loaded.conn.name });
    return { ok: true };
  });

  // ---- sharing ----
  app.get('/connections/:id/shares', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canShare) return reply.code(403).send({ error: 'only the owner or an admin can manage sharing' });
    return { shares: await shares.dtos(id) };
  });

  app.put('/connections/:id/shares', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = sharesBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });

    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canShare) return reply.code(403).send({ error: 'only the owner or an admin can manage sharing' });

    const wanted = parsed.data.shares.filter((s) => s.userId !== loaded.conn.userId);
    const ids = wanted.map((s) => s.userId);
    if (ids.length) {
      const found = await ctx.db.query.users.findMany({ where: inArray(users.id, ids) });
      if (found.length !== new Set(ids).size) return reply.code(400).send({ error: 'one or more users do not exist' });
    }
    await shares.replace(id, wanted);
    ctx.activity.record({
      actor: auditActor(req),
      action: 'connection.share',
      target: loaded.conn.name,
      detail: { users: wanted.length },
    });
    return { shares: await shares.dtos(id) };
  });

  // Fire a throwaway SSH connection and report whether auth + host key check pass.
  app.post('/connections/:id/test', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canOpen) return reply.code(403).send({ error: 'you do not have access to open this connection' });
    const conn = loaded.conn;

    // credentials resolve on the owner's behalf (a shared user never sees them)
    const cred = conn.credentialId ? await creds.get(conn.userId, conn.credentialId) : undefined;
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
