import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
} from 'discord.js';
import { BUG_STATUS, PLATFORMS, isKeyOf, statusOptions, type BugStatus } from '../../config/constants';
import { db, parseJson } from '../../db';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, infoEmbed } from '../../bot/ui/embeds';
import { fetchMessage, fetchTextChannel } from '../../bot/messages';
import { publishPanel } from '../../bot/panels';
import { channelId } from '../../core/resources';
import { getSetting } from '../../core/settings';
import { hitCooldown } from '../../core/guards';
import { discordTs } from '../../core/time';
import { sanitizeMentions, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';
import { progress } from '../../core/progress';

const log = childLogger('bugs');

export interface Bug {
  id: number;
  user_id: string;
  title: string;
  description: string;
  steps: string;
  platform: string;
  attachments: string;
  status: BugStatus;
  assignee_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface BugEvent {
  id: number;
  bug_id: number;
  actor_id: string | null;
  action: string;
  content: string | null;
  internal: number;
  created_at: number;
}

export const bugs = {
  get: (id: number) => db().prepare('SELECT * FROM bugs WHERE id = ?').get(id) as Bug | undefined,
  list(status?: string, limit = 50, offset = 0): { rows: Bug[]; total: number } {
    const where = status === 'open' ? "WHERE status IN ('new','acknowledged','in_progress')" : status ? 'WHERE status = ?' : '';
    const params = status && status !== 'open' ? [status] : [];
    const rows = db().prepare(`SELECT * FROM bugs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Bug[];
    const total = (db().prepare(`SELECT COUNT(*) n FROM bugs ${where}`).get(...params) as { n: number }).n;
    return { rows, total };
  },
  create(b: { userId: string; title: string; description: string; steps: string; platform: string; attachments: string[] }): number {
    const t = Date.now();
    return Number(
      db()
        .prepare('INSERT INTO bugs (user_id, title, description, steps, platform, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(b.userId, b.title, b.description, b.steps, b.platform, JSON.stringify(b.attachments), t, t).lastInsertRowid,
    );
  },
  setMessage: (id: number, ch: string, msg: string) => db().prepare('UPDATE bugs SET channel_id = ?, message_id = ? WHERE id = ?').run(ch, msg, id),
  setStatus: (id: number, status: BugStatus) => db().prepare('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id),
  assign: (id: number, userId: string | null) => db().prepare('UPDATE bugs SET assignee_id = ?, updated_at = ? WHERE id = ?').run(userId, Date.now(), id),
  addEvent: (id: number, actorId: string | null, action: string, content: string | null, internal = false) =>
    db().prepare('INSERT INTO bug_events (bug_id, actor_id, action, content, internal, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, actorId, action, content, internal ? 1 : 0, Date.now()),
  events: (id: number) => db().prepare('SELECT * FROM bug_events WHERE bug_id = ? ORDER BY id').all(id) as BugEvent[],
};

export const attachmentsOf = (b: Bug) => parseJson<string[]>(b.attachments, []);

export function bugPayload(b: Bug) {
  const st = BUG_STATUS[b.status];
  const e = brandEmbed({ title: `🐞 ${b.title}`, description: truncate(sanitizeMentions(b.description), 2000), color: st.color, footerExtra: `Bug n°${b.id}` });
  if (b.steps) e.addFields({ name: 'Étapes pour reproduire', value: truncate(sanitizeMentions(b.steps), 1024) });
  e.addFields(
    { name: 'Signalé par', value: `<@${b.user_id}>`, inline: true },
    { name: 'Plateforme', value: b.platform, inline: true },
    { name: 'Statut', value: `${st.emoji} ${st.label}`, inline: true },
    { name: 'Pris en charge par', value: b.assignee_id ? `<@${b.assignee_id}>` : '—', inline: true },
    { name: 'Signalé', value: discordTs(b.created_at, 'R'), inline: true },
  );
  const closed = ['resolved', 'closed', 'not_reproducible'].includes(b.status);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('bug', 'claim', b.id)).setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary).setDisabled(closed || !!b.assignee_id),
    new ButtonBuilder().setCustomId(cid('bug', 'manage', b.id)).setLabel('Statut').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('bug', 'note', b.id)).setLabel('Note interne').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('bug', 'history', b.id)).setLabel('Historique').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('bug', 'resolve', b.id)).setLabel('Résolu').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(closed),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] as [] } };
}

export async function refreshBug(id: number): Promise<void> {
  const b = bugs.get(id);
  if (!b?.message_id) return;
  const msg = await fetchMessage(b.channel_id, b.message_id);
  await msg?.edit(bugPayload(b)).catch((e) => log.warn({ err: e }, 'Mise à jour du bug impossible'));
}

export async function setBugStatus(id: number, status: BugStatus, actorId: string, comment?: string | null): Promise<void> {
  const b = bugs.get(id);
  if (!b) throw new Error('Bug introuvable');
  bugs.setStatus(id, status);
  if (status === 'resolved') progress(b.user_id);
  if (status === 'acknowledged' && !b.assignee_id) bugs.assign(id, actorId);
  bugs.addEvent(id, actorId, 'status', `${BUG_STATUS[b.status].label} → ${BUG_STATUS[status].label}${comment ? ` : ${comment}` : ''}`);
  await refreshBug(id);
  await audit({ type: 'community', action: 'bug_status', actorId, target: `Bug n°${id}`, message: `Bug « ${b.title} » → ${BUG_STATUS[status].label}.`, color: BUG_STATUS[status].color });
  if (status === 'resolved' && b.status !== 'resolved') {
    const guild = (await fetchTextChannel(b.channel_id))?.guild;
    const reporter = await guild?.members.fetch(b.user_id).catch(() => null);
    await reporter?.send({ embeds: [brandEmbed({ title: '✅ Bug corrigé', description: `Le bug que tu as signalé, **${b.title}**, a été marqué comme résolu. Merci pour ton aide !` })] }).catch(() => undefined);
  }
}

export async function addBugNote(id: number, actorId: string, content: string): Promise<void> {
  bugs.addEvent(id, actorId, 'note', content, true);
}

export async function publishBugPanel() {
  const e = brandEmbed({
    title: '🐞 Signaler un bug',
    description: 'Tu as trouvé un bug dans RBKS PVP ? Clique sur le bouton ou utilise `/bugreport`.\nDécris le problème, les étapes pour le reproduire et joins une capture si possible. Merci de ne pas partager publiquement les failles exploitables.',
    timestamp: false,
  });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('bug', 'new')).setLabel('Signaler un bug').setEmoji('🐞').setStyle(ButtonStyle.Danger));
  return publishPanel('bugs', 'bugs', { embeds: [e], components: [row] });
}

export function reportModal() {
  return new ModalBuilder()
    .setCustomId(cid('bug', 'submit'))
    .setTitle('Signaler un bug')
    .addLabelComponents(
      new LabelBuilder().setLabel('Titre').setTextInputComponent(new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder('Ex. Le Raiton ne fait pas de dégâts')),
      new LabelBuilder().setLabel('Description du problème').setTextInputComponent(new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)),
      new LabelBuilder().setLabel('Étapes pour reproduire').setTextInputComponent(new TextInputBuilder().setCustomId('steps').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setPlaceholder('1. Lancer un match\n2. Utiliser…')),
      new LabelBuilder()
        .setLabel('Plateforme')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('platform').setRequired(true).addOptions(PLATFORMS.map((p) => ({ label: p, value: p })))),
      new LabelBuilder()
        .setLabel('Capture d’écran ou vidéo (facultatif)')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setRequired(false).setMinValues(0).setMaxValues(3)),
    );
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (action === 'new') return openModal(i, reportModal());
  if (action === 'submit' && i.isModalSubmit()) {
    const target = channelId('bugs');
    if (!target) return fail(i, 'Le salon des bugs n’est pas configuré.');
    const wait = hitCooldown(`bug:${i.user.id}`, getSetting('bugs.cooldownSeconds') * 1000);
    if (wait) return fail(i, `Merci d’attendre ${Math.ceil(wait / 1000)} s avant un nouveau signalement.`);
    await deferEphemeral(i);
    const files: Attachment[] = [...(i.fields.getUploadedFiles('files')?.values() ?? [])].filter((f) => f.size <= 25 * 1024 * 1024);
    const id = bugs.create({
      userId: i.user.id,
      title: i.fields.getTextInputValue('title').trim(),
      description: i.fields.getTextInputValue('description').trim(),
      steps: i.fields.getTextInputValue('steps').trim(),
      platform: i.fields.getStringSelectValues('platform')[0] ?? 'Autre',
      attachments: files.map((f) => f.name),
    });
    const channel = await fetchTextChannel(target);
    if (!channel) return fail(i, 'Salon des bugs inaccessible.');
    // Les pièces jointes sont ré-envoyées par le bot : les liens des fenêtres modales expirent.
    const msg = await channel.send({ ...bugPayload(bugs.get(id)!), files: files.map((f) => ({ attachment: f.url, name: f.name })) });
    bugs.setMessage(id, channel.id, msg.id);
    bugs.addEvent(id, i.user.id, 'created', null);
    await audit({ type: 'community', action: 'bug_create', actorId: i.user.id, target: `Bug n°${id}`, message: `Nouveau bug signalé : « ${bugs.get(id)!.title} ».` });
    return ephemeral(i, `Merci ! Ton signalement **n°${id}** a été transmis à l’équipe.`);
  }

  const b = bugs.get(Number(args[0]));
  if (!b) return fail(i, 'Signalement introuvable.');
  if (!(await requireFeature(i, 'bugs.manage'))) return;
  switch (action) {
    case 'claim': {
      bugs.assign(b.id, i.user.id);
      await setBugStatus(b.id, b.status === 'new' ? 'acknowledged' : b.status, i.user.id);
      return ephemeral(i, 'Tu as pris ce bug en charge.');
    }
    case 'resolve':
      await deferEphemeral(i);
      await setBugStatus(b.id, 'resolved', i.user.id);
      return ephemeral(i, 'Bug marqué comme résolu. Le joueur a été prévenu.');
    case 'manage': {
      const select = new StringSelectMenuBuilder()
        .setCustomId(cid('bug', 'status', b.id))
        .setPlaceholder('Nouveau statut…')
        .addOptions(Object.entries(BUG_STATUS).map(([value, s]) => ({ label: s.label, value, emoji: s.emoji, default: value === b.status })));
      return ephemeral(i, { embeds: [infoEmbed(`Statut du bug **n°${b.id} — ${b.title}**`)], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    }
    case 'status': {
      if (!i.isStringSelectMenu()) return;
      const status = i.values[0];
      if (!isKeyOf(BUG_STATUS, status)) return fail(i, 'Statut inconnu.');
      await i.deferUpdate();
      await setBugStatus(b.id, status, i.user.id);
      return i.editReply({ embeds: [infoEmbed(`Statut : ${BUG_STATUS[status].emoji} ${BUG_STATUS[status].label}`)], components: [] });
    }
    case 'note':
      return openModal(
        i,
        new ModalBuilder()
          .setCustomId(cid('bug', 'notesubmit', b.id))
          .setTitle(`Note interne — bug n°${b.id}`)
          .addLabelComponents(new LabelBuilder().setLabel('Information interne (staff uniquement)').setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500))),
      );
    case 'notesubmit':
      if (!i.isModalSubmit()) return;
      await addBugNote(b.id, i.user.id, i.fields.getTextInputValue('note').trim());
      return ephemeral(i, 'Note interne ajoutée.');
    case 'history':
      return ephemeral(i, historyEmbed(b));
  }
}

function historyEmbed(b: Bug) {
  const events = bugs.events(b.id);
  const label: Record<string, string> = { created: 'Signalé', status: 'Statut', note: '📝 Note interne' };
  return brandEmbed({
    title: `📜 Historique — bug n°${b.id}`,
    description: truncate(events.map((e) => `${discordTs(e.created_at, 'f')} — **${label[e.action] ?? e.action}**${e.actor_id ? ` par <@${e.actor_id}>` : ''}${e.content ? `\n> ${e.content.replace(/\n/g, '\n> ')}` : ''}`).join('\n') || 'Aucun événement.', 4000),
  });
}

export const bugsModule: BotModule = {
  name: 'bugs',
  components: [{ prefix: 'bug', handle }],
  commands: [
    {
      data: new SlashCommandBuilder().setName('bugreport').setDescription('Signaler un bug dans RBKS PVP'),
      category: '💬 Communauté',
      help: [{ usage: '/bugreport', description: 'Signaler un bug (avec capture facultative)' }],
      execute: (i) => openModal(i, reportModal()),
    },
    {
      data: new SlashCommandBuilder()
        .setName('bugs')
        .setDescription('Consulter les signalements de bugs')
        .addSubcommand((s) =>
          s
            .setName('list')
            .setDescription('Lister les bugs')
            .addStringOption((o) => o.setName('statut').setDescription('Filtrer (par défaut : ouverts)').addChoices({ name: '📂 Tous les ouverts', value: 'open' }, ...statusOptions(BUG_STATUS))),
        )
        .addSubcommand((s) => s.setName('view').setDescription('Voir un bug et son historique').addIntegerOption((o) => o.setName('id').setDescription('Numéro du bug').setRequired(true).setMinValue(1))),
      feature: 'bugs.manage',
      category: '💬 Communauté',
      help: [{ usage: '/bugs list|view', description: 'Consulter les bugs et leur historique', feature: 'bugs.manage' }],
      async execute(i) {
        if (i.options.getSubcommand() === 'view') {
          const b = bugs.get(i.options.getInteger('id', true));
          if (!b) return fail(i, 'Bug introuvable.');
          return ephemeral(i, { embeds: [bugPayload(b).embeds[0], historyEmbed(b)], components: bugPayload(b).components });
        }
        const status = i.options.getString('statut') ?? 'open';
        const { rows, total } = bugs.list(status, 25);
        const e = brandEmbed({ title: `🐞 Bugs — ${status === 'open' ? 'ouverts' : BUG_STATUS[status as BugStatus]?.label}`, description: rows.length ? `${total} résultat(s)` : 'Aucun bug. 🎉' });
        for (const b of rows.slice(0, 20)) {
          const st = BUG_STATUS[b.status];
          e.addFields({ name: `#${b.id} ${st.emoji} ${truncate(b.title, 80)}`, value: `${st.label} • ${b.platform} • ${discordTs(b.created_at, 'R')}${b.assignee_id ? ` • <@${b.assignee_id}>` : ''}${b.message_id ? ` • [message](https://discord.com/channels/${i.guildId}/${b.channel_id}/${b.message_id})` : ''}` });
        }
        return ephemeral(i, e);
      },
    },
  ],
};
