import { Events, type Client, type Interaction } from 'discord.js';
import { getCommand, getComponentHandler } from './registry';
import { ephemeral, explainDiscordError, isExpiredInteraction, requireFeature } from './reply';
import { errorEmbed } from './ui/embeds';
import { childLogger } from '../core/logger';
import { rateLimit } from '../core/guards';
import { env } from '../config/env';

const log = childLogger('interactions');

export function attachInteractionHandler(client: Client): void {
  client.on(Events.InteractionCreate, (i) => {
    void handle(i);
  });
}

async function handle(i: Interaction): Promise<void> {
  // Le bot est dédié au serveur RBKS PVP : on ignore les MP et les autres serveurs.
  if (!i.inCachedGuild() || i.guildId !== env().GUILD_ID) {
    if (i.isRepliable()) await ephemeral(i, errorEmbed('Ce bot ne fonctionne que sur le serveur RBKS PVP.')).catch(() => undefined);
    return;
  }
  // Anti-abus : 20 interactions / 10 s par membre.
  if (!rateLimit(`int:${i.user.id}`, 20, 10_000)) {
    if (i.isRepliable()) await ephemeral(i, errorEmbed('Doucement ! Réessaie dans quelques secondes.')).catch(() => undefined);
    return;
  }
  try {
    if (i.isChatInputCommand()) {
      const cmd = getCommand(i.commandName);
      if (!cmd) return void (await ephemeral(i, errorEmbed('Commande inconnue (redémarrage en cours ?).')));
      if (cmd.feature && !(await requireFeature(i, cmd.feature))) return;
      await cmd.execute(i);
      return;
    }
    if (i.isAutocomplete()) {
      const cmd = getCommand(i.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(i);
      else await i.respond([]);
      return;
    }
    if (i.isMessageComponent() || i.isModalSubmit()) {
      const [prefix, action = '', ...args] = i.customId.split(':');
      const handler = getComponentHandler(prefix);
      if (!handler) return void (await ephemeral(i, errorEmbed('Ce bouton n’est plus actif.')));
      await handler.handle(i, action, args);
    }
  } catch (e) {
    if (isExpiredInteraction(e)) {
      log.debug({ id: i.id }, 'Interaction expirée');
      return;
    }
    log.error({ err: e, type: i.type, user: i.user.id, id: 'customId' in i ? i.customId : i.isCommand() ? i.commandName : '' }, 'Erreur pendant une interaction');
    if (i.isRepliable()) await ephemeral(i, errorEmbed(explainDiscordError(e))).catch(() => undefined);
  }
}
