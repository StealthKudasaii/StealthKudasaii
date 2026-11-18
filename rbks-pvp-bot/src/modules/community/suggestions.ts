import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { SUGGESTION_STATUS, isKeyOf, type SuggestionStatus } from '../../config/constants';
import { db } from '../../db';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, infoEmbed } from '../../bot/ui/embeds';
import { fetchMessage, fetchTextChannel, upsertMessage } from '../../bot/messages';
import { publishPanel } from '../../bot/panels';
import { channelId } from '../../core/resources';
import { getSetting } from '../../core/settings';
import { hitCooldown, withLock } from '../../core/guards';
import { sanitizeMentions, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';

const log = childLogger('suggestions');

export interface Suggestion {
  id: number;
  user_id: string;
  title: string;
  content: string;
  status: SuggestionStatus;
  staff_response: string | null;
  responder_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export const suggestions = {
  get: (id: number) => db().prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Suggestion | undefined,
  list(status?: string, limit = 50, offset = 0): { rows: (Suggestion & { up: number; down: number })[]; total: number } {
    const where = status ? 'WHERE s.status = ?' : '';
    const params = status ? [status] : [];
    const rows = db()
      .prepare(
        `SELECT s.*, COALESCE(SUM(v.value = 1), 0) up, COALESCE(SUM(v.value = -1), 0) down FROM suggestions s LEFT JOIN suggestion_votes v ON v.suggestion_id = s.id ${where} GROUP BY s.id ORDER BY s.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as (Suggestion & { up: number; down: number })[];
    const total = (db().prepare(`SELECT COUNT(*) n FROM suggestions s ${where}`).get(...params) as { n: number }).n;
    return { rows, total };
  },
  create(userId: string, title: string, content: string): number {
    const t = Date.now();
    return Number(db().prepare('INSERT INTO suggestions (user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(userId, title, content, t, t).lastInsertRowid);
  },
  setMessage(id: number, channelId: string, messageId: string, threadId: string | null): void {
    db().prepare('UPDATE suggestions SET channel_id = ?, message_id = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?').run(channelId, messageId, threadId, id);
  },
  setStatus(id: number, status: SuggestionStatus, response: string | null | undefined, responderId: string): void {
    db()
      .prepare('UPDATE suggestions SET status = ?, staff_response = COALESCE(?, staff_response), responder_id = ?, updated_at = ? WHERE id = ?')
      .run(status, response ?? null, responderId, Date.now(), id);
  },
  remove: (id: number) => db().prepare('DELETE FROM suggestions WHERE id = ?').run(id),
  votes(id: number): { up: number; down: number } {
    const r = db().prepare('SELECT COALESCE(SUM(value = 1), 0) up, COALESCE(SUM(value = -1), 0) down FROM suggestion_votes WHERE suggestion_id = ?').get(id) as { up: number; down: number };
    return { up: r.up, down: r.down };
  },
  /** Un vote par membre : revoter pareil retire le vote, voter l'inverse le change. */
  vote(id: number, userId: string, value: 1 | -1): 'added' | 'removed' | 'changed' {
    const existing = db().prepare('SELECT value FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').get(id, userId) as { value: number } | undefined;
    if (existing?.value === value) {
      db().prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').run(id, userId);
      return 'removed';
    }
    db()
      .prepare('INSERT INTO suggestion_votes (suggestion_id, user_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(suggestion_id, user_id) DO UPDATE SET value = excluded.value')
      .run(id, userId, value, Date.now());
    return existing ? 'changed' : 'added';
  },
};

export function suggestionPayload(s: Suggestion) {
  const st = SUGGESTION_STATUS[s.status];
  const v = suggestions.votes(s.id);
  const total = v.up + v.down;
  const e = brandEmbed({ title: `💡 ${s.title}`, description: sanitizeMentions(s.content), color: st.color, footerExtra: `Suggestion n°${s.id}` }).addFields(
    { name: 'Proposée par', value: `<@${s.user_id}>`, inline: true },
    { name: 'Statut', value: `${st.emoji} ${st.label}`, inline: true },
    { name: 'Votes', value: total ? `👍 ${v.up} • 👎 ${v.down} (${Math.round((v.up / total) * 100)} % pour)` : 'Aucun vote', inline: true },
  );
  if (s.staff_response) e.addFields({ name: '💬 Réponse du staff', value: truncate(`${s.staff_response}${s.responder_id ? `\n— <@${s.responder_id}>` : ''}`, 1024) });
  const closed = s.status === 'refused' || s.status === 'implemented';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('sug', 'up', s.id)).setLabel(String(v.up)).setEmoji('👍').setStyle(ButtonStyle.Success).setDisabled(closed),
    new ButtonBuilder().setCustomId(cid('sug', 'down', s.id)).setLabel(String(v.down)).setEmoji('👎').setStyle(ButtonStyle.Danger).setDisabled(closed),
    new ButtonBuilder().setCustomId(cid('sug', 'manage', s.id)).setLabel('Gérer').setEmoji('🛠️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] as [] } };
}

export async function refreshSuggestion(id: number): Promise<void> {
  const s = suggestions.get(id);
  if (!s?.message_id) return;
  const msg = await fetchMessage(s.channel_id, s.message_id);
  await msg?.edit(suggestionPayload(s));
}

export async function setSuggestionStatus(id: number, status: SuggestionStatus, response: string | null | undefined, actorId: string): Promise<void> {
  const before = suggestions.get(id);
  if (!before) throw new Error('Suggestion introuvable');
  suggestions.setStatus(id, status, response, actorId);
  await refreshSuggestion(id).catch((e) => log.warn({ err: e }, 'Mise à jour suggestion impossible'));
  await audit({ type: 'community', action: 'suggestion_status', actorId, target: `Suggestion n°${id}`, message: `Suggestion « ${before.title} » → ${SUGGESTION_STATUS[status].label}${response ? ` : ${response}` : ''}.`, color: SUGGESTION_STATUS[status].color });
  if (status !== before.status) {
    const guild = (await fetchTextChannel(before.channel_id))?.guild;
    const author = await guild?.members.fetch(before.user_id).catch(() => null);
    await author
      ?.send({ embeds: [brandEmbed({ title: '💡 Ta suggestion a été mise à jour', description: `**${before.title}** → ${SUGGESTION_STATUS[status].emoji} ${SUGGESTION_STATUS[status].label}${response ? `\n\n💬 ${response}` : ''}` })] })
      .catch(() => undefined);
  }
}

export async function publishSuggestionPanel() {
  const e = brandEmbed({
    title: '💡 Boîte à idées RBKS PVP',
    description: 'Une idée pour améliorer le jeu ? Clique sur le bouton ci-dessous ou utilise `/suggestion`.\nLa communauté vote avec 👍 / 👎 et le staff répond directement sous chaque idée.',
    timestamp: false,
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('sug', 'new')).setLabel('Proposer une idée').setEmoji('💡').setStyle(ButtonStyle.Primary));
  return publishPanel('suggestions', 'suggestions', { embeds: [e], components: [row] });
}

export function newModal() {
  return new ModalBuilder()
    .setCustomId(cid('sug', 'submit'))
    .setTitle('Proposer une suggestion')
    .addLabelComponents(
      new LabelBuilder().setLabel('Titre').setTextInputComponent(new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true).setPlaceholder('Ex. Ajouter un mode 2v2')),
      new LabelBuilder().setLabel('Ta suggestion').setTextInputComponent(new TextInputBuilder().setCustomId('content').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true).setPlaceholder('Explique ton idée et pourquoi elle améliorerait le jeu')),
    );
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (action === 'new') return openModal(i, newModal());
  if (action === 'submit' && i.isModalSubmit()) {
    const target = channelId('suggestions');
    if (!target) return fail(i, 'Le salon des suggestions n’est pas configuré.');
    const wait = hitCooldown(`sug:${i.user.id}`, getSetting('suggestions.cooldownSeconds') * 1000);
    if (wait) return fail(i, `Merci d’attendre ${Math.ceil(wait / 1000)} s avant de proposer une nouvelle idée.`);
    await deferEphemeral(i);
    const id = suggestions.create(i.user.id, i.fields.getTextInputValue('title').trim(), i.fields.getTextInputValue('content').trim());
    const s = suggestions.get(id)!;
    const loc = await upsertMessage(target, {}, suggestionPayload(s));
    let threadId: string | null = null;
    if (getSetting('suggestions.createThread')) {
      const msg = await fetchMessage(loc.channelId, loc.messageId);
      const thread = await msg?.startThread({ name: truncate(`💬 ${s.title}`, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }).catch(() => null);
      threadId = thread?.id ?? null;
    }
    suggestions.setMessage(id, loc.channelId, loc.messageId, threadId);
    await audit({ type: 'community', action: 'suggestion_create', actorId: i.user.id, target: `Suggestion n°${id}`, message: `Nouvelle suggestion : « ${s.title} ».` });
    return ephemeral(i, `Merci ! Ta suggestion a été publiée dans <#${loc.channelId}>.`);
  }

  const s = suggestions.get(Number(args[0]));
  if (!s) return fail(i, 'Suggestion introuvable.');
  switch (action) {
    case 'up':
    case 'down': {
      if (!i.isButton()) return;
      const res = await withLock(`sugvote:${s.id}`, async () => suggestions.vote(s.id, i.user.id, action === 'up' ? 1 : -1));
      await i.update(suggestionPayload(suggestions.get(s.id)!));
      const msg = res === 'removed' ? 'Ton vote a été retiré.' : res === 'changed' ? 'Ton vote a été modifié.' : 'Ton vote est enregistré.';
      return i.followUp({ embeds: [infoEmbed(msg)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    case 'manage': {
      if (!(await requireFeature(i, 'suggestions.manage'))) return;
      const select = new StringSelectMenuBuilder()
        .setCustomId(cid('sug', 'status', s.id))
        .setPlaceholder('Changer le statut…')
        .addOptions(Object.entries(SUGGESTION_STATUS).map(([value, x]) => ({ label: x.label, value, emoji: x.emoji, default: value === s.status })));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid('sug', 'respond', s.id)).setLabel('Répondre / changer le statut avec un message').setEmoji('💬').setStyle(ButtonStyle.Primary),
      );
      return ephemeral(i, { embeds: [infoEmbed(`Gestion de la suggestion **n°${s.id} — ${s.title}**`)], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), row] });
    }
    case 'status': {
      if (!i.isStringSelectMenu() || !(await requireFeature(i, 'suggestions.manage'))) return;
      const status = i.values[0];
      if (!isKeyOf(SUGGESTION_STATUS, status)) return fail(i, 'Statut inconnu.');
      await i.deferUpdate();
      await setSuggestionStatus(s.id, status, undefined, i.user.id);
      return i.editReply({ embeds: [infoEmbed(`Statut mis à jour : ${SUGGESTION_STATUS[status].emoji} ${SUGGESTION_STATUS[status].label}`)], components: [] });
    }
    case 'respond': {
      if (!(await requireFeature(i, 'suggestions.manage'))) return;
      return openModal(
        i,
        new ModalBuilder()
          .setCustomId(cid('sug', 'respondsubmit', s.id))
          .setTitle(`Suggestion n°${s.id}`)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Statut')
              .setStringSelectMenuComponent(
                new StringSelectMenuBuilder().setCustomId('status').setRequired(true).addOptions(Object.entries(SUGGESTION_STATUS).map(([value, x]) => ({ label: x.label, value, emoji: x.emoji, default: value === s.status }))),
              ),
            new LabelBuilder().setLabel('Réponse du staff').setTextInputComponent(new TextInputBuilder().setCustomId('response').setStyle(TextInputStyle.Paragraph).setMaxLength(900).setRequired(true).setValue(s.staff_response ?? '')),
          ),
      );
    }
    case 'respondsubmit': {
      if (!i.isModalSubmit() || !(await requireFeature(i, 'suggestions.manage'))) return;
      const status = i.fields.getStringSelectValues('status')[0];
      if (!isKeyOf(SUGGESTION_STATUS, status)) return fail(i, 'Statut inconnu.');
      await deferEphemeral(i);
      await setSuggestionStatus(s.id, status, i.fields.getTextInputValue('response').trim(), i.user.id);
      return ephemeral(i, 'Réponse publiée sous la suggestion.');
    }
  }
}

export const suggestionsModule: BotModule = {
  name: 'suggestions',
  components: [{ prefix: 'sug', handle }],
  commands: [
    {
      data: new SlashCommandBuilder().setName('suggestion').setDescription('Proposer une idée pour améliorer RBKS PVP'),
      category: '💬 Communauté',
      help: [{ usage: '/suggestion', description: 'Proposer une idée (vote de la communauté)' }],
      execute: (i) => openModal(i, newModal()),
    },
  ],
};

