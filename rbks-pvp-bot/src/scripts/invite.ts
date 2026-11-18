import 'dotenv/config';
import { PermissionsBitField, OAuth2Scopes } from 'discord.js';
import { BOT_INVITE_PERMISSIONS } from '../config/layout';

const clientId = process.env.DISCORD_CLIENT_ID;
if (!clientId) {
  console.error('Renseigne DISCORD_CLIENT_ID dans .env');
  process.exit(1);
}
const perms = new PermissionsBitField(BOT_INVITE_PERMISSIONS).bitfield.toString();
const url = new URL('https://discord.com/oauth2/authorize');
url.searchParams.set('client_id', clientId);
url.searchParams.set('scope', [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '));
url.searchParams.set('permissions', perms);
if (process.env.GUILD_ID) {
  url.searchParams.set('guild_id', process.env.GUILD_ID);
  url.searchParams.set('disable_guild_select', 'true');
}
console.log('\nLien d’invitation du bot (permissions minimales, sans Administrateur) :\n');
console.log(url.toString() + '\n');
