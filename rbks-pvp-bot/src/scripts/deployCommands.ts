import { REST, Routes } from 'discord.js';
import { env } from '../config/env';
import { commandsJson } from '../bot';

/** Enregistre les commandes slash sans démarrer le bot (utile si REGISTER_COMMANDS_ON_START=false). */
async function main() {
  const e = env();
  const rest = new REST().setToken(e.DISCORD_TOKEN);
  const body = commandsJson();
  await rest.put(Routes.applicationGuildCommands(e.DISCORD_CLIENT_ID, e.GUILD_ID), { body });
  console.log(`${body.length} commandes enregistrées sur le serveur ${e.GUILD_ID}.`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
