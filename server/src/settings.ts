import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { appSettings } from './db/schema.js';

/** Tiny key-value store for admin-editable runtime settings. */
export class AppSettingsStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.key, key) });
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: Math.floor(Date.now() / 1000) } });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): Promise<void> {
    return this.set(key, JSON.stringify(value));
  }
}

export interface AlertConfig {
  enabled: boolean;
  webhookUrl: string;
}
export const ALERTS_KEY = 'alerts';
