import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, reachabilityEvents, type ReachabilityEvent } from '../db/schema.js';

export type ReachStatus = 'up' | 'down' | 'unknown';

export interface ReachResult {
  status: ReachStatus;
  checkedAt: number;
  latencyMs: number | null;
  detail: string | null;
}

export interface ReachTransition {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  status: ReachStatus;
  prevStatus: ReachStatus;
  latencyMs: number | null;
  detail: string | null;
  ts: number;
}

const TIMEOUT_MS = 5000;
const CONCURRENCY = 12;

/** A single TCP-connect probe of host:port. */
export function probe(host: string, port: number): Promise<ReachResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (r: Omit<ReachResult, 'checkedAt'>) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...r, checkedAt: Math.floor(Date.now() / 1000) });
    };
    const socket = createConnection({ host, port, timeout: TIMEOUT_MS });
    socket.once('connect', () => finish({ status: 'up', latencyMs: Date.now() - start, detail: null }));
    socket.once('timeout', () => finish({ status: 'down', latencyMs: null, detail: 'timed out' }));
    socket.once('error', (err) => finish({ status: 'down', latencyMs: null, detail: (err as Error).message }));
  });
}

interface Target {
  id: string;
  name: string;
  host: string;
  port: number;
}

/**
 * Periodically TCP-probes every saved connection and keeps the latest result in
 * memory. A confirmed up⇄down transition (seen `threshold` sweeps in a row) is
 * written to `reachability_events` and handed to `onTransition` for alerting.
 */
export class ReachabilityMonitor {
  private results = new Map<string, ReachResult>();
  private timer: NodeJS.Timeout | null = null;
  private confirmed = new Map<string, ReachStatus>();
  private pending = new Map<string, { status: ReachStatus; count: number }>();
  onTransition: ((t: ReachTransition) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly allowHosts: string[],
    private readonly intervalMs = 60_000,
    private readonly threshold = 2,
  ) {}

  start(): void {
    void this.sweepAll();
    this.timer = setInterval(() => void this.sweepAll().catch(() => {}), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(ids: string[]): Record<string, ReachResult> {
    const out: Record<string, ReachResult> = {};
    for (const id of ids) {
      out[id] = this.results.get(id) ?? { status: 'unknown', checkedAt: 0, latencyMs: null, detail: null };
    }
    return out;
  }

  private allowed(host: string): boolean {
    return !this.allowHosts.length || this.allowHosts.includes(host.toLowerCase());
  }

  async sweepAll(): Promise<void> {
    const rows = await this.db.select().from(connections);
    await this.runBatch(rows.map((r) => ({ id: r.id, name: r.name, host: r.host, port: r.port })));
  }

  /** Check just one user's connections and return the fresh results. */
  async checkUser(userId: string): Promise<Record<string, ReachResult>> {
    const rows = await this.db.select().from(connections).where(eq(connections.userId, userId));
    await this.runBatch(rows.map((r) => ({ id: r.id, name: r.name, host: r.host, port: r.port })));
    return this.snapshot(rows.map((r) => r.id));
  }

  async checkByIds(ids: string[]): Promise<Record<string, ReachResult>> {
    if (!ids.length) return {};
    const rows = await this.db.select().from(connections).where(inArray(connections.id, ids));
    await this.runBatch(rows.map((r) => ({ id: r.id, name: r.name, host: r.host, port: r.port })));
    return this.snapshot(ids);
  }

  recentEvents(limit = 50): Promise<ReachabilityEvent[]> {
    return this.db.query.reachabilityEvents.findMany({
      orderBy: [desc(reachabilityEvents.ts)],
      limit: Math.min(Math.max(limit, 1), 500),
    });
  }

  eventsForConnection(connectionId: string, limit = 100): Promise<ReachabilityEvent[]> {
    return this.db.query.reachabilityEvents.findMany({
      where: eq(reachabilityEvents.connectionId, connectionId),
      orderBy: [desc(reachabilityEvents.ts)],
      limit: Math.min(Math.max(limit, 1), 500),
    });
  }

  private async runBatch(targets: Target[]): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < targets.length) {
        const t = targets[i++]!;
        let res: ReachResult;
        if (!this.allowed(t.host)) {
          res = { status: 'unknown', checkedAt: Math.floor(Date.now() / 1000), latencyMs: null, detail: 'host not in allowlist' };
        } else {
          try {
            res = await probe(t.host, t.port);
          } catch (err) {
            this.log.debug({ err, host: t.host }, 'probe failed');
            continue;
          }
        }
        this.results.set(t.id, res);
        this.evaluate(t, res);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  }

  private evaluate(t: Target, res: ReachResult): void {
    const cur = res.status;
    const prev = this.confirmed.get(t.id);
    if (prev === undefined) {
      // first ever observation — establish a baseline, don't alert
      this.confirmed.set(t.id, cur);
      return;
    }
    if (cur === prev) {
      this.pending.delete(t.id);
      return;
    }
    const p = this.pending.get(t.id);
    if (p?.status === cur) p.count += 1;
    else this.pending.set(t.id, { status: cur, count: 1 });

    if ((this.pending.get(t.id)?.count ?? 0) < this.threshold) return;
    this.pending.delete(t.id);
    this.confirmed.set(t.id, cur);

    // only alert on up⇄down; 'unknown' (allowlist / never-probed) is noise
    if (cur === 'unknown' || prev === 'unknown') return;

    const ev: ReachTransition = {
      connectionId: t.id,
      name: t.name,
      host: t.host,
      port: t.port,
      status: cur,
      prevStatus: prev,
      latencyMs: res.latencyMs,
      detail: res.detail,
      ts: Math.floor(Date.now() / 1000),
    };
    void this.db
      .insert(reachabilityEvents)
      .values({
        id: randomUUID(),
        connectionId: t.id,
        status: cur,
        prevStatus: prev,
        latencyMs: res.latencyMs,
        detail: res.detail,
      })
      .catch((err) => this.log.warn({ err }, 'reachability event write failed'));
    try {
      this.onTransition?.(ev);
    } catch (err) {
      this.log.warn({ err }, 'reachability onTransition handler threw');
    }
  }
}
