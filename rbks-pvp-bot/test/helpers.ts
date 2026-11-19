import { closeDb, initDb } from '../src/db';
import { seed } from '../src/db/seed';
import { seedChallenges } from '../src/modules/rewards/rewards.repo';
import { clearSettingsCache } from '../src/core/settings';

export function freshDb() {
  closeDb();
  clearSettingsCache();
  const db = initDb(':memory:');
  seed();
  seedChallenges();
  return db;
}
