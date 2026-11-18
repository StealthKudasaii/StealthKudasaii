import { ChannelType, type GuildTextBasedChannel, type Message, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { getGuild } from './client';
import { isUnknownResource } from './reply';
import { childLogger } from '../core/logger';

const log = childLogger('messages');

export async function fetchTextChannel(channelId: string | null | undefined): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  try {
    const ch = await getGuild().channels.fetch(channelId);
    if (!ch || !ch.isTextBased() || ch.type === ChannelType.GuildVoice) return null;
    return ch as GuildTextBasedChannel;
  } catch (e) {
    if (isUnknownResource(e)) return null;
    throw e;
  }
}

export async function fetchMessage(channelId: string | null | undefined, messageId: string | null | undefined): Promise<Message | null> {
  if (!channelId || !messageId) return null;
  const ch = await fetchTextChannel(channelId);
  if (!ch) return null;
  try {
    return await ch.messages.fetch(messageId);
  } catch (e) {
    if (isUnknownResource(e)) return null;
    throw e;
  }
}

/**
 * Met à jour le message existant s'il est toujours dans le bon salon, sinon en publie un nouveau.
 * Retourne l'emplacement final du message.
 */
export async function upsertMessage(
  channelId: string,
  previous: { channelId?: string | null; messageId?: string | null },
  payload: MessageCreateOptions & MessageEditOptions,
): Promise<{ channelId: string; messageId: string }> {
  if (previous.messageId && previous.channelId === channelId) {
    const msg = await fetchMessage(channelId, previous.messageId);
    if (msg) {
      await msg.edit(payload as MessageEditOptions);
      return { channelId, messageId: msg.id };
    }
  } else if (previous.messageId && previous.channelId) {
    // Le salon cible a changé : on retire l'ancien message pour éviter les doublons.
    await deleteMessage(previous.channelId, previous.messageId);
  }
  const ch = await fetchTextChannel(channelId);
  if (!ch) throw new Error('Salon introuvable ou inaccessible pour le bot');
  const msg = await ch.send(payload as MessageCreateOptions);
  return { channelId, messageId: msg.id };
}

export async function deleteMessage(channelId: string | null | undefined, messageId: string | null | undefined): Promise<void> {
  const msg = await fetchMessage(channelId, messageId).catch(() => null);
  if (msg) await msg.delete().catch((e) => log.warn({ err: e }, 'Suppression de message impossible'));
}
