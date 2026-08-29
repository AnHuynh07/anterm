import type { AppContext } from '../context.js';
import { ConnectionRepo } from '../connections/repo.js';
import type { Connection } from '../db/schema.js';
import { authedGet } from './session.js';

export interface WebFact {
  label: string;
  value: string;
}

export interface WebFactsResult {
  facts: WebFact[];
  fetchedAt: number;
  /** the value of the fact whose label looks like a firmware/software version, if any */
  firmware: string | null;
}

/**
 * Built-in scrape rules aimed at the "System Information" / "About" page of
 * Allied Telesis GS/FS-series web GUIs. Used when a device has no custom
 * `factsRules`. Each entry is [label, regex]; capture group 1 (or the whole
 * match) becomes the value.
 */
const DEFAULT_RULES: Array<[string, RegExp]> = [
  ['Model', /\b(AT-[A-Za-z0-9/+.-]{3,})\b/],
  [
    'Firmware',
    /(?:Firmware|Software|Runtime|Application|Boot[\s-]*Loader)[\sA-Za-z]*?(?:Version|Ver\.?)?\s*[:=]?\s*v?([0-9][0-9A-Za-z._-]{1,30})/i,
  ],
  ['MAC address', /\b((?:[0-9A-Fa-f]{2}[:.-]){5}[0-9A-Fa-f]{2})\b/],
  ['Serial', /(?:Serial(?:\s*(?:Number|No\.?))?)\s*[:=]?\s*([A-Za-z0-9-]{5,30})/i],
  ['Uptime', /(?:System\s*Up\s*Time|Up\s*Time|Uptime)\s*[:=]?\s*([0-9][^\n<]{1,50}?(?:days?|hours?|hrs?|minutes?|mins?|sec|:\d\d))/i],
  ['IP address', /(?:IP\s*Address)\s*[:=]?\s*((?:\d{1,3}\.){3}\d{1,3})/i],
];

/** Rough HTML -> text so a label and its value stay on the same line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' ') // keep "label value" on one line
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|div|p|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Parse the user's `Label = regex` rules (one per line; `#` comments allowed). */
export function parseFactsRules(raw: string | null | undefined): Array<[string, RegExp]> {
  if (!raw) return [];
  const out: Array<[string, RegExp]> = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const label = t.slice(0, eq).trim();
    const pattern = t.slice(eq + 1).trim();
    if (!label || !pattern) continue;
    try {
      out.push([label, new RegExp(pattern, 'i')]);
    } catch {
      // a bad rule shouldn't sink the whole scrape
    }
  }
  return out;
}

function runRules(text: string, rules: Array<[string, RegExp]>): WebFact[] {
  const facts: WebFact[] = [];
  const seen = new Set<string>();
  for (const [label, re] of rules) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    const m = re.exec(text);
    const value = (m?.[1] ?? m?.[0] ?? '').trim();
    if (value) {
      facts.push({ label, value: value.slice(0, 200) });
      seen.add(key);
    }
  }
  return facts;
}

const FIRMWARE_LABEL = /firm|soft|runtime|version/i;

/**
 * Scrape read-only facts (model, firmware, uptime, ...) from a web-managed
 * device's status page (`settings.factsUrl`) through the owning user's
 * authenticated proxy session. Purely a GET + regex - never writes to the device.
 */
export async function fetchWebFacts(ctx: AppContext, conn: Connection): Promise<WebFactsResult> {
  const web = new ConnectionRepo(ctx.db, ctx.config.appSecret).resolveWebTarget(conn);
  if (!web) throw new Error('web device settings are incomplete');
  if (!web.factsUrl) throw new Error('no device-info URL set for this device');

  const { res } = await authedGet(ctx, conn, web.factsUrl, 'AnTerm-facts');
  if (res.status >= 400 || res.body.length === 0) {
    throw new Error(`the device returned HTTP ${res.status} for the device-info URL`);
  }

  const raw = res.body.toString('utf8');
  const text = htmlToText(raw);
  const rules = parseFactsRules(web.factsRules);
  const facts = runRules(`${text}\n${raw}`, rules.length ? rules : DEFAULT_RULES);
  const firmware = facts.find((f) => FIRMWARE_LABEL.test(f.label))?.value ?? null;

  return { facts, fetchedAt: Math.floor(Date.now() / 1000), firmware };
}
