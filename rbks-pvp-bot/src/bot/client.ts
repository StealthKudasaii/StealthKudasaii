import { Client, GatewayIntentBits, Guild, Partials } from 'discord.js';
import { env } from '../config/env';

let client: Client | null = null;

export function createClient(): Client {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // intent privilégié : arrivées/départs, rôles, statistiques
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // intent privilégié : contenu des messages pour les transcripts
      GatewayIntentBits.GuildModeration, // bannissements + journal d'audit (sanctions)
    ],
    partials: [Partials.GuildMember],
    allowedMentions: { parse: ['users'], repliedUser: false },
  });
  return client;
}

export function getClient(): Client {
  if (!client) throw new Error('Client Discord non initialisé');
  return client;
}

export function isBotReady(): boolean {
  return !!client?.isReady();
}

/** Le serveur RBKS PVP (le bot est conçu pour un serveur unique, défini par GUILD_ID). */
export function getGuild(): Guild {
  const guild = getClient().guilds.cache.get(env().GUILD_ID);
  if (!guild) throw new Error('Le bot n’est pas présent sur le serveur défini par GUILD_ID');
  return guild;
}

export function tryGetGuild(): Guild | null {
  try {
    return getGuild();
  } catch {
    return null;
  }
}

/** Réservé aux tests : injecte un faux client Discord. */
export function __setClientForTests(fake: unknown): void {
  client = fake as Client;
}
