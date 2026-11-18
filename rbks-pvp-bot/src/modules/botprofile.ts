import { ActivityType, type PresenceStatusData } from 'discord.js';
import { getClient, getGuild, isBotReady } from '../bot/client';
import { getSetting, setSetting, SETTING_DEFAULTS } from '../core/settings';
import { explainDiscordError } from '../bot/reply';
import { audit } from './audit/audit';

type Presence = (typeof SETTING_DEFAULTS)['bot.presence'];

const ACTIVITY: Record<Presence['activityType'], ActivityType> = {
  Playing: ActivityType.Playing,
  Watching: ActivityType.Watching,
  Listening: ActivityType.Listening,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

export function applyPresence(p: Presence = getSetting('bot.presence')): void {
  if (!isBotReady()) return;
  getClient().user!.setPresence({
    status: p.status as PresenceStatusData,
    activities: p.activityText ? [{ name: p.activityType === 'Custom' ? 'custom' : p.activityText, state: p.activityType === 'Custom' ? p.activityText : undefined, type: ACTIVITY[p.activityType] }] : [],
  });
}

export async function updatePresence(p: Presence, actorId: string): Promise<void> {
  setSetting('bot.presence', p);
  applyPresence(p);
  await audit({ type: 'admin', action: 'bot_presence', actorId, message: `Présence du bot modifiée : ${p.status}, ${p.activityType} « ${p.activityText} ».` });
}

/** Renomme réellement le bot via l'API Discord (limité par Discord à 2 changements par heure). */
export async function updateUsername(name: string, actorId: string): Promise<string | null> {
  try {
    await getClient().user!.setUsername(name);
    await audit({ type: 'admin', action: 'bot_username', actorId, message: `Nom du bot changé en « ${name} ».` });
    return null;
  } catch (e) {
    const msg = String((e as Error).message);
    if (/too fast|rate|limit/i.test(msg)) return 'Discord limite les changements de nom (2 par heure). Réessaie plus tard.';
    return explainDiscordError(e) + ` (${msg})`;
  }
}

export async function updateAvatar(image: Buffer | string, actorId: string): Promise<string | null> {
  try {
    await getClient().user!.setAvatar(image);
    await audit({ type: 'admin', action: 'bot_avatar', actorId, message: 'Avatar du bot modifié.' });
    return null;
  } catch (e) {
    const msg = String((e as Error).message);
    if (/too fast|rate|limit/i.test(msg)) return 'Discord limite les changements d’avatar. Réessaie dans quelques minutes.';
    return `Avatar refusé par Discord : ${msg}`;
  }
}

/** Surnom du bot sur le serveur (sans limite stricte, contrairement au nom global). */
export async function updateNickname(nick: string, actorId: string): Promise<string | null> {
  try {
    await getGuild().members.me!.setNickname(nick || null);
    setSetting('bot.nickname', nick);
    await audit({ type: 'admin', action: 'bot_nickname', actorId, message: `Surnom du bot sur le serveur : « ${nick || '(aucun)'} ».` });
    return null;
  } catch (e) {
    return explainDiscordError(e);
  }
}
