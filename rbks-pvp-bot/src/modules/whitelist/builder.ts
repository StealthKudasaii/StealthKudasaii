import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { QUESTION_TYPES, type QuestionType } from '../../config/constants';
import type { ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { brandEmbed, errorEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { ephemeral, fail, fromEphemeralMessage, openModal, requireFeature } from '../../bot/reply';
import { channelId, roleId } from '../../core/resources';
import { discordTs, parseDate, toFrInput } from '../../core/time';
import { isHttpUrl, truncate } from '../../core/text';
import { audit } from '../logs/audit';
import { applications, choicesOf, forms, questions, reviewerRoles, type Form, type Question } from './forms.repo';
import { BETA_TEMPLATE, FORM_STATE_LABEL, LIMITS, MAX_QUESTIONS, formState, pages, parseQuestionInput } from './forms.logic';
import { buildPageModal, formPublicPayload, publishForm, scheduleFormRefresh } from './forms.service';

const P = 'wlb';

// ───────────── Vue principale de l'assistant ─────────────

export function builderPayload(f: Form, notice?: string) {
  const qs = questions.list(f.id);
  const state = formState(f, applications.countForForm(f.id));
  const roles = reviewerRoles(f);
  const e = brandEmbed({
    title: `🛠️ Assistant de formulaire — ${f.name}`,
    description: `${notice ? `${notice}\n\n` : ''}**${f.title}**\n${truncate(f.description || '*Pas de description*', 600)}`,
    timestamp: false,
  });
  if (f.banner_url) e.setThumbnail(f.banner_url);
  e.addFields(
    { name: 'Statut', value: FORM_STATE_LABEL[state], inline: true },
    { name: 'Bouton', value: f.button_label, inline: true },
    { name: 'Candidatures', value: `${applications.countForForm(f.id)}${f.max_applications ? ` / ${f.max_applications}` : ''}`, inline: true },
    { name: 'Publication', value: f.publish_channel_id ? `<#${f.publish_channel_id}>` : '⚠️ à définir', inline: true },
    { name: 'Réception', value: f.review_channel_id ? `<#${f.review_channel_id}>` : '⚠️ à définir', inline: true },
    { name: 'Rôle accordé', value: f.accepted_role_id ? `<@&${f.accepted_role_id}>` : 'aucun', inline: true },
    { name: 'Examinateurs', value: roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : 'rôles « Examiner les candidatures »', inline: true },
    { name: 'Dates', value: `${f.opens_at ? `Ouverture ${discordTs(f.opens_at, 'f')}` : 'Ouverture immédiate'}\n${f.closes_at ? `Clôture ${discordTs(f.closes_at, 'f')}` : 'Pas de clôture'}`, inline: true },
    { name: 'Nouvelle tentative', value: f.reapply_days ? `après ${f.reapply_days} j` : 'immédiate', inline: true },
  );
  const pageCount = pages(qs).length;
  e.addFields({
    name: `Questions (${qs.length}/${MAX_QUESTIONS})${pageCount > 1 ? ` • ${pageCount} étapes` : ''}`,
    value: qs.length
      ? truncate(qs.map((q, i) => `\`${i + 1}.\` ${QUESTION_TYPES[q.type].emoji} ${q.label}${q.required ? ' *' : ''}`).join('\n'), 1024)
      : 'Aucune question. Ajoute-en avec le menu ci-dessous ou utilise le modèle bêta.',
  });

  const rows: ActionRowBuilder<any>[] = [];
  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(cid(P, 'addq', f.id))
        .setPlaceholder('➕ Ajouter une question…')
        .setDisabled(qs.length >= MAX_QUESTIONS)
        .addOptions(Object.entries(QUESTION_TYPES).map(([value, t]) => ({ label: t.label, value, emoji: t.emoji }))),
    ),
  );
  if (qs.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid(P, 'pickq', f.id))
          .setPlaceholder('✏️ Modifier, déplacer ou supprimer une question…')
          .addOptions(qs.slice(0, 25).map((q, i) => ({ label: truncate(`${i + 1}. ${q.label}`, 100), value: String(q.id), emoji: QUESTION_TYPES[q.type].emoji }))),
      ),
    );
  }
  const config = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid(P, 'info', f.id)).setLabel('Infos').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid(P, 'channels', f.id)).setLabel('Salons & rôles').setEmoji('📡').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid(P, 'settings', f.id)).setLabel('Paramètres').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  if (!qs.length) config.addComponents(new ButtonBuilder().setCustomId(cid(P, 'template', f.id)).setLabel('Modèle bêta').setEmoji('📋').setStyle(ButtonStyle.Secondary));
  rows.push(config);
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid(P, 'preview', f.id)).setLabel('Aperçu').setEmoji('👁️').setStyle(ButtonStyle.Secondary).setDisabled(!qs.length),
      new ButtonBuilder().setCustomId(cid(P, 'publish', f.id)).setLabel(f.message_id ? 'Mettre à jour la publication' : 'Publier').setEmoji('🚀').setStyle(ButtonStyle.Success).setDisabled(!qs.length),
      new ButtonBuilder()
        .setCustomId(cid(P, 'toggle', f.id))
        .setLabel(f.status === 'open' ? 'Fermer' : 'Ouvrir')
        .setEmoji(f.status === 'open' ? '🔒' : '🔓')
        .setStyle(f.status === 'open' ? ButtonStyle.Danger : ButtonStyle.Primary)
        .setDisabled(f.status === 'draft'),
      new ButtonBuilder().setCustomId(cid(P, 'back', f.id)).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [e], components: rows };
}

export function questionPayload(q: Question) {
  const t = QUESTION_TYPES[q.type];
  const e = brandEmbed({ title: `${t.emoji} Question n°${q.position}`, description: `**${q.label}**${q.description ? `\n${q.description}` : ''}`, timestamp: false }).addFields(
    { name: 'Type', value: t.label, inline: true },
    { name: 'Obligatoire', value: q.required ? 'Oui' : 'Non', inline: true },
    { name: 'Texte indicatif', value: q.placeholder || '—', inline: true },
  );
  if (q.type === 'single' || q.type === 'multi') e.addFields({ name: 'Choix', value: truncate(choicesOf(q).map((c) => `• ${c}`).join('\n'), 1024) });
  if (q.type === 'number') e.addFields({ name: 'Plage', value: `${q.min_value ?? '…'} à ${q.max_value ?? '…'}`, inline: true });
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(P, 'editq', q.id)).setLabel('Modifier').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid(P, 'up', q.id)).setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid(P, 'down', q.id)).setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid(P, 'delq', q.id)).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid(P, 'back', q.form_id)).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid(P, 'qtype', q.id))
          .setPlaceholder('Changer le type de question…')
          .addOptions(Object.entries(QUESTION_TYPES).map(([value, x]) => ({ label: x.label, value, emoji: x.emoji, default: value === q.type }))),
      ),
    ],
  };
}

// ───────────── Fenêtres modales de configuration ─────────────

const text = (id: string, style: TextInputStyle, opts: { required?: boolean; max?: number; value?: string | null; placeholder?: string } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(opts.required ?? false);
  if (opts.max) t.setMaxLength(opts.max);
  if (opts.value) t.setValue(opts.value.slice(0, opts.max ?? 4000));
  if (opts.placeholder) t.setPlaceholder(opts.placeholder);
  return t;
};

export function infoModal(f?: Form) {
  return new ModalBuilder()
    .setCustomId(f ? cid(P, 'infosave', f.id) : cid(P, 'create'))
    .setTitle(f ? 'Informations du formulaire' : 'Nouveau formulaire')
    .addLabelComponents(
      new LabelBuilder().setLabel('Nom interne').setDescription('Identifiant court, ex. beta-1').setTextInputComponent(text('name', TextInputStyle.Short, { required: true, max: 40, value: f?.name })),
      new LabelBuilder().setLabel('Titre affiché').setTextInputComponent(text('title', TextInputStyle.Short, { required: true, max: 200, value: f?.title, placeholder: 'RBKS PVP — Candidature Bêta-Test' })),
      new LabelBuilder().setLabel('Description').setTextInputComponent(text('description', TextInputStyle.Paragraph, { max: 2000, value: f?.description })),
      new LabelBuilder().setLabel('Texte du bouton').setTextInputComponent(text('button', TextInputStyle.Short, { required: true, max: 80, value: f?.button_label ?? 'Postuler à la bêta' })),
      new LabelBuilder().setLabel('Bannière (URL d’image, facultatif)').setTextInputComponent(text('banner', TextInputStyle.Short, { max: 500, value: f?.banner_url, placeholder: 'https://…' })),
    );
}

export function channelsModal(f: Form) {
  const publish = new ChannelSelectMenuBuilder().setCustomId('publish').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false).setMinValues(0).setMaxValues(1);
  if (f.publish_channel_id) publish.setDefaultChannels(f.publish_channel_id);
  const review = new ChannelSelectMenuBuilder().setCustomId('review').setChannelTypes(ChannelType.GuildText).setRequired(false).setMinValues(0).setMaxValues(1);
  if (f.review_channel_id) review.setDefaultChannels(f.review_channel_id);
  const reviewers = new RoleSelectMenuBuilder().setCustomId('reviewers').setRequired(false).setMinValues(0).setMaxValues(10);
  const current = reviewerRoles(f);
  if (current.length) reviewers.setDefaultRoles(...current);
  const accepted = new RoleSelectMenuBuilder().setCustomId('accepted').setRequired(false).setMinValues(0).setMaxValues(1);
  if (f.accepted_role_id) accepted.setDefaultRoles(f.accepted_role_id);
  return new ModalBuilder()
    .setCustomId(cid(P, 'chsave', f.id))
    .setTitle('Salons et rôles')
    .addLabelComponents(
      new LabelBuilder().setLabel('Salon de publication').setDescription('Où les joueurs verront le formulaire').setChannelSelectMenuComponent(publish),
      new LabelBuilder().setLabel('Salon de réception (privé)').setDescription('Où le staff reçoit les candidatures').setChannelSelectMenuComponent(review),
      new LabelBuilder().setLabel('Rôles examinateurs').setDescription('En plus des rôles « Examiner les candidatures »').setRoleSelectMenuComponent(reviewers),
      new LabelBuilder().setLabel('Rôle attribué après acceptation').setDescription('Ex. 🧪 Testeur').setRoleSelectMenuComponent(accepted),
    );
}

export function settingsModal(f: Form) {
  return new ModalBuilder()
    .setCustomId(cid(P, 'setsave', f.id))
    .setTitle('Paramètres du formulaire')
    .addLabelComponents(
      new LabelBuilder().setLabel('Nombre maximal de candidatures').setDescription('Vide = illimité').setTextInputComponent(text('max', TextInputStyle.Short, { max: 6, value: f.max_applications ? String(f.max_applications) : '' })),
      new LabelBuilder().setLabel('Date d’ouverture (facultatif)').setDescription('JJ/MM/AAAA HH:MM').setTextInputComponent(text('opens', TextInputStyle.Short, { max: 20, value: toFrInput(f.opens_at), placeholder: '01/12/2026 18:00' })),
      new LabelBuilder().setLabel('Date de clôture (facultatif)').setDescription('JJ/MM/AAAA HH:MM').setTextInputComponent(text('closes', TextInputStyle.Short, { max: 20, value: toFrInput(f.closes_at), placeholder: '15/12/2026 23:59' })),
      new LabelBuilder().setLabel('Délai avant nouvelle candidature (jours)').setDescription('Après un refus. 0 = immédiat').setTextInputComponent(text('reapply', TextInputStyle.Short, { max: 3, value: String(f.reapply_days) })),
      new LabelBuilder()
        .setLabel('Prévenir le candidat en MP ?')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId('dm').setRequired(true).addOptions(
            { label: 'Oui, à chaque décision', value: '1', default: !!f.dm_on_decision },
            { label: 'Non', value: '0', default: !f.dm_on_decision },
          ),
        ),
    );
}

export function questionModal(formId: number, type: QuestionType, q?: Question) {
  const modal = new ModalBuilder()
    .setCustomId(q ? cid(P, 'qsave', formId, type, q.id) : cid(P, 'qsave', formId, type))
    .setTitle(truncate(`${q ? 'Modifier' : 'Nouvelle'} question — ${QUESTION_TYPES[type].label}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Intitulé').setDescription(`${LIMITS.label} caractères max (limite Discord)`).setTextInputComponent(text('label', TextInputStyle.Short, { required: true, max: LIMITS.label, value: q?.label })),
      new LabelBuilder().setLabel('Description (facultatif)').setTextInputComponent(text('description', TextInputStyle.Short, { max: LIMITS.description, value: q?.description })),
      new LabelBuilder()
        .setLabel('Réponse obligatoire ?')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId('required').setRequired(true).addOptions(
            { label: 'Oui', value: '1', default: q ? !!q.required : true },
            { label: 'Non', value: '0', default: q ? !q.required : false },
          ),
        ),
    );
  if (type === 'single' || type === 'multi') {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Choix possibles (un par ligne)')
        .setDescription('2 à 25 choix')
        .setTextInputComponent(text('choices', TextInputStyle.Paragraph, { required: true, max: 2600, value: q ? choicesOf(q).join('\n') : '' })),
    );
  }
  if (type === 'number') {
    modal.addLabelComponents(
      new LabelBuilder().setLabel('Plage autorisée (facultatif)').setDescription('Format min-max, ex. 0-100').setTextInputComponent(text('range', TextInputStyle.Short, { max: 30, value: q && (q.min_value !== null || q.max_value !== null) ? `${q.min_value ?? ''}-${q.max_value ?? ''}` : '' })),
    );
  }
  modal.addLabelComponents(new LabelBuilder().setLabel('Texte indicatif (facultatif)').setTextInputComponent(text('placeholder', TextInputStyle.Short, { max: LIMITS.placeholder, value: q?.placeholder })));
  return modal;
}

// ───────────── Gestion des interactions de l'assistant ─────────────

async function showBuilder(i: ComponentInteraction, f: Form, notice?: string) {
  const payload = builderPayload(f, notice);
  if (!fromEphemeralMessage(i)) return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
  if (i.isModalSubmit() && i.isFromMessage()) return i.update(payload);
  if (i.isMessageComponent()) return i.update(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function readInfo(i: { fields: { getTextInputValue(id: string): string } }) {
  const banner = i.fields.getTextInputValue('banner').trim();
  return {
    name: i.fields.getTextInputValue('name').trim(),
    title: i.fields.getTextInputValue('title').trim(),
    description: i.fields.getTextInputValue('description').trim(),
    button_label: i.fields.getTextInputValue('button').trim(),
    banner_url: banner || null,
  };
}

export async function handleBuilder(i: ComponentInteraction, action: string, args: string[]) {
  if (!(await requireFeature(i, 'whitelist.manage'))) return;

  if (action === 'create') {
    if (!i.isModalSubmit()) return;
    const info = readInfo(i);
    if (info.banner_url && !isHttpUrl(info.banner_url)) return fail(i, 'La bannière doit être une URL http(s) valide.');
    if (forms.byName(info.name)) return fail(i, `Un formulaire nommé « ${info.name} » existe déjà. Utilise /wledit.`);
    const id = forms.create({ ...info, review_channel_id: channelId('applications'), accepted_role_id: roleId('tester'), created_by: i.user.id });
    await audit({ type: 'applications', action: 'form_create', actorId: i.user.id, target: info.name, message: `Formulaire « ${info.title} » créé.` });
    return showBuilder(i, forms.get(id)!, '✅ Formulaire créé. Ajoute maintenant tes questions, puis publie-le.');
  }

  // Les actions sur une question portent l'id de la question, les autres l'id du formulaire.
  const questionActions = ['editq', 'up', 'down', 'delq', 'delqok', 'qtype'];
  let q: Question | undefined;
  let f: Form | undefined;
  if (questionActions.includes(action)) {
    q = questions.get(Number(args[0]));
    if (!q) return fail(i, 'Question introuvable (déjà supprimée ?).');
    f = forms.get(q.form_id);
  } else {
    f = forms.get(Number(args[0]));
  }
  if (!f) return fail(i, 'Formulaire introuvable.');

  switch (action) {
    case 'back':
      return showBuilder(i, f);
    case 'info':
      return openModal(i, infoModal(f));
    case 'infosave': {
      if (!i.isModalSubmit()) return;
      const info = readInfo(i);
      if (info.banner_url && !isHttpUrl(info.banner_url)) return fail(i, 'La bannière doit être une URL http(s) valide.');
      const other = forms.byName(info.name);
      if (other && other.id !== f.id) return fail(i, `Le nom « ${info.name} » est déjà utilisé.`);
      forms.update(f.id, info);
      scheduleFormRefresh(f.id);
      return showBuilder(i, forms.get(f.id)!, '✅ Informations enregistrées.');
    }
    case 'channels':
      return openModal(i, channelsModal(f));
    case 'chsave': {
      if (!i.isModalSubmit()) return;
      const publish = i.fields.getSelectedChannels('publish')?.first()?.id ?? null;
      const review = i.fields.getSelectedChannels('review')?.first()?.id ?? null;
      const reviewers = [...(i.fields.getSelectedRoles('reviewers')?.keys() ?? [])];
      const accepted = i.fields.getSelectedRoles('accepted')?.first();
      const me = i.guild.members.me!;
      if (accepted && accepted.position >= me.roles.highest.position) return fail(i, `Le rôle ${accepted.name} est au-dessus du bot : il ne pourra pas l’attribuer. Choisis un rôle plus bas ou remonte le rôle du bot.`);
      if (accepted && (accepted.managed || accepted.id === i.guild.id)) return fail(i, 'Ce rôle ne peut pas être attribué.');
      if (accepted && accepted.id === roleId('founder')) return fail(i, 'Le rôle Fondateur ne peut jamais être attribué automatiquement.');
      forms.update(f.id, { publish_channel_id: publish, review_channel_id: review, reviewer_role_ids: reviewers, accepted_role_id: accepted?.id ?? null });
      if (f.message_id && publish !== f.publish_channel_id) await publishForm(f.id).catch(() => undefined);
      return showBuilder(i, forms.get(f.id)!, '✅ Salons et rôles enregistrés.');
    }
    case 'settings':
      return openModal(i, settingsModal(f));
    case 'setsave': {
      if (!i.isModalSubmit()) return;
      const maxRaw = i.fields.getTextInputValue('max').trim();
      const max = maxRaw ? Number(maxRaw) : null;
      if (max !== null && (!Number.isInteger(max) || max < 1)) return fail(i, 'Le nombre maximal doit être un entier positif.');
      const parseOpt = (v: string) => (v.trim() ? parseDate(v) : null);
      const opensRaw = i.fields.getTextInputValue('opens');
      const closesRaw = i.fields.getTextInputValue('closes');
      const opens = parseOpt(opensRaw);
      const closes = parseOpt(closesRaw);
      if (opensRaw.trim() && opens === null) return fail(i, 'Date d’ouverture invalide. Format attendu : JJ/MM/AAAA HH:MM');
      if (closesRaw.trim() && closes === null) return fail(i, 'Date de clôture invalide. Format attendu : JJ/MM/AAAA HH:MM');
      if (opens && closes && closes <= opens) return fail(i, 'La clôture doit être après l’ouverture.');
      const reapply = Number(i.fields.getTextInputValue('reapply').trim() || '0');
      if (!Number.isInteger(reapply) || reapply < 0 || reapply > 365) return fail(i, 'Le délai doit être un nombre de jours entre 0 et 365.');
      forms.update(f.id, { max_applications: max, opens_at: opens, closes_at: closes, reapply_days: reapply, dm_on_decision: i.fields.getStringSelectValues('dm')[0] === '1' ? 1 : 0 });
      scheduleFormRefresh(f.id);
      return showBuilder(i, forms.get(f.id)!, '✅ Paramètres enregistrés.');
    }
    case 'template': {
      if (questions.count(f.id)) return showBuilder(i, f, '⚠️ Le modèle ne s’applique qu’à un formulaire sans question.');
      for (const t of BETA_TEMPLATE) questions.create(f.id, t);
      return showBuilder(i, forms.get(f.id)!, '✅ Modèle bêta ajouté. Modifie librement chaque question.');
    }
    case 'addq': {
      if (!i.isStringSelectMenu()) return;
      if (questions.count(f.id) >= MAX_QUESTIONS) return fail(i, `${MAX_QUESTIONS} questions maximum.`);
      return openModal(i, questionModal(f.id, i.values[0] as QuestionType));
    }
    case 'qsave': {
      if (!i.isModalSubmit()) return;
      const type = args[1] as QuestionType;
      const editingId = args[2] ? Number(args[2]) : null;
      const val = (id: string) => {
        try {
          return i.fields.getTextInputValue(id);
        } catch {
          return undefined;
        }
      };
      const parsed = parseQuestionInput({
        label: val('label') ?? '',
        description: val('description'),
        type,
        required: i.fields.getStringSelectValues('required')[0] !== '0',
        choices: val('choices'),
        placeholder: val('placeholder'),
        range: val('range'),
      });
      if (!parsed.ok) return fail(i, parsed.error);
      if (editingId) {
        if (!questions.get(editingId)) return fail(i, 'Question introuvable.');
        questions.update(editingId, parsed.value);
        return i.isFromMessage() && fromEphemeralMessage(i) ? i.update(questionPayload(questions.get(editingId)!)) : showBuilder(i, f);
      }
      if (questions.count(f.id) >= MAX_QUESTIONS) return fail(i, `${MAX_QUESTIONS} questions maximum.`);
      questions.create(f.id, parsed.value);
      return showBuilder(i, forms.get(f.id)!, '✅ Question ajoutée.');
    }
    case 'pickq': {
      if (!i.isStringSelectMenu()) return;
      const picked = questions.get(Number(i.values[0]));
      if (!picked) return showBuilder(i, f);
      return i.update(questionPayload(picked));
    }
    case 'editq':
      return openModal(i, questionModal(f.id, q!.type, q));
    case 'qtype': {
      if (!i.isStringSelectMenu()) return;
      const type = i.values[0] as QuestionType;
      const needsChoices = (type === 'single' || type === 'multi') && choicesOf(q!).length < 2;
      if (needsChoices) return openModal(i, questionModal(f.id, type, { ...q!, type }));
      questions.update(q!.id, { ...q!, type, required: !!q!.required, choices: choicesOf(q!) });
      return i.update(questionPayload(questions.get(q!.id)!));
    }
    case 'up':
    case 'down':
      questions.move(q!.id, action === 'up' ? -1 : 1);
      return i.isMessageComponent() ? i.update(questionPayload(questions.get(q!.id)!)) : undefined;
    case 'delq': {
      if (!i.isMessageComponent()) return;
      return i.update({
        embeds: [warnEmbed(`Supprimer la question « ${q!.label} » ? Les candidatures déjà reçues conservent leurs réponses.`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid(P, 'delqok', q!.id)).setLabel('Supprimer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cid(P, 'back', f.id)).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    case 'delqok':
      questions.remove(q!.id);
      return showBuilder(i, forms.get(f.id)!, '🗑️ Question supprimée.');
    case 'preview': {
      const qs = questions.list(f.id);
      if (!qs.length) return fail(i, 'Aucune question.');
      const { state: _s, ...pub } = formPublicPayload(f);
      const pg = pages(qs);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(P, 'previewmodal', f.id)).setLabel(`Tester l’étape 1/${pg.length}`).setEmoji('🧪').setStyle(ButtonStyle.Primary),
      );
      return ephemeral(i, { embeds: [...pub.embeds, successEmbed(`Aperçu : le formulaire comporte ${qs.length} question(s) en ${pg.length} étape(s). Le bouton ci-dessous ouvre la première fenêtre sans rien enregistrer.`)], components: [row] });
    }
    case 'previewmodal': {
      const qs = questions.list(f.id);
      const pg = pages(qs);
      const modal = buildPageModal(f, pg[0], 0, pg.length, {}).setCustomId(cid(P, 'previewdone', f.id));
      return openModal(i, modal);
    }
    case 'previewdone':
      return ephemeral(i, successEmbed('Aperçu terminé : rien n’a été enregistré.'));
    case 'publish': {
      if (i.isMessageComponent()) await i.deferUpdate();
      try {
        const loc = await publishForm(f.id);
        await audit({ type: 'applications', action: 'form_publish', actorId: i.user.id, target: f.name, message: `Formulaire « ${f.title} » publié dans <#${loc.channelId}>.` });
        return i.editReply(builderPayload(forms.get(f.id)!, `🚀 Publié dans <#${loc.channelId}>.`));
      } catch (e) {
        return i.editReply(builderPayload(forms.get(f.id)!, `⛔ ${(e as Error).message}`));
      }
    }
    case 'toggle': {
      const status = f.status === 'open' ? 'closed' : 'open';
      forms.update(f.id, { status });
      scheduleFormRefresh(f.id);
      await audit({ type: 'applications', action: `form_${status}`, actorId: i.user.id, target: f.name, message: `Formulaire « ${f.title} » ${status === 'open' ? 'ouvert' : 'fermé'}.` });
      return showBuilder(i, forms.get(f.id)!, status === 'open' ? '🔓 Candidatures ouvertes.' : '🔒 Candidatures fermées.');
    }
  }
  return ephemeral(i, errorEmbed('Action inconnue.'));
}
