import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrations } from './migrations';
import { childLogger } from '../core/logger';

/**
 * Base SQLite via le moteur intégré à Node.js (node:sqlite) : aucun module natif à compiler,
 * donc aucune dépendance à Visual Studio / build-essential, sur toutes les plateformes.
 * Petite couche d'adaptation offrant prepare/exec/pragma/transaction/backup.
 */

const log = childLogger('db');

type Param = string | number | bigint | null | Uint8Array;
type Row = Record<string, any>;

export interface Statement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(statement: string): void;
  /** Comme better-sqlite3 : retourne une fonction qui exécute fn dans une transaction (imbrication tolérée). */
  transaction<T>(fn: () => T): () => T;
  backup(file: string): Promise<void>;
  close(): void;
}

/** Les lignes de node:sqlite ont un prototype nul : on les convertit en objets ordinaires. */
const plain = (row: unknown): Row | undefined => (row ? Object.assign({}, row as Row) : undefined);

function wrapStatement(stmt: StatementSync): Statement {
  return {
    run: (...p: Param[]) => {
      const r = stmt.run(...p);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get: (...p: Param[]) => plain(stmt.get(...p)),
    all: (...p: Param[]) => stmt.all(...p).map((r) => plain(r)!),
  };
}

function wrap(raw: DatabaseSync): Database {
  const cache = new Map<string, Statement>();
  let depth = 0;
  return {
    prepare(sql) {
      let s = cache.get(sql);
      if (!s) {
        s = wrapStatement(raw.prepare(sql));
        if (cache.size < 500) cache.set(sql, s);
      }
      return s;
    },
    exec: (sql) => raw.exec(sql),
    pragma: (statement) => raw.exec(`PRAGMA ${statement}`),
    transaction<T>(fn: () => T) {
      return () => {
        if (depth > 0) return fn();
        depth++;
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        } finally {
          depth--;
        }
      };
    },
    async backup(file) {
      // VACUUM INTO : copie cohérente et compacte, même pendant que le bot écrit.
      if (fs.existsSync(file)) fs.rmSync(file);
      raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    },
    close: () => raw.close(),
  };
}

/** Charge node:sqlite sans afficher l'avertissement « fonctionnalité expérimentale » de Node. */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

let instance: Database | null = null;

/** Ouvre la base (WAL, clés étrangères) et applique les migrations manquantes. */
export function initDb(file: string): Database {
  if (instance) return instance;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = wrap(new DatabaseSync(file));
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

export function db(): Database {
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
