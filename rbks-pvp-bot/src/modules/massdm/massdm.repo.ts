import crypto from 'node:crypto';
import { db } from '../../db';

export interface Campaign {
  id: number;
  name: string;
  title: string;
  message: string;
  role_id: string;
  with_keys: number;
  status: 'draft' | 'sending' | 'done';
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Recipient {
  campaign_id: number;
  user_id: string;
  user_tag: string | null;
  access_key: string | null;
  status: 'pending' | 'sent' | 'failed';
  error: string | null;
  sent_at: number | null;
  created_at: number;
}

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
}

/** Alphabet sans caractères ambigus (pas de 0/O, 1/I/L) : facile à recopier dans le jeu. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Clé d'accès au format RBKS-XXXX-XXXX-XXXX (≈ 59 bits d'aléatoire cryptographique). */
export function generateKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return `RBKS-${groups.join('-')}`;
}

export const KEY_RE = /^RBKS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export const campaigns = {
  list(): Campaign[] {
    return db().prepare('SELECT * FROM dm_campaigns ORDER BY id DESC').all() as Campaign[];
  },
  get(id: number): Campaign | undefined {
    return db().prepare('SELECT * FROM dm_campaigns WHERE id = ?').get(id) as Campaign | undefined;
  },
  byName(name: string): Campaign | undefined {
    return db().prepare('SELECT * FROM dm_campaigns WHERE name = ?').get(name) as Campaign | undefined;
  },
  search(q: string): Campaign[] {
    return db().prepare('SELECT * FROM dm_campaigns WHERE name LIKE ? ORDER BY id DESC LIMIT 25').all(`%${q}%`) as Campaign[];
  },
  create(c: { name: string; roleId: string; withKeys: boolean; createdBy: string }): number {
    return Number(
      db()
        .prepare('INSERT INTO dm_campaigns (name, role_id, with_keys, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.name, c.roleId, c.withKeys ? 1 : 0, c.createdBy, Date.now()).lastInsertRowid,
    );
  },
  setMessage(id: number, title: string, message: string): void {
    db().prepare('UPDATE dm_campaigns SET title = ?, message = ? WHERE id = ?').run(title, message, id);
  },
  setStatus(id: number, status: Campaign['status']): void {
    const t = Date.now();
    if (status === 'sending') db().prepare('UPDATE dm_campaigns SET status = ?, started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?').run(status, t, id);
    else if (status === 'done') db().prepare('UPDATE dm_campaigns SET status = ?, finished_at = ? WHERE id = ?').run(status, t, id);
    else db().prepare('UPDATE dm_campaigns SET status = ? WHERE id = ?').run(status, id);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM dm_campaigns WHERE id = ?').run(id);
  },
  counts(id: number): CampaignCounts {
    const rows = db().prepare('SELECT status, COUNT(*) n FROM dm_recipients WHERE campaign_id = ? GROUP BY status').all(id) as { status: Recipient['status']; n: number }[];
    const c: CampaignCounts = { total: 0, pending: 0, sent: 0, failed: 0 };
    for (const r of rows) {
      c[r.status] = r.n;
      c.total += r.n;
    }
    return c;
  },
};

export const recipients = {
  list(campaignId: number): Recipient[] {
    return db().prepare('SELECT * FROM dm_recipients WHERE campaign_id = ? ORDER BY created_at, user_id').all(campaignId) as Recipient[];
  },
  pending(campaignId: number): Recipient[] {
    return db().prepare("SELECT * FROM dm_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY created_at, user_id").all(campaignId) as Recipient[];
  },
  /**
   * Ajoute les membres absents du lot (avec une clé unique si le lot en distribue).
   * Les membres déjà présents gardent leur clé : relancer ne change jamais une clé déjà donnée.
   */
  addMissing(campaign: Campaign, members: { id: string; tag: string }[]): number {
    const existing = new Set(recipients.list(campaign.id).map((r) => r.user_id));
    const insert = db().prepare('INSERT INTO dm_recipients (campaign_id, user_id, user_tag, access_key, created_at) VALUES (?, ?, ?, ?, ?)');
    let added = 0;
    db().transaction(() => {
      for (const m of members) {
        if (existing.has(m.id)) continue;
        let key: string | null = null;
        if (campaign.with_keys) {
          // Collision quasi impossible, mais l'index unique la refuserait : on retente.
          for (let i = 0; i < 5; i++) {
            const k = generateKey();
            if (!db().prepare('SELECT 1 FROM dm_recipients WHERE access_key = ?').get(k)) {
              key = k;
              break;
            }
          }
          if (!key) throw new Error('Génération de clé impossible');
        }
        insert.run(campaign.id, m.id, m.tag, key, Date.now());
        added++;
      }
    })();
    return added;
  },
  markSent(campaignId: number, userId: string): void {
    db().prepare("UPDATE dm_recipients SET status = 'sent', error = NULL, sent_at = ? WHERE campaign_id = ? AND user_id = ?").run(Date.now(), campaignId, userId);
  },
  markFailed(campaignId: number, userId: string, error: string): void {
    db().prepare("UPDATE dm_recipients SET status = 'failed', error = ? WHERE campaign_id = ? AND user_id = ?").run(error, campaignId, userId);
  },
  retryFailed(campaignId: number): number {
    return db().prepare("UPDATE dm_recipients SET status = 'pending', error = NULL WHERE campaign_id = ? AND status = 'failed'").run(campaignId).changes;
  },
  keysForUser(userId: string): (Recipient & { campaign_name: string; campaign_title: string })[] {
    return db()
      .prepare(
        'SELECT r.*, c.name campaign_name, c.title campaign_title FROM dm_recipients r JOIN dm_campaigns c ON c.id = r.campaign_id WHERE r.user_id = ? AND r.access_key IS NOT NULL ORDER BY r.created_at DESC',
      )
      .all(userId) as (Recipient & { campaign_name: string; campaign_title: string })[];
  },
  /** Pseudo Roblox donné dans la dernière candidature acceptée du membre (si elle existe). */
  robloxOf(userId: string): string | null {
    const row = db()
      .prepare("SELECT roblox_username FROM applications WHERE user_id = ? AND status = 'accepted' AND roblox_username IS NOT NULL ORDER BY decided_at DESC LIMIT 1")
      .get(userId) as { roblox_username: string } | undefined;
    return row?.roblox_username ?? null;
  },
};
