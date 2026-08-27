import { createConnection } from 'node:net';
import type { Logger } from 'pino';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections } from '../db/schema.js';

export type ReachStatus = 'up' | 'down' | 'unknown';

export interface ReachResult {
  status: ReachStatus;
  checkedAt: number;
  latencyMs: number | null;
  detail: string | null;
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

/**
 * Periodically TCP-probes every saved connection's host:port and keeps the
 * latest result in memory. Powers the reachability dashboard.
 */
export class ReachabilityMonitor {
  private results = new Map<string, ReachResult>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly allowHosts: string[],
    private readonly intervalMs = 60_000,
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
    await this.runBatch(rows.map((r) => ({ id: r.id, host: r.host, port: r.port })));
  }

  /** Check just one user's connections and return the fresh results. */
  async checkUser(userId: string): Promise<Record<string, ReachResult>> {
    const rows = await this.db.select().from(connections).where(eq(connections.userId, userId));
    await this.runBatch(rows.map((r) => ({ id: r.id, host: r.host, port: r.port })));
    return this.snapshot(rows.map((r) => r.id));
  }

  /** Re-check a specific set of connections (by id) and return fresh results. */
  async checkByIds(ids: string[]): Promise<Record<string, ReachResult>> {
    if (!ids.length) return {};
    const rows = await this.db.select().from(connections).where(inArray(connections.id, ids));
    await this.runBatch(rows.map((r) => ({ id: r.id, host: r.host, port: r.port })));
    return this.snapshot(ids);
  }

  private async runBatch(targets: { id: string; host: string; port: number }[]): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < targets.length) {
        const t = targets[i++]!;
        if (!this.allowed(t.host)) {
          this.results.set(t.id, {
            status: 'unknown',
            checkedAt: Math.floor(Date.now() / 1000),
            latencyMs: null,
            detail: 'host not in allowlist',
          });
          continue;
        }
        try {
          this.results.set(t.id, await probe(t.host, t.port));
        } catch (err) {
          this.log.debug({ err, host: t.host }, 'probe failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  }
}
