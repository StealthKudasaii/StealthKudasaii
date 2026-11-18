import { databasePath } from '../config/env';
import { initDb } from '../db';
import { backupDatabase } from '../core/backup';

initDb(databasePath());
backupDatabase()
  .then((f) => console.log(`Sauvegarde : ${f}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
