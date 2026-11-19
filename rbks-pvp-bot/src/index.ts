import { env, databasePath } from './config/env';
import { logger } from './core/logger';
import { initDb, closeDb } from './db';
import { seed } from './db/seed';
import { seedChallenges } from './modules/rewards/rewards.repo';
import { setTimezone } from './core/time';
import { startBot } from './bot';
import { startScheduler, stopScheduler } from './core/scheduler';
import { startWeb } from './web/server';
import { cancelAllDebounces } from './core/guards';

async function main() {
  let config;
  try {
    config = env();
  } catch (e) {
    logger.fatal((e as Error).message);
    process.exit(2);
  }
  setTimezone(config.TIMEZONE);
  initDb(databasePath());
  seed();
  seedChallenges();
  logger.info('Base de données prête');

  const web = config.WEB_ENABLED ? await startWeb() : null;
  let client;
  try {
    client = await startBot();
  } catch (e) {
    const msg = String((e as Error).message);
    if (/TokenInvalid|invalid token/i.test(msg)) logger.fatal('Token Discord invalide : vérifie DISCORD_TOKEN dans .env (Portail développeur → Bot → Reset Token).');
    else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(msg)) logger.fatal('Impossible de joindre Discord : vérifie la connexion Internet du serveur (DNS, pare-feu).');
    else if (/disallowed intents/i.test(msg)) logger.fatal('Intents privilégiés refusés : active « Server Members Intent » et « Message Content Intent » dans le Portail développeur → Bot.');
    else logger.fatal({ err: e }, 'Connexion à Discord impossible');
    process.exit(2);
  }
  startScheduler();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Arrêt propre en cours…');
    stopScheduler();
    cancelAllDebounces();
    await new Promise<void>((r) => (web ? web.close(() => r()) : r()));
    await client.destroy().catch(() => undefined);
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error({ err: e }, 'Promesse rejetée non gérée'));
  process.on('uncaughtException', (e) => logger.error({ err: e }, 'Exception non interceptée'));
}

void main();
