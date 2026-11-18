import { db } from './index';
import { ROADMAP_DEFAULT_CATEGORIES, TICKET_DEFAULT_REASONS } from '../config/constants';

/** Données initiales (une seule fois) : motifs de tickets et catégories de roadmap. */
export function seed(): void {
  const done = db().prepare("SELECT value FROM settings WHERE key = 'internal.seeded'").get();
  if (done) return;
  db().transaction(() => {
    if (!(db().prepare('SELECT COUNT(*) n FROM ticket_reasons').get() as { n: number }).n) {
      const stmt = db().prepare('INSERT INTO ticket_reasons (label, emoji, description, position) VALUES (?, ?, ?, ?)');
      TICKET_DEFAULT_REASONS.forEach((r, i) => stmt.run(r.label, r.emoji, r.description, i + 1));
    }
    if (!(db().prepare('SELECT COUNT(*) n FROM roadmap_categories').get() as { n: number }).n) {
      const stmt = db().prepare('INSERT INTO roadmap_categories (name, emoji, position) VALUES (?, ?, ?)');
      ROADMAP_DEFAULT_CATEGORIES.forEach((c, i) => stmt.run(c.name, c.emoji, i + 1));
    }
    db().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('internal.seeded', 'true', ?)").run(Date.now());
  })();
}
