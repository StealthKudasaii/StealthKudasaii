import type { MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { getSetting, setSetting } from '../core/settings';
import { channelId } from '../core/resources';
import type { ChannelKey } from '../config/layout';
import { upsertMessage } from './messages';

/**
 * Publie (ou met à jour sur place) un message « panneau » permanent : tickets, notifications, règlement…
 * Le message est retrouvé par son identifiant enregistré : relancer la publication ne crée pas de doublon.
 */
export async function publishPanel(key: string, channel: ChannelKey, payload: MessageCreateOptions & MessageEditOptions): Promise<{ channelId: string; messageId: string }> {
  const target = channelId(channel);
  if (!target) throw new Error(`Salon « ${channel} » non configuré : lance d’abord /setup installer.`);
  const panels = getSetting('panels');
  const location = await upsertMessage(target, panels[key] ?? {}, payload);
  setSetting('panels', { ...getSetting('panels'), [key]: location });
  return location;
}
