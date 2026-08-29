import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { connections, type Connection } from '../db/schema.js';
import { ConnectionRepo } from '../connections/repo.js';
import { SnapshotRepo } from '../config/snapshots.js';
import { configDiff, diffStats } from '../config/diff.js';
import { fetchWebConfig } from './configFetch.js';
import { fetchWebFacts } from './facts.js';

/**
 * Periodically polls every web-managed device:
 *  - snapshots its config (`settings.configUrl`) and fires a drift alert when it
 *    changes from the previous snapshot;
 *  - scrapes its firmware (`settings.factsUrl`) and fires an alert when it no
 *    longer matches `settings.firmwareBaseline` (once per distinct version).
 * Both alerts go through the same webhook as reachability alerting.
 */
export class WebDeviceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const min = this.ctx.config.webConfigSnapshotMin;
    if (min <= 0) return;
    const ms = Math.max(min, 5) * 60_000;
    this.timer = setInterval(() => void this.sweep().catch(() => {}), ms);
    this.timer.unref?.();
    this.ctx.log.info({ everyMin: min }, 'web device scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const repo = new ConnectionRepo(this.ctx.db, this.ctx.config.appSecret);
      const rows = await this.ctx.db.select().from(connections).where(eq(connections.protocol, 'http'));
      for (const conn of rows) {
        const web = repo.resolveWebTarget(conn);
        if (!web) continue;
        if (web.configUrl) await this.snapshotConfig(conn).catch(() => {});
        if (web.factsUrl && web.firmwareBaseline) await this.checkFirmware(conn, web.firmwareBaseline).catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }

  private async snapshotConfig(conn: Connection): Promise<void> {
    const snaps = new SnapshotRepo(this.ctx.db);
    try {
      const prev = await snaps.latest(conn.id);
      const { content } = await fetchWebConfig(this.ctx, conn);
      const { snapshot, changed } = await snaps.create({ connectionId: conn.id, reason: 'auto', content });
      if (changed && prev) {
        const { added, removed } = diffStats(configDiff(prev.content, snapshot.content));
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

  private async checkFirmware(conn: Connection, baseline: string): Promise<void> {
    const key = `webfacts:fw-alerted:${conn.id}`;
    try {
      const { firmware } = await fetchWebFacts(this.ctx, conn);
      if (!firmware) return;
      if (firmware === baseline) {
        await this.ctx.settings.set(key, ''); // back on baseline — re-arm the alert
        return;
      }
      if ((await this.ctx.settings.get(key)) === firmware) return; // already alerted for this version
      this.ctx.log.info({ name: conn.name, firmware, baseline }, 'web device firmware off baseline');
      await this.ctx.alerter.dispatchFirmwareChange({
        name: conn.name,
        target: conn.host,
        expected: baseline,
        now: firmware,
        ts: Math.floor(Date.now() / 1000),
      });
      await this.ctx.settings.set(key, firmware);
    } catch (err) {
      this.ctx.log.info({ name: conn.name, err: (err as Error).message }, 'scheduled firmware check failed');
    }
  }
}
