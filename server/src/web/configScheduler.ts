import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { connections } from '../db/schema.js';
import { SnapshotRepo } from '../config/snapshots.js';
import { configDiff, diffStats } from '../config/diff.js';
import { fetchWebConfig } from './configFetch.js';

/**
 * Periodically snapshots every web-managed device that has a config-backup URL.
 * A snapshot that differs from the previous one fires a config-drift alert
 * through the same webhook as reachability alerting.
 */
export class WebConfigScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const min = this.ctx.config.webConfigSnapshotMin;
    if (min <= 0) return;
    const ms = Math.max(min, 5) * 60_000;
    this.timer = setInterval(() => void this.sweep().catch(() => {}), ms);
    this.timer.unref?.();
    this.ctx.log.info({ everyMin: min }, 'web config snapshot scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snaps = new SnapshotRepo(this.ctx.db);
      const rows = await this.ctx.db.select().from(connections).where(eq(connections.protocol, 'http'));
      for (const conn of rows) {
        let hasUrl = false;
        try {
          hasUrl = Boolean((JSON.parse(conn.settings ?? 'null') as { configUrl?: string } | null)?.configUrl);
        } catch {
          /* ignore */
        }
        if (!hasUrl) continue;

        try {
          const prev = await snaps.latest(conn.id);
          const { content } = await fetchWebConfig(this.ctx, conn);
          const { snapshot, changed } = await snaps.create({ connectionId: conn.id, reason: 'auto', content });
          if (changed && prev) {
            const lines = configDiff(prev.content, snapshot.content);
            const { added, removed } = diffStats(lines);
            this.ctx.log.info({ name: conn.name, added, removed }, 'web device config drift');
            await this.ctx.alerter.dispatchConfigDrift({
              name: conn.name,
              target: conn.host,
              added,
              removed,
              ts: snapshot.capturedAt,
            });
          }
        } catch (err) {
          this.ctx.log.info({ name: conn.name, err: (err as Error).message }, 'scheduled config snapshot failed');
        }
      }
    } finally {
      this.running = false;
    }
  }
}
