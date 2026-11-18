import { Events } from 'discord.js';
import { createClient } from './client';
import { registerModules, allCommands } from './registry';
import { attachInteractionHandler } from './interactions';
import { attachEvents } from './events';
import { env } from '../config/env';
import { childLogger } from '../core/logger';
import { applyPresence } from '../modules/botprofile';
import { generalModule } from '../modules/general';
import { setupModule } from '../modules/setup';
import { ticketsModule } from '../modules/tickets';
import { whitelistModule } from '../modules/whitelist';
import { devModule } from '../modules/dev';
import { suggestionsModule } from '../modules/community/suggestions';
import { bugsModule } from '../modules/community/bugs';
import { testSessionsModule } from '../modules/community/testsessions';
import { pollsModule } from '../modules/community/polls';
import { notificationsModule } from '../modules/notifications';
import { publicationsModule } from '../modules/publications';

const log = childLogger('bot');

export const MODULES = [
  generalModule,
  setupModule,
  ticketsModule,
  whitelistModule,
  devModule,
  suggestionsModule,
  bugsModule,
  testSessionsModule,
  pollsModule,
  notificationsModule,
  publicationsModule,
];

let registered = false;
export function ensureModulesRegistered(): void {
  if (registered) return;
  registerModules(MODULES);
  registered = true;
}

export function commandsJson() {
  ensureModulesRegistered();
  return allCommands().map((c) => c.data.toJSON());
}

export async function startBot() {
  ensureModulesRegistered();
  const client = createClient();
  attachInteractionHandler(client);
  attachEvents(client);

  client.once(Events.ClientReady, async (c) => {
    log.info({ tag: c.user.tag }, 'Bot connecté à Discord');
    const guild = c.guilds.cache.get(env().GUILD_ID);
    if (!guild) {
      log.error({ guild: env().GUILD_ID }, 'Le bot n’est pas sur le serveur GUILD_ID : invite-le avec `npm run invite`.');
      return;
    }
    // Cache des membres pour les statistiques et les vérifications de rôles.
    await guild.members.fetch().catch((e) => log.warn({ err: e }, 'Chargement des membres impossible (intent « Server Members » activé ?)'));
    if (env().REGISTER_COMMANDS_ON_START) {
      try {
        // Remplacement en bloc : idempotent, aucune commande en double après un redémarrage.
        await guild.commands.set(commandsJson());
        log.info({ count: allCommands().length }, 'Commandes slash enregistrées sur le serveur');
      } catch (e) {
        log.error({ err: e }, 'Enregistrement des commandes impossible');
      }
    }
    applyPresence();
  });

  client.on(Events.Error, (e) => log.error({ err: e }, 'Erreur du client Discord'));
  client.on(Events.Warn, (w) => log.warn(w));
  client.rest.on('rateLimited', (info) => log.warn({ route: info.route, retryAfter: info.retryAfter }, 'Limite de débit Discord atteinte (gérée automatiquement)'));

  await client.login(env().DISCORD_TOKEN);
  return client;
}
