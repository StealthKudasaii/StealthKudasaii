import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { env } from '../config/env';
import { childLogger } from './logger';

const log = childLogger('backup');

/** Sauvegarde à chaud de la base SQLite (API backup, cohérente même pendant l'écriture). */
export async function backupDatabase(): Promise<string> {
  const dir = path.resolve(env().DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rbks-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  await db().backup(file);
  const keep = env().BACKUP_RETENTION;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('rbks-') && f.endsWith('.sqlite'))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) fs.rmSync(path.join(dir, f));
  log.info({ file }, 'Sauvegarde effectuée');
  return file;
}

export function listBackups(): { name: string; size: number; date: number }[] {
  const dir = path.resolve(env().DATA_DIR, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, date: st.mtimeMs };
    })
    .sort((a, b) => b.date - a.date);
}
