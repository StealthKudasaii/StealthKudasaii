import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations';
import { childLogger } from '../core/logger';

const log = childLogger('db');
let instance: Database.Database | null = null;

/** Ouvre la base (WAL, clés étrangères) et applique les migrations manquantes. */
export function initDb(file: string): Database.Database {
  if (instance) return instance;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    })();
    log.info({ migration: m.name }, 'Migration appliquée');
  }
  instance = db;
  return db;
}

export function db(): Database.Database {
  if (!instance) throw new Error('Base de données non initialisée (initDb manquant)');
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** Parse JSON tolérant pour les colonnes TEXT. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const now = () => Date.now();
