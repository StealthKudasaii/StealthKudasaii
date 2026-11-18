import { db } from '../db';
import { getSetting } from './settings';
import type { CategoryKey, ChannelKey, RoleKey } from '../config/layout';

/** Éléments Discord créés/reconnus par /setup, indexés par clé stable. */
export type ResourceKind = 'role' | 'category' | 'channel';

export interface ManagedResource {
  key: string;
  kind: ResourceKind;
  discord_id: string;
  created_at: number;
}

export function getResource(key: string): ManagedResource | undefined {
  return db().prepare('SELECT * FROM managed_resources WHERE key = ?').get(key) as ManagedResource | undefined;
}

export function listResources(): ManagedResource[] {
  return db().prepare('SELECT * FROM managed_resources ORDER BY kind, key').all() as ManagedResource[];
}

export function setResource(key: string, kind: ResourceKind, discordId: string): void {
  db()
    .prepare(
      `INSERT INTO managed_resources (key, kind, discord_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET discord_id = excluded.discord_id, kind = excluded.kind`,
    )
    .run(key, kind, discordId, Date.now());
}

export function deleteResource(key: string): void {
  db().prepare('DELETE FROM managed_resources WHERE key = ?').run(key);
}

export function roleId(key: RoleKey): string | null {
  return getResource(`role:${key}`)?.discord_id ?? null;
}

/** Salon configuré : réaffectation manuelle (panel) prioritaire, sinon salon créé par /setup. */
export function channelId(key: ChannelKey): string | null {
  const override = getSetting('channels.overrides')[key];
  if (override) return override;
  return getResource(`channel:${key}`)?.discord_id ?? null;
}

export function categoryId(key: CategoryKey): string | null {
  return getResource(`category:${key}`)?.discord_id ?? null;
}
