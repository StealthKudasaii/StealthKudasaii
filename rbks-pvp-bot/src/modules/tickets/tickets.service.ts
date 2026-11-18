import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { env } from '../../config/env';
import { COLORS, TICKET_STATUS } from '../../config/constants';
import { getGuild } from '../../bot/client';
import { brandEmbed } from '../../bot/ui/embeds';
import { fetchTextChannel } from '../../bot/messages';
import { publishPanel } from '../../bot/panels';
import { cid } from '../../bot/types';
import { categoryId } from '../../core/resources';
import { featureRoleIds } from '../../core/permissions';
import { getSetting } from '../../core/settings';
import { hitCooldown, rateLimit, resetCooldown, tryLock } from '../../core/guards';
import { discordTs } from '../../core/time';
import { sanitizeMentions, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';
import { reasons, tickets, type Ticket } from './tickets.repo';
import { fetchAllMessages, renderTranscriptHtml, toTranscriptMessages } from './transcript';

const log = childLogger('tickets');
export const transcriptDir = () => path.resolve(env().DATA_DIR, 'transcripts');

export function ticketPanelPayload() {
  const list = reasons.list(true);
  const embed = brandEmbed({ title: getSetting('tickets.panelTitle'), description: getSetting('tickets.panelDescription'), timestamp: false });
  if (list.length) embed.addFields({ name: 'Motifs disponibles', value: truncate(list.map((r) => `${r.emoji ?? '•'} **${r.label}**${r.description ? ` — ${r.description}` : ''}`).join('\n'), 1024) });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('ticket', 'open')).setLabel('Ouvrir un ticket').setEmoji('📩').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export async function publishTicketPanel() {
  return publishPanel('tickets', 'open_ticket', ticketPanelPayload());
}

/** Vérifie les limites anti-spam. Retourne un message d'erreur, ou null si l'ouverture est permise. */
export function checkCanOpen(userId: string, consume: boolean): string | null {
  const max = getSetting('tickets.maxOpenPerUser');
  if (tickets.openCountForUser(userId) >= max) return `Tu as déjà ${max > 1 ? `${max} tickets ouverts` : 'un ticket ouvert'}. Termine-le avant d’en ouvrir un autre.`;
  if (consume) {
    const wait = hitCooldown(`ticket:${userId}`, getSetting('tickets.cooldownSeconds') * 1000);
    if (wait) return `Merci d’attendre encore ${Math.ceil(wait / 1000)} s avant d’ouvrir un nouveau ticket.`;
    if (!rateLimit('ticket:global', 15, 10 * 60_000)) return 'Beaucoup de tickets viennent d’être ouverts. Réessaie dans quelques minutes.';
  }
  return null;
}

function ticketButtons(t: Ticket) {
  const closed = t.status === 'closed';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid('ticket', 'claim', t.id)).setLabel(t.claimed_by ? 'Pris en charge' : 'Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(!!t.claimed_by || closed),
      new ButtonBuilder().setCustomId(cid('ticket', 'add', t.id)).setLabel('Ajouter un membre').setEmoji('➕').setStyle(ButtonStyle.Secondary).setDisabled(closed),
      new ButtonBuilder().setCustomId(cid('ticket', 'note', t.id)).setLabel('Note interne').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('ticket', 'notes', t.id)).setLabel('Notes').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('ticket', 'close', t.id)).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(closed),
    ),
  ];
}

export function ticketEmbed(t: Ticket, member: GuildMember | null) {
  const status = TICKET_STATUS[t.status];
  const e = brandEmbed({
    title: `🎫 Ticket n°${t.id} — ${t.reason_label}`,
    description: `${getSetting('tickets.welcomeMessage')}\n\n**Sujet :** ${sanitizeMentions(t.subject ?? '—')}\n${t.details ? `>>> ${truncate(sanitizeMentions(t.details), 1500)}` : ''}`,
    color: status.color,
  });
  e.addFields(
    { name: 'Créateur', value: `<@${t.user_id}>\n\`${t.user_id}\``, inline: true },
    { name: 'Statut', value: `${status.emoji} ${status.label}`, inline: true },
    { name: 'Pris en charge par', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true },
  );
  if (member) {
    e.setThumbnail(member.displayAvatarURL({ size: 128 }));
    e.addFields(
      { name: 'Compte créé', value: discordTs(member.user.createdTimestamp, 'R'), inline: true },
      { name: 'A rejoint le serveur', value: member.joinedTimestamp ? discordTs(member.joinedTimestamp, 'R') : '—', inline: true },
      { name: 'Tickets ouverts', value: String(tickets.openCountForUser(t.user_id)), inline: true },
    );
  }
  return e;
}

export async function createTicket(member: GuildMember, reasonId: number, subject: string, details: string): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
  const reason = reasons.get(reasonId);
  if (!reason || !reason.enabled) return { ok: false, error: 'Ce motif n’est plus disponible.' };
  const blocked = checkCanOpen(member.id, false);
  if (blocked) return { ok: false, error: blocked };

  const guild = member.guild;
  const parent = categoryId('cat_tickets');
  const staffRoles = featureRoleIds('tickets.handle').filter((id) => guild.roles.cache.has(id));
  const id = tickets.create({ userId: member.id, reasonId: reason.id, reasonLabel: reason.label, subject, details });
  const userPerms = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
  try {
    const channel = await guild.channels.create({
      name: `ticket-${String(id).padStart(4, '0')}-${member.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: parent ?? undefined,
      topic: `Ticket n°${id} • ${reason.label} • ${member.user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        { id: guild.members.me!.id, type: OverwriteType.Member, allow: [...userPerms, P.ManageChannels, P.ManageMessages] },
        { id: member.id, type: OverwriteType.Member, allow: userPerms },
        ...staffRoles.map((r) => ({ id: r, type: OverwriteType.Role, allow: [...userPerms, P.ManageMessages] })),
      ],
      reason: `Ticket n°${id} ouvert par ${member.user.tag}`,
    });
    tickets.setChannel(id, channel.id);
    const t = tickets.get(id)!;
    const mentionRoles = staffRoles.map((r) => `<@&${r}>`).join(' ');
    await channel.send({
      content: `<@${member.id}>${mentionRoles ? ` • ${mentionRoles}` : ''}`,
      embeds: [ticketEmbed(t, member)],
      components: ticketButtons(t),
      allowedMentions: { users: [member.id], roles: staffRoles },
    });
    await audit({ type: 'tickets', action: 'open', actorId: member.id, target: `Ticket n°${id}`, message: `Ticket n°${id} ouvert (${reason.label}) : <#${channel.id}>`, color: COLORS.success });
    return { ok: true, channelId: channel.id };
  } catch (e) {
    tickets.remove(id);
    resetCooldown(`ticket:${member.id}`);
    log.error({ err: e }, 'Création du salon de ticket impossible');
    return { ok: false, error: 'Impossible de créer le salon du ticket (permissions du bot ?). Le staff a été notifié dans les logs.' };
  }
}

export async function refreshTicketMessage(t: Ticket): Promise<void> {
  if (!t.channel_id) return;
  const ch = await fetchTextChannel(t.channel_id);
  if (!ch) return;
  const msgs = await ch.messages.fetch({ limit: 10, after: '0' }).catch(() => null);
  const first = msgs?.filter((m) => m.author.id === ch.client.user.id && m.embeds[0]?.title?.startsWith(`🎫 Ticket n°${t.id}`)).last();
  if (!first) return;
  const member = await ch.guild.members.fetch(t.user_id).catch(() => null);
  await first.edit({ embeds: [ticketEmbed(t, member)], components: ticketButtons(t) });
}

export async function claimTicket(t: Ticket, staffId: string): Promise<string | null> {
  if (!tickets.claim(t.id, staffId)) return 'Ce ticket est déjà pris en charge ou fermé.';
  const updated = tickets.get(t.id)!;
  await refreshTicketMessage(updated);
  const ch = await fetchTextChannel(t.channel_id);
  await ch?.send({ embeds: [brandEmbed({ description: `🙋 <@${staffId}> prend en charge ce ticket.`, color: COLORS.info })] });
  await audit({ type: 'tickets', action: 'claim', actorId: staffId, target: `Ticket n°${t.id}`, message: `Ticket n°${t.id} pris en charge.` });
  return null;
}

export async function addMemberToTicket(t: Ticket, userId: string, actorId: string): Promise<void> {
  const ch = await fetchTextChannel(t.channel_id);
  if (!ch || !('permissionOverwrites' in ch)) throw new Error('Salon du ticket introuvable');
  await ch.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, { type: OverwriteType.Member });
  await ch.send({ embeds: [brandEmbed({ description: `➕ <@${userId}> a été ajouté au ticket par <@${actorId}>.`, color: COLORS.info })] });
  await audit({ type: 'tickets', action: 'add_member', actorId, target: `Ticket n°${t.id}`, message: `<@${userId}> ajouté au ticket n°${t.id}.` });
}

export async function removeMemberFromTicket(t: Ticket, userId: string, actorId: string): Promise<void> {
  if (userId === t.user_id) throw new Error('Impossible de retirer le créateur du ticket.');
  const ch = await fetchTextChannel(t.channel_id);
  if (!ch || !('permissionOverwrites' in ch)) throw new Error('Salon du ticket introuvable');
  await ch.permissionOverwrites.delete(userId);
  await ch.send({ embeds: [brandEmbed({ description: `➖ <@${userId}> a été retiré du ticket par <@${actorId}>.`, color: COLORS.muted })] });
}

/** Ferme le ticket : transcript, logs, MP au créateur, puis suppression ou archivage du salon. */
export async function closeTicket(ticketId: number, actorId: string, reason: string | null): Promise<string | null> {
  const res = await tryLock(`ticket-close:${ticketId}`, async () => {
    const t = tickets.get(ticketId);
    if (!t) return 'Ticket introuvable.';
    if (!tickets.markClosed(t.id, actorId, reason)) return 'Ce ticket est déjà fermé.';
    const closed = tickets.get(t.id)!;
    const guild = getGuild();
    const channel = await fetchTextChannel(t.channel_id);
    let file: string | null = null;
    let count = 0;
    let html: string | null = null;
    if (channel) {
      try {
        const messages = await fetchAllMessages(channel);
        count = messages.length;
        const ids = new Set<string>([t.user_id, actorId, ...(t.claimed_by ? [t.claimed_by] : []), ...tickets.notes(t.id).map((n) => n.author_id)]);
        const names: Record<string, string> = {};
        for (const m of messages) names[m.author.id] = m.member?.displayName ?? m.author.username;
        for (const uid of ids) if (!names[uid]) names[uid] = (await guild.members.fetch(uid).catch(() => null))?.displayName ?? uid;
        html = renderTranscriptHtml(closed, toTranscriptMessages(messages), tickets.notes(t.id), names, getSetting('brand.name'));
        fs.mkdirSync(transcriptDir(), { recursive: true });
        file = `ticket-${t.id}.html`;
        fs.writeFileSync(path.join(transcriptDir(), file), html, 'utf8');
      } catch (e) {
        log.error({ err: e }, 'Transcript impossible');
      }
    }
    tickets.setTranscript(t.id, file, count);

    const logEmbed = brandEmbed({ title: `🔒 Ticket n°${t.id} fermé`, color: COLORS.muted }).addFields(
      { name: 'Motif', value: t.reason_label, inline: true },
      { name: 'Créateur', value: `<@${t.user_id}>`, inline: true },
      { name: 'Fermé par', value: `<@${actorId}>`, inline: true },
      { name: 'Pris en charge par', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true },
      { name: 'Messages', value: String(count), inline: true },
      { name: 'Ouvert', value: discordTs(t.created_at, 'R'), inline: true },
      ...(reason ? [{ name: 'Raison de fermeture', value: truncate(reason, 1024) }] : []),
    );
    await audit({
      type: 'tickets',
      action: 'close',
      actorId,
      target: `Ticket n°${t.id}`,
      message: `Ticket n°${t.id} fermé${reason ? ` : ${reason}` : ''}.`,
      embed: logEmbed,
      files: html && file ? [{ attachment: Buffer.from(html, 'utf8'), name: file }] : [],
    });

    // Message privé au créateur (facultatif : MP fermés possibles).
    const creator = await guild.members.fetch(t.user_id).catch(() => null);
    if (creator) {
      const dm = brandEmbed({
        title: `🎫 Ton ticket n°${t.id} est fermé`,
        description: `Motif : **${t.reason_label}**${reason ? `\nRaison : ${reason}` : ''}\n\nMerci d’avoir contacté le staff de ${getSetting('brand.name')} !`,
      });
      const files = getSetting('tickets.dmTranscript') && html && file ? [{ attachment: Buffer.from(html, 'utf8'), name: file }] : [];
      await creator.send({ embeds: [dm], files }).catch(() => undefined);
    }

    if (channel) {
      if (getSetting('tickets.closeMode') === 'archive' && 'permissionOverwrites' in channel) {
        await channel.permissionOverwrites.edit(t.user_id, { ViewChannel: false }, { type: OverwriteType.Member }).catch(() => undefined);
        if ('setName' in channel) await channel.setName(`fermé-${String(t.id).padStart(4, '0')}`).catch(() => undefined);
        await channel.send({
          embeds: [brandEmbed({ description: `🔒 Ticket fermé par <@${actorId}>. Le salon est archivé (visible par le staff uniquement).`, color: COLORS.muted })],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(cid('ticket', 'delete', t.id)).setLabel('Supprimer le salon').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            ),
          ],
        });
        await refreshTicketMessage(closed);
      } else {
        await channel.send({ embeds: [brandEmbed({ description: `🔒 Ticket fermé par <@${actorId}>. Suppression du salon dans 5 secondes…`, color: COLORS.muted })] }).catch(() => undefined);
        setTimeout(() => {
          channel
            .delete(`Ticket n°${t.id} fermé`)
            .then(() => tickets.setChannelNull(t.id))
            .catch((e) => log.warn({ err: e }, 'Suppression du salon de ticket impossible'));
        }, 5000);
      }
    }
    return null;
  });
  return res.ok ? res.value : 'Fermeture déjà en cours…';
}

export async function deleteArchivedTicketChannel(t: Ticket): Promise<void> {
  const ch = await fetchTextChannel(t.channel_id);
  if (ch) await ch.delete(`Ticket n°${t.id} archivé supprimé`);
  tickets.setChannelNull(t.id);
}

export function ticketOf(channel: GuildTextBasedChannel | null): Ticket | undefined {
  return channel ? tickets.byChannel(channel.id) : undefined;
}

