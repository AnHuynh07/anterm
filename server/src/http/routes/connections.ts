import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AnyFastify } from '../types.js';
import { hostKeys, users } from '../../db/schema.js';
import { AuditLog } from '../../audit.js';
import { ConnectionRepo, toDto, type ConnectionDto, type ConnectionInput } from '../../connections/repo.js';
import { CredentialRepo, resolveTarget } from '../../connections/credentials.js';
import { ShareRepo } from '../../connections/shares.js';
import { connAccess, type Actor } from '../../access.js';
import { parseImport, toConnectionInput, toCsv, toPortable } from '../../connections/portable.js';
import { SshSession } from '../../ssh/client.js';
import { runCommand, runFanout } from '../../ssh/runner.js';
import { SnapshotRepo, toSnapshotDto } from '../../config/snapshots.js';
import { configDiff, diffStats } from '../../config/diff.js';
import { auditActor, requireAuth, requireWriter } from '../app.js';

const webSettingsBody = z.object({
  url: z.string().url().max(2048),
  authMode: z.enum(['form', 'basic', 'none']).default('form'),
  username: z.string().max(128).nullish(),
  password: z.string().max(1024).optional(), // omitted = keep
  insecureTls: z.boolean().optional(),
  loginPath: z.string().max(512).nullish(),
  userField: z.string().max(64).nullish(),
  passField: z.string().max(64).nullish(),
});

const upsertBody = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535).default(22),
  protocol: z.enum(['ssh', 'telnet', 'http']).nullish(),
  settings: webSettingsBody.nullish(),
  sshUsername: z.string().max(128).default(''),
  credentialId: z.string().uuid().nullish(),
  jumpConnectionId: z.string().uuid().nullish(),
  authType: z.enum(['password', 'key', 'agent']),
  secret: z.string().max(32_768).nullish(),
  passphrase: z.string().max(4096).nullish(),
  initCommand: z.string().max(2000).nullish(),
  configCommand: z.string().max(2000).nullish(),
  loginUsername: z.string().max(128).nullish(),
  loginPassword: z.string().max(4096).nullish(),
  enablePassword: z.string().max(4096).nullish(),
  setupCommands: z.string().max(8000).nullish(),
  runbook: z.string().max(20_000).nullish(),
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

const bulkRunBody = z.object({
  connectionIds: z.array(z.string().uuid()).min(1).max(100),
  command: z.string().min(1).max(4000),
});

export function registerConnectionRoutes(app: AnyFastify, ctx: AppContext): void {
  const repo = new ConnectionRepo(ctx.db, ctx.config.appSecret);
  const creds = new CredentialRepo(ctx.db, ctx.config.appSecret);
  const shares = new ShareRepo(ctx.db);
  const audit = new AuditLog(ctx.db);
  const snaps = new SnapshotRepo(ctx.db);

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

  // recent up/down transitions across the caller's visible connections
  app.get('/connections/health/events', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const visible = new Map((await visibleList(user)).map((c) => [c.id, c.name]));
    const limit = Number((req.query as { limit?: string }).limit) || 60;
    const rows = (await ctx.reachability.recentEvents(300)).filter((e) => visible.has(e.connectionId)).slice(0, limit);
    return {
      events: rows.map((e) => ({
        id: e.id,
        connectionId: e.connectionId,
        name: visible.get(e.connectionId) ?? '(removed)',
        ts: e.ts,
        status: e.status,
        prevStatus: e.prevStatus,
        latencyMs: e.latencyMs,
        detail: e.detail,
      })),
    };
  });

  app.get('/connections/:id/health/history', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await loadForActor(user, id))) return reply.code(404).send({ error: 'connection not found' });
    const rows = await ctx.reachability.eventsForConnection(id, 200);
    return {
      events: rows.map((e) => ({
        id: e.id,
        ts: e.ts,
        status: e.status,
        prevStatus: e.prevStatus,
        latencyMs: e.latencyMs,
        detail: e.detail,
      })),
    };
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

  // web-managed device: reveal the stored credentials for "open in a new tab"
  app.get('/connections/:id/web', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (loaded.conn.protocol !== 'http') return reply.code(400).send({ error: 'not a web device' });
    if (!loaded.access.canOpen) return reply.code(403).send({ error: 'you do not have access to this device' });
    const web = repo.resolveWebTarget(loaded.conn);
    if (!web) return reply.code(400).send({ error: 'web device settings are incomplete' });
    ctx.activity.record({ actor: auditActor(req), action: 'webdevice.reveal', target: web.url });
    return { url: web.url, username: web.username, password: web.password, authMode: web.authMode };
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

  // ---- bulk: run one command on many devices ----
  app.post('/connections/bulk-run', { bodyLimit: 200_000 }, async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const parsed = bulkRunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    const { command } = parsed.data;

    type Row = {
      connectionId: string;
      name: string;
      target: string;
      ok: boolean;
      output: string;
      error?: string;
      durationMs: number;
    };
    const results: Row[] = [];

    await runFanout(
      parsed.data.connectionIds,
      async (cid) => {
        const loaded = await loadForActor(user, cid);
        if (!loaded) {
          results.push({ connectionId: cid, name: cid, target: cid, ok: false, output: '', error: 'not found', durationMs: 0 });
          return;
        }
        const conn = loaded.conn;
        const base = { connectionId: cid, name: conn.name, target: `${conn.sshUsername}@${conn.host}:${conn.port}` };
        if (!loaded.access.canOpen) {
          results.push({ ...base, ok: false, output: '', error: 'no access', durationMs: 0 });
          return;
        }
        if (conn.jumpConnectionId) {
          results.push({ ...base, ok: false, output: '', error: 'jump-host connections are not supported in bulk run yet', durationMs: 0 });
          return;
        }
        if (conn.protocol === 'telnet') {
          results.push({ ...base, ok: false, output: '', error: 'bulk run is SSH-only (Telnet has no exec channel)', durationMs: 0 });
          return;
        }
        const known = await ctx.db.query.hostKeys.findFirst({
          where: eq(hostKeys.hostport, `${conn.host.toLowerCase()}:${conn.port}`),
        });
        if (!known) {
          results.push({ ...base, ok: false, output: '', error: 'host key not trusted yet — open this device once first', durationMs: 0 });
          return;
        }
        const cred = conn.credentialId ? await creds.get(conn.userId, conn.credentialId) : undefined;
        const resolved = resolveTarget(conn, cred ?? null, ctx.config.appSecret);
        const username = conn.sshUsername || resolved.credSshUsername || '';
        if (!username) {
          results.push({ ...base, ok: false, output: '', error: 'no SSH username', durationMs: 0 });
          return;
        }

        const res = await runCommand({
          host: conn.host,
          port: conn.port,
          username,
          password: resolved.password,
          privateKey: resolved.privateKey,
          passphrase: resolved.passphrase,
          autoLogin: resolved.autoLogin,
          command,
          verifyHostKey: async (info) => info.fingerprint === known.fingerprintSha256,
        });
        results.push({ ...base, ...res });

        // thread it through the normal audit + command log
        try {
          const sid = await audit.open({ userId: user.id, connectionId: conn.id, target: base.target, clientIp: req.ip });
          await audit.logCommands({ sessionId: sid, userId: user.id, target: base.target, texts: [command] });
          await audit.close(sid, {
            bytesIn: command.length,
            bytesOut: res.output.length,
            exitReason: res.ok ? 'bulk run' : (res.error ?? 'bulk run failed'),
            commandCount: 1,
          });
        } catch {
          /* audit is best-effort */
        }
      },
      6,
    );

    const okCount = results.filter((r) => r.ok).length;
    ctx.activity.record({
      actor: auditActor(req),
      action: 'connection.bulk_run',
      detail: { command: command.slice(0, 200), targets: results.length, ok: okCount, failed: results.length - okCount },
    });
    // keep the response order stable = request order
    const byId = new Map(results.map((r) => [r.connectionId, r]));
    return { results: parsed.data.connectionIds.map((id) => byId.get(id)).filter(Boolean) };
  });

  // ---- config snapshots + diff ----
  app.post('/connections/:id/config-snapshot', async (req, reply) => {
    const user = requireWriter(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    if (!loaded.access.canOpen) return reply.code(403).send({ error: 'you do not have access to this connection' });
    const conn = loaded.conn;
    if (conn.jumpConnectionId) return reply.code(400).send({ error: 'config snapshots via a jump host are not supported yet' });
    if (conn.protocol === 'telnet') return reply.code(400).send({ error: 'config snapshots are SSH-only' });

    const known = await ctx.db.query.hostKeys.findFirst({
      where: eq(hostKeys.hostport, `${conn.host.toLowerCase()}:${conn.port}`),
    });
    if (!known) return reply.code(400).send({ error: 'host key not trusted yet — open this device once first' });

    const cred = conn.credentialId ? await creds.get(conn.userId, conn.credentialId) : undefined;
    const resolved = resolveTarget(conn, cred ?? null, ctx.config.appSecret);
    const username = conn.sshUsername || resolved.credSshUsername || '';
    const res = await runCommand({
      host: conn.host,
      port: conn.port,
      username,
      password: resolved.password,
      privateKey: resolved.privateKey,
      passphrase: resolved.passphrase,
      autoLogin: resolved.autoLogin,
      command: conn.configCommand || 'show running-config',
      idleMs: 2800,
      maxMs: 45_000,
      verifyHostKey: async (info) => info.fingerprint === known.fingerprintSha256,
    });
    if (!res.ok || !res.output.trim()) {
      return reply.code(502).send({ error: res.error ?? 'the device returned no config output' });
    }
    const { snapshot, changed } = await snaps.create({
      connectionId: conn.id,
      userId: user.id,
      reason: 'manual',
      content: res.output,
    });
    ctx.activity.record({
      actor: auditActor(req),
      action: 'connection.config_snapshot',
      target: conn.name,
      detail: { reason: 'manual', changed, lines: snapshot.lines },
    });
    return { id: snapshot.id, capturedAt: snapshot.capturedAt, lines: snapshot.lines, changed };
  });

  app.get('/connections/:id/config-snapshots', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const loaded = await loadForActor(user, id);
    if (!loaded) return reply.code(404).send({ error: 'connection not found' });
    const rows = await snaps.list(id, 200);
    const names = await usernamesByIds(rows.map((r) => r.userId).filter((u): u is string => Boolean(u)));
    return {
      snapshots: rows.map((s) => ({ ...toSnapshotDto(s), user: s.userId ? (names.get(s.userId) ?? null) : null })),
      configCommand: loaded.conn.configCommand || 'show running-config',
    };
  });

  app.get('/connections/:id/config-snapshots/:snapId', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id, snapId } = req.params as { id: string; snapId: string };
    if (!(await loadForActor(user, id))) return reply.code(404).send({ error: 'connection not found' });
    const s = await snaps.get(id, snapId);
    if (!s) return reply.code(404).send({ error: 'snapshot not found' });
    return { id: s.id, capturedAt: s.capturedAt, lines: s.lines, content: s.content };
  });

  app.get('/connections/:id/config-diff', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await loadForActor(user, id))) return reply.code(404).send({ error: 'connection not found' });
    const q = req.query as { a?: string; b?: string };
    if (!q.b) return reply.code(400).send({ error: 'b (newer snapshot id) is required' });
    const b = await snaps.get(id, q.b);
    if (!b) return reply.code(404).send({ error: 'snapshot not found' });
    const a = q.a ? await snaps.get(id, q.a) : await snaps.previous(id, b.capturedAt);
    const lines = configDiff(a?.content ?? '', b.content);
    return {
      lines,
      ...diffStats(lines),
      a: a ? { id: a.id, capturedAt: a.capturedAt } : null,
      b: { id: b.id, capturedAt: b.capturedAt },
    };
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
