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
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { APPLICATION_STATUS, statusOptions } from '../../config/constants';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, fromEphemeralMessage, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, errorEmbed, infoEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { can } from '../../core/permissions';
import { discordTs, formatDate } from '../../core/time';
import { truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { applications, drafts, forms, questions, reviewerRoles, type Form } from './forms.repo';
import { FORM_STATE_LABEL, formState, pages } from './forms.logic';
import {
  addApplicationNote,
  buildPageModal,
  canApply,
  decide,
  readPageValues,
  reviewButtons,
  reviewEmbed,
  scheduleFormRefresh,
  statsSummary,
  submitPage,
  unpublishForm,
} from './forms.service';
import { builderPayload, handleBuilder, infoModal } from './builder';

// ───────────── Parcours du candidat ─────────────

async function handleApply(i: ComponentInteraction, action: string, args: string[]) {
  const f = forms.get(Number(args[0]));
  if (!f) return fail(i, 'Ce formulaire n’existe plus.');
  const qs = questions.list(f.id);
  const pgs = pages(qs);
  const pageIndex = Number(args[1] ?? 0);

  switch (action) {
    case 'start':
    case 'next':
    case 'retry': {
      const blocked = canApply(f, i.member);
      if (blocked) return fail(i, blocked);
      if (!pgs.length) return fail(i, 'Ce formulaire n’a pas encore de questions.');
      const idx = action === 'start' ? 0 : Math.min(pageIndex, pgs.length - 1);
      return openModal(i, buildPageModal(f, pgs[idx], idx, pgs.length, drafts.get(i.user.id, f.id)));
    }
    case 'page': {
      if (!i.isModalSubmit()) return;
      const page = pgs[pageIndex];
      if (!page) return fail(i, 'Le formulaire a changé entre-temps : recommence ta candidature.');
      const values = readPageValues(i.fields, page);
      // Soumission finale : la création peut prendre un peu de temps (recherche Roblox, envoi au staff).
      const isLast = pageIndex === pgs.length - 1;
      const replaceable = i.isFromMessage() && fromEphemeralMessage(i);
      if (isLast) {
        if (replaceable) await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
      }
      const res = await submitPage(f, i.member, pageIndex, values);
      const respond = async (payload: { embeds: any[]; components: any[] }) => {
        if (i.deferred || i.replied) return i.editReply(payload);
        if (replaceable && i.isFromMessage()) return i.update(payload);
        return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
      };
      if (res.status === 'error') {
        const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid('wla', 'retry', f.id, pageIndex)).setLabel('Corriger mes réponses').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        );
        return respond({ embeds: [errorEmbed(res.errors!.map((e) => `• ${e}`).join('\n'), 'Quelques réponses sont à corriger')], components: canApply(f, i.member) ? [] : [retry] });
      }
      if (res.status === 'next') {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid('wla', 'next', f.id, res.nextPage!)).setLabel(`Continuer — étape ${res.nextPage! + 1}/${res.totalPages}`).setEmoji('➡️').setStyle(ButtonStyle.Success),
        );
        return respond({ embeds: [successEmbed(`Étape ${pageIndex + 1}/${res.totalPages} enregistrée. Clique sur « Continuer » pour la suite (tes réponses sont gardées 1 heure).`)], components: [row] });
      }
      return respond({
        embeds: [successEmbed(`Ta candidature **n°${res.applicationId}** a bien été envoyée au staff. Tu recevras une réponse en message privé (pense à les autoriser).`, 'Candidature envoyée 🎉')],
        components: [],
      });
    }
  }
}

// ───────────── Examen par le staff ─────────────

async function handleReview(i: ComponentInteraction, action: string, args: string[]) {
  const a = applications.get(Number(args[0]));
  if (!a) return fail(i, 'Candidature introuvable.');
  const f = forms.get(a.form_id);
  if (!(await requireFeature(i, 'whitelist.review', f ? reviewerRoles(f) : []))) return;

  switch (action) {
    case 'accept':
    case 'hold': {
      await deferEphemeral(i);
      const res = await decide(a.id, i.user.id, action === 'accept' ? 'accepted' : 'on_hold', null);
      if (!res.ok) return fail(i, res.error!);
      return ephemeral(i, successEmbed(`Candidature n°${a.id} ${action === 'accept' ? 'acceptée' : 'mise en attente'}.${res.warnings.length ? `\n\n⚠️ ${res.warnings.join('\n⚠️ ')}` : ''}`));
    }
    case 'refuse':
      if (a.status === 'accepted' || a.status === 'refused') return fail(i, 'Cette candidature a déjà été traitée.');
      return openModal(
        i,
        new ModalBuilder()
          .setCustomId(cid('wlr', 'refusesubmit', a.id))
          .setTitle(`Refuser la candidature n°${a.id}`)
          .addLabelComponents(
            new LabelBuilder().setLabel('Motif (facultatif)').setDescription('Communiqué au candidat si la notification est activée').setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800)),
            new LabelBuilder()
              .setLabel('Prévenir le candidat en MP ?')
              .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('notify').setRequired(true).addOptions({ label: 'Oui', value: '1', default: true }, { label: 'Non', value: '0' })),
          ),
      );
    case 'refusesubmit': {
      if (!i.isModalSubmit()) return;
      await deferEphemeral(i);
      const reason = i.fields.getTextInputValue('reason').trim() || null;
      const res = await decide(a.id, i.user.id, 'refused', reason, i.fields.getStringSelectValues('notify')[0] === '1');
      if (!res.ok) return fail(i, res.error!);
      return ephemeral(i, successEmbed(`Candidature n°${a.id} refusée.${res.warnings.length ? `\n\n⚠️ ${res.warnings.join('\n⚠️ ')}` : ''}`));
    }
    case 'note':
      return openModal(
        i,
        new ModalBuilder()
          .setCustomId(cid('wlr', 'notesubmit', a.id))
          .setTitle(`Note — candidature n°${a.id}`)
          .addLabelComponents(new LabelBuilder().setLabel('Note interne (staff uniquement)').setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500))),
      );
    case 'notesubmit': {
      if (!i.isModalSubmit()) return;
      await addApplicationNote(a.id, i.user.id, i.fields.getTextInputValue('note').trim());
      return ephemeral(i, 'Note ajoutée.');
    }
    case 'view': {
      const member = await i.guild.members.fetch(a.user_id).catch(() => null);
      const notes = applications.notes(a.id);
      const events = applications.events(a.id);
      const history = brandEmbed({ title: `📜 Historique — candidature n°${a.id}` });
      history.setDescription(
        truncate(
          events.map((e) => `${discordTs(e.created_at, 'f')} — **${eventLabel(e.action)}**${e.actor_id ? ` par <@${e.actor_id}>` : ''}${e.details ? ` : ${e.details}` : ''}`).join('\n') || 'Aucun événement.',
          4000,
        ),
      );
      for (const n of notes.slice(-8)) history.addFields({ name: `📝 Note du ${formatDate(n.created_at)}`, value: truncate(`<@${n.author_id}> : ${n.content}`, 1024) });
      const previous = applications.list({ formId: a.form_id }).rows.filter((x) => x.user_id === a.user_id && x.id !== a.id);
      if (previous.length) history.addFields({ name: 'Autres candidatures de ce membre', value: previous.slice(0, 5).map((x) => `n°${x.id} — ${APPLICATION_STATUS[x.status].emoji} ${APPLICATION_STATUS[x.status].label}`).join('\n') });
      return ephemeral(i, { embeds: [reviewEmbed(a, member, true), history], components: reviewButtons(a) });
    }
  }
}

function eventLabel(action: string): string {
  return ({ submitted: 'Soumise', accepted: 'Acceptée', refused: 'Refusée', on_hold: 'Mise en attente', note: 'Note ajoutée' } as Record<string, string>)[action] ?? action;
}

// ───────────── Commandes ─────────────

const formOption = (o: any) => o.setName('formulaire').setDescription('Nom du formulaire').setRequired(true).setAutocomplete(true);

async function formAutocomplete(i: AutocompleteInteraction<'cached'>) {
  const q = String(i.options.getFocused());
  await i.respond(forms.search(q).map((f) => ({ name: truncate(`${f.name} — ${f.title}`, 100), value: f.name })));
}

function resolveForm(i: ChatInputCommandInteraction<'cached'>): Form | undefined {
  return forms.byName(i.options.getString('formulaire', true));
}

const simple = (name: string, description: string, withForm = true) => {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  if (withForm) b.addStringOption(formOption);
  return b;
};

async function setStatus(i: ChatInputCommandInteraction<'cached'>, status: 'open' | 'closed') {
  const f = resolveForm(i);
  if (!f) return fail(i, 'Formulaire introuvable.');
  if (status === 'open' && !questions.count(f.id)) return fail(i, 'Ajoute au moins une question avant d’ouvrir le formulaire.');
  forms.update(f.id, { status });
  scheduleFormRefresh(f.id);
  await audit({ type: 'applications', action: `form_${status}`, actorId: i.user.id, target: f.name, message: `Formulaire « ${f.title} » ${status === 'open' ? 'ouvert' : 'fermé'}.` });
  return ephemeral(i, `Formulaire **${f.title}** ${status === 'open' ? 'ouvert 🔓' : 'fermé 🔒'}.${!f.message_id && status === 'open' ? '\nPense à le publier avec /wledit → Publier.' : ''}`);
}

export const whitelistModule: BotModule = {
  name: 'whitelist',
  components: [
    { prefix: 'wlb', handle: handleBuilder },
    { prefix: 'wla', handle: handleApply },
    { prefix: 'wlr', handle: handleReview },
    {
      prefix: 'wld',
      async handle(i, action, args) {
        if (!(await requireFeature(i, 'whitelist.manage'))) return;
        const f = forms.get(Number(args[0]));
        if (!f) return fail(i, 'Formulaire introuvable.');
        if (action === 'confirm' && i.isButton()) {
          await unpublishForm(f).catch(() => undefined);
          forms.remove(f.id);
          await audit({ type: 'applications', action: 'form_delete', actorId: i.user.id, target: f.name, message: `Formulaire « ${f.title} » supprimé avec ses candidatures.` });
          return i.update({ embeds: [successEmbed(`Formulaire « ${f.title} » supprimé.`)], components: [] });
        }
      },
    },
    {
      prefix: 'wlq',
      async handle(i, _action, args) {
        // Sélection d'une candidature depuis /wlreview.
        if (!i.isStringSelectMenu()) return;
        return handleReview(i, 'view', [i.values[0] ?? args[0]]);
      },
    },
  ],
  commands: [
    {
      data: simple('wlcreate', 'Créer un formulaire de candidature (assistant)', false),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wlcreate', description: 'Assistant de création de formulaire', feature: 'whitelist.manage' }],
      execute: (i) => openModal(i, infoModal()),
    },
    {
      data: simple('wledit', 'Modifier un formulaire (questions, salons, rôles, publication)'),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wledit <formulaire>', description: 'Ouvrir l’assistant d’un formulaire', feature: 'whitelist.manage' }],
      autocomplete: formAutocomplete,
      async execute(i) {
        const f = resolveForm(i);
        if (!f) return fail(i, 'Formulaire introuvable.');
        return i.reply({ ...builderPayload(f), flags: MessageFlags.Ephemeral });
      },
    },
    {
      data: simple('wldelete', 'Supprimer un formulaire et ses candidatures'),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wldelete <formulaire>', description: 'Supprimer un formulaire (avec confirmation)', feature: 'whitelist.manage' }],
      autocomplete: formAutocomplete,
      async execute(i) {
        const f = resolveForm(i);
        if (!f) return fail(i, 'Formulaire introuvable.');
        const n = applications.countForForm(f.id);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('wld', 'confirm', f.id)).setLabel('Supprimer définitivement').setStyle(ButtonStyle.Danger));
        return ephemeral(i, { embeds: [warnEmbed(`Le formulaire **${f.title}**, son message public et **${n} candidature(s)** seront supprimés définitivement.`, 'Confirmer la suppression')], components: [row] });
      },
    },
    {
      data: simple('wllist', 'Lister les formulaires de candidature', false),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wllist', description: 'Liste des formulaires', feature: 'whitelist.manage' }],
      async execute(i) {
        const list = forms.list();
        const e = brandEmbed({ title: '📋 Formulaires de candidature', description: list.length ? undefined : 'Aucun formulaire. Crée-en un avec /wlcreate.' });
        for (const f of list.slice(0, 25)) {
          const s = applications.stats(f.id);
          e.addFields({
            name: `${f.name} — ${truncate(f.title, 80)}`,
            value: `${FORM_STATE_LABEL[formState(f, s.total)]} • ${questions.count(f.id)} question(s) • ${s.total} candidature(s), ${s.pending + s.on_hold} à traiter${f.publish_channel_id ? ` • <#${f.publish_channel_id}>` : ''}`,
          });
        }
        return ephemeral(i, e);
      },
    },
    {
      data: simple('wlopen', 'Ouvrir les candidatures d’un formulaire'),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wlopen <formulaire>', description: 'Ouvrir les candidatures', feature: 'whitelist.manage' }],
      autocomplete: formAutocomplete,
      execute: (i) => setStatus(i, 'open'),
    },
    {
      data: simple('wlclose', 'Fermer les candidatures d’un formulaire'),
      feature: 'whitelist.manage',
      category: '📋 Candidatures',
      help: [{ usage: '/wlclose <formulaire>', description: 'Fermer les candidatures', feature: 'whitelist.manage' }],
      autocomplete: formAutocomplete,
      execute: (i) => setStatus(i, 'closed'),
    },
    {
      data: new SlashCommandBuilder()
        .setName('wlstats')
        .setDescription('Statistiques des candidatures')
        .addStringOption((o) => o.setName('formulaire').setDescription('Formulaire (tous si vide)').setAutocomplete(true)),
      category: '📋 Candidatures',
      help: [{ usage: '/wlstats [formulaire]', description: 'Statistiques des candidatures', feature: 'whitelist.review' }],
      autocomplete: formAutocomplete,
      async execute(i) {
        const name = i.options.getString('formulaire');
        const f = name ? forms.byName(name) : undefined;
        if (name && !f) return fail(i, 'Formulaire introuvable.');
        if (!can(i.member, 'whitelist.review', f ? reviewerRoles(f) : [])) return fail(i, 'Tu n’as pas la permission de consulter ces statistiques.');
        const e = brandEmbed({ title: `📊 Candidatures — ${f ? f.title : 'tous les formulaires'}`, description: statsSummary(f?.id) });
        if (!f) for (const x of forms.list().slice(0, 10)) e.addFields({ name: x.title, value: statsSummary(x.id).split('\n').slice(0, 3).join('\n') });
        return ephemeral(i, e);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('wlreview')
        .setDescription('Examiner les candidatures d’un formulaire')
        .addStringOption(formOption)
        .addStringOption((o) => o.setName('statut').setDescription('Filtrer par statut (par défaut : à traiter)').addChoices(...statusOptions(APPLICATION_STATUS))),
      category: '📋 Candidatures',
      help: [{ usage: '/wlreview <formulaire> [statut]', description: 'Examiner les candidatures', feature: 'whitelist.review' }],
      autocomplete: formAutocomplete,
      async execute(i) {
        const f = resolveForm(i);
        if (!f) return fail(i, 'Formulaire introuvable.');
        if (!(await requireFeature(i, 'whitelist.review', reviewerRoles(f)))) return;
        const status = i.options.getString('statut');
        const rows = status
          ? applications.list({ formId: f.id, status, limit: 25 }).rows
          : [...applications.list({ formId: f.id, status: 'pending', limit: 25 }).rows, ...applications.list({ formId: f.id, status: 'on_hold', limit: 25 }).rows].slice(0, 25);
        if (!rows.length) return ephemeral(i, infoEmbed('Aucune candidature correspondante. 🎉'));
        const select = new StringSelectMenuBuilder()
          .setCustomId(cid('wlq', 'pick', f.id))
          .setPlaceholder('Ouvrir une candidature…')
          .addOptions(
            rows.map((a) => ({
              label: truncate(`n°${a.id} — ${a.user_tag ?? a.user_id}${a.roblox_username ? ` (${a.roblox_username})` : ''}`, 100),
              description: `${APPLICATION_STATUS[a.status].label} • ${formatDate(a.created_at)}`,
              value: String(a.id),
              emoji: APPLICATION_STATUS[a.status].emoji,
            })),
          );
        const e = brandEmbed({ title: `🔎 ${f.title}`, description: `${rows.length} candidature(s) affichée(s).\n${statsSummary(f.id)}` });
        return ephemeral(i, { embeds: [e], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
      },
    },
  ],
};
