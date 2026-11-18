import { db } from '../db';
import { childLogger } from './logger';
import { backupDatabase } from './backup';
import { getSetting, setSetting } from './settings';
import { isBotReady } from '../bot/client';
import { tickPolls } from '../modules/community/polls';
import { tickSessions } from '../modules/community/testsessions';
import { refreshFormStates } from '../modules/whitelist/forms.service';

const log = childLogger('scheduler');
let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Boucle unique toutes les 30 s. Tout l'état vient de la base : après un redémarrage,
 * les sondages expirés se ferment, les rappels manqués partent et les formulaires se mettent à jour.
 */
export function startScheduler(): void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (isBotReady()) {
        await tickPolls();
        await tickSessions();
        refreshFormStates();
      }
      db().prepare('DELETE FROM web_sessions WHERE expires < ?').run(Date.now());
      db().prepare('DELETE FROM application_drafts WHERE updated_at < ?').run(Date.now() - 864e5);
      const last = getSetting('internal.lastBackup');
      if (Date.now() - last > 864e5) {
        setSetting('internal.lastBackup', Date.now());
        await backupDatabase();
      }
    } catch (e) {
      log.error({ err: e }, 'Erreur du planificateur');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), 30_000);
  setTimeout(() => void tick(), 5_000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
