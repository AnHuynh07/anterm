import type { Logger } from 'pino';
import type { ReachTransition } from './health/monitor.js';
import { ALERTS_KEY, type AlertConfig, type AppSettingsStore } from './settings.js';

const EMOJI: Record<string, string> = { up: '✅', down: '🔴', unknown: '⚪' };

function payload(t: Pick<ReachTransition, 'name' | 'host' | 'port' | 'status' | 'prevStatus' | 'detail' | 'latencyMs' | 'ts'>) {
  const text =
    `${EMOJI[t.status] ?? '•'} *${t.name}* (${t.host}:${t.port}) is now *${t.status.toUpperCase()}*` +
    (t.status === 'up' && t.latencyMs != null ? `  (${t.latencyMs} ms)` : '') +
    (t.detail ? `  — ${t.detail}` : '');
  // `text` renders in Slack/Mattermost/Discord; `anterm` carries the raw event for anything else.
  return JSON.stringify({ text, anterm: t });
}

export interface ConfigDrift {
  name: string;
  target: string;
  added: number;
  removed: number;
  ts: number;
}

export interface FirmwareChange {
  name: string;
  target: string;
  /** the expected firmware (baseline) */
  expected: string;
  /** what the device is actually running now */
  now: string;
  ts: number;
}

export class Alerter {
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly log: Logger,
  ) {}

  private async post(build: () => string, label: string): Promise<void> {
    const cfg = await this.settings.getJson<AlertConfig>(ALERTS_KEY);
    if (!cfg?.enabled || !cfg.webhookUrl) return;
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: build(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) this.log.warn({ status: res.status, label }, 'alert webhook returned non-2xx');
    } catch (err) {
      this.log.warn({ err: (err as Error).message, label }, 'alert webhook failed');
    }
  }

  async dispatch(t: ReachTransition): Promise<void> {
    await this.post(() => payload(t), t.name);
  }

  /** A scheduled config snapshot came back different from the last one. */
  async dispatchConfigDrift(d: ConfigDrift): Promise<void> {
    const build = () => {
      const text =
        `📝 *${d.name}* (${d.target}) config changed` +
        (d.added || d.removed ? `  (+${d.added} / −${d.removed} lines)` : '');
      return JSON.stringify({ text, anterm: { kind: 'config-drift', ...d } });
    };
    await this.post(build, d.name);
  }

  /** A web device's scraped firmware no longer matches its configured baseline. */
  async dispatchFirmwareChange(d: FirmwareChange): Promise<void> {
    const build = () =>
      JSON.stringify({
        text: `🔧 *${d.name}* (${d.target}) firmware is now *${d.now}* — expected *${d.expected}*`,
        anterm: { kind: 'firmware-change', ...d },
      });
    await this.post(build, d.name);
  }

  async test(webhookUrl: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload({
          name: 'AnTerm test alert',
          host: 'example.net',
          port: 22,
          status: 'up',
          prevStatus: 'down',
          detail: 'this is a test — your webhook works',
          latencyMs: 12,
          ts: Math.floor(Date.now() / 1000),
        }),
        signal: AbortSignal.timeout(8000),
      });
      return { ok: res.ok, detail: res.ok ? `sent (${res.status})` : `webhook returned ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
