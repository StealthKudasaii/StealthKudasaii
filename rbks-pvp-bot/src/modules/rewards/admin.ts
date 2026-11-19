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
} from 'discord.js';
import type { ComponentInteraction, SlashCommand } from '../../bot/types';
import { cid } from '../../bot/types';
import { fail, fromEphemeralMessage, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, warnEmbed } from '../../bot/ui/embeds';
import { truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { BINARY_METRICS, METRICS, challenges, isMetric, links, parseChallenge, type Challenge, type Metric } from './rewards.repo';

/**
 * /rewardsconfig : gérer les défis et récompenses de /rewards depuis Discord.
 * Panneau privé : liste → choisir un défi → modifier / activer / déplacer / supprimer, ou en ajouter un.
 */

const P = 'rwc';

function line(c: Challenge, idx: number): string {
  const m = METRICS[c.metric];
  const goal = BINARY_METRICS.includes(c.metric) ? m.label : `${m.label} : ${c.threshold}${m.unit ? ` ${m.unit}` : ''}`;
  return `\`${idx + 1}.\` ${c.enabled ? '' : '⏸️ '}${c.emoji ?? m.emoji} **${c.title}** — ${goal}\n   🎁 ${c.reward_label} · \`${c.reward_id}\``;
}

export function listPayload(notice?: string) {
  const list = challenges.list();
  const active = list.filter((c) => c.enabled).length;
  const e = brandEmbed({
    title: '🎁 Gestion des récompenses /rewards',
    description: truncate(
      `${notice ? `${notice}\n\n` : ''}${list.length ? `**${active}** défi(s) actif(s) sur ${list.length}. ⏸️ = désactivé (invisible dans /rewards).\n\n${list.map(line).join('\n')}` : 'Aucun défi pour le moment : ajoute-en un avec le menu ci-dessous.'}`,
      4096,
    ),
    timestamp: false,
  }).setFooter({ text: 'L’identifiant (`…`) est la clé à utiliser dans la table REWARDS du script Roblox.' });

  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(cid(P, 'add'))
        .setPlaceholder('➕ Ajouter un défi : choisis ce qu’il faut faire…')
        .addOptions(Object.entries(METRICS).map(([value, m]) => ({ label: m.label, value, emoji: m.emoji, description: truncate(m.help, 100) }))),
    ),
  ];
  if (list.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid(P, 'pick'))
          .setPlaceholder(list.length > 25 ? '✏️ Gérer un défi (25 premiers)…' : '✏️ Modifier, activer, déplacer ou supprimer un défi…')
          .addOptions(
            list.slice(0, 25).map((c, i) => ({
              label: truncate(`${i + 1}. ${c.title}`, 100),
              description: truncate(`🎁 ${c.reward_label}${c.enabled ? '' : ' (désactivé)'}`, 100),
              value: String(c.id),
              emoji: c.enabled ? (c.emoji ?? METRICS[c.metric].emoji) : '⏸️',
            })),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid(P, 'list')).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid(P, 'clear')).setLabel('Tout supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!list.length),
    ),
  );
  return { embeds: [e], components: rows };
}

export function detailPayload(c: Challenge, notice?: string) {
  const m = METRICS[c.metric];
  const list = challenges.list();
  const idx = list.findIndex((x) => x.id === c.id);
  const e = brandEmbed({
    title: `${c.emoji ?? m.emoji} ${c.title}`,
    description: `${notice ? `${notice}\n\n` : ''}${c.description || '*Pas de description.*'}`,
    timestamp: false,
  }).addFields(
    { name: 'À faire', value: BINARY_METRICS.includes(c.metric) ? m.label : `${m.label} : **${c.threshold}**${m.unit ? ` ${m.unit}` : ''}`, inline: true },
    { name: 'Statut', value: c.enabled ? '✅ Actif' : '⏸️ Désactivé', inline: true },
    { name: 'Position', value: `${idx + 1}/${list.length}`, inline: true },
    { name: 'Récompense', value: c.reward_label, inline: true },
    { name: 'Identifiant pour le jeu', value: `\`${c.reward_id}\``, inline: true },
    { name: 'Comment c’est compté', value: m.help },
  );
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid(P, 'edit', c.id)).setLabel('Modifier').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(cid(P, 'toggle', c.id))
          .setLabel(c.enabled ? 'Désactiver' : 'Activer')
          .setEmoji(c.enabled ? '⏸️' : '▶️')
          .setStyle(c.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid(P, 'up', c.id)).setEmoji('⬆️').setStyle(ButtonStyle.Secondary).setDisabled(idx <= 0),
        new ButtonBuilder().setCustomId(cid(P, 'down', c.id)).setEmoji('⬇️').setStyle(ButtonStyle.Secondary).setDisabled(idx >= list.length - 1),
        new ButtonBuilder().setCustomId(cid(P, 'delete', c.id)).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid(P, 'list')).setLabel('Retour à la liste').setEmoji('↩️').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

export function challengeModal(metric: Metric, c?: Challenge) {
  const m = METRICS[metric];
  const input = (id: string, opts: { required: boolean; max: number; value?: string; placeholder?: string; style?: TextInputStyle }) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(opts.style ?? TextInputStyle.Short).setRequired(opts.required).setMaxLength(opts.max);
    if (opts.value) t.setValue(opts.value);
    if (opts.placeholder) t.setPlaceholder(opts.placeholder);
    return t;
  };
  const modal = new ModalBuilder()
    .setCustomId(cid(P, 'save', metric, c ? c.id : 'new'))
    .setTitle(truncate(`${c ? 'Modifier' : 'Nouveau défi'} — ${m.label}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Nom du défi').setDescription('Affiché dans /rewards').setTextInputComponent(input('title', { required: true, max: 100, value: c?.title, placeholder: exampleTitle(metric) })),
    );
  if (!BINARY_METRICS.includes(metric)) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(`Objectif (${m.unit || 'nombre'})`)
        .setDescription(truncate(m.help, 100))
        .setTextInputComponent(input('threshold', { required: true, max: 7, value: c ? String(c.threshold) : '', placeholder: metric === 'voice_minutes' ? '600 (= 10 heures)' : '10' })),
    );
  }
  modal.addLabelComponents(
    new LabelBuilder().setLabel('Récompense').setDescription('Ce que le joueur gagne en jeu (texte affiché)').setTextInputComponent(input('reward_label', { required: true, max: 100, value: c?.reward_label, placeholder: 'ex. Skin Katon exclusif' })),
    new LabelBuilder()
      .setLabel('Identifiant pour le jeu (facultatif)')
      .setDescription('Clé du script Roblox. Vide = généré depuis la récompense')
      .setTextInputComponent(input('reward_id', { required: false, max: 50, value: c?.reward_id, placeholder: 'ex. skin_katon' })),
    new LabelBuilder().setLabel('Description (facultatif)').setTextInputComponent(input('description', { required: false, max: 200, value: c?.description })),
  );
  return modal;
}

function exampleTitle(metric: Metric): string {
  return (
    {
      linked: 'Relier son compte Roblox',
      invites: 'Inviter 5 amis',
      beta: 'Rejoindre la bêta',
      test_sessions: 'Participer à 3 sessions de test',
      bugs_resolved: 'Faire corriger un bug',
      suggestions_accepted: 'Faire accepter une suggestion',
      boost: 'Booster le serveur',
      voice_minutes: 'Passer 10 h en vocal',
      messages: 'Envoyer 500 messages',
      polls: 'Voter à 5 sondages',
      announcement_reactions: 'Réagir à 10 annonces',
    } as Record<Metric, string>
  )[metric];
}

async function show(i: ComponentInteraction, payload: ReturnType<typeof listPayload> | ReturnType<typeof detailPayload>) {
  if (fromEphemeralMessage(i) && (i.isMessageComponent() || (i.isModalSubmit() && i.isFromMessage()))) return i.update(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export async function handleRewardsConfig(i: ComponentInteraction, action: string, args: string[]) {
  if (!(await requireFeature(i, 'rewards.manage'))) return;

  switch (action) {
    case 'list':
      return show(i, listPayload());
    case 'add': {
      if (!i.isStringSelectMenu() || !isMetric(i.values[0])) return;
      return openModal(i, challengeModal(i.values[0]));
    }
    case 'pick': {
      if (!i.isStringSelectMenu()) return;
      const c = challenges.get(Number(i.values[0]));
      return show(i, c ? detailPayload(c) : listPayload('⚠️ Ce défi n’existe plus.'));
    }
    case 'save': {
      if (!i.isModalSubmit()) return;
      const [metric, idRaw] = args;
      const editing = idRaw !== 'new' ? challenges.get(Number(idRaw)) : undefined;
      if (idRaw !== 'new' && !editing) return show(i, listPayload('⚠️ Ce défi n’existe plus.'));
      const val = (id: string) => {
        try {
          return i.fields.getTextInputValue(id);
        } catch {
          return '';
        }
      };
      const parsed = parseChallenge({
        metric,
        title: val('title'),
        rewardLabel: val('reward_label'),
        rewardId: val('reward_id'),
        threshold: val('threshold') || 1,
        description: val('description'),
        emoji: editing?.emoji ?? null,
        position: editing?.position ?? challenges.nextPosition(),
        enabled: editing ? !!editing.enabled : true,
      });
      if (!parsed.ok) return fail(i, parsed.error);
      let id: number;
      if (editing) {
        challenges.update(editing.id, parsed.value);
        if (editing.reward_id !== parsed.value.reward_id) links.markDirty(); // la liste livrée au jeu change
        id = editing.id;
      } else id = challenges.create(parsed.value);
      await audit({ type: 'admin', action: 'reward_challenge', actorId: i.user.id, message: `Défi /rewards « ${parsed.value.title} » ${editing ? 'modifié' : 'créé'} (récompense : ${parsed.value.reward_label}).` });
      return show(i, detailPayload(challenges.get(id)!, editing ? '✅ Défi modifié.' : '✅ Défi ajouté. Les membres qui l’ont déjà atteint le débloqueront à leur prochaine activité ou en ouvrant /rewards.'));
    }
  }

  // Actions sur un défi précis.
  const c = challenges.get(Number(args[0]));
  if (!c && action !== 'clear' && action !== 'clearok') return show(i, listPayload('⚠️ Ce défi n’existe plus.'));
  switch (action) {
    case 'edit':
      return openModal(i, challengeModal(c!.metric, c!));
    case 'toggle':
      challenges.setEnabled(c!.id, !c!.enabled);
      links.markDirty();
      await audit({ type: 'admin', action: 'reward_challenge', actorId: i.user.id, message: `Défi /rewards « ${c!.title} » ${c!.enabled ? 'désactivé' : 'activé'}.` });
      return show(i, detailPayload(challenges.get(c!.id)!, c!.enabled ? '⏸️ Défi désactivé : il n’apparaît plus dans /rewards et sa récompense n’est plus livrée aux joueurs qui ne l’ont pas encore reçue en jeu.' : '▶️ Défi activé.'));
    case 'up':
    case 'down':
      challenges.move(c!.id, action === 'up' ? -1 : 1);
      return show(i, detailPayload(challenges.get(c!.id)!));
    case 'delete':
      if (!i.isButton()) return;
      return i.update({
        embeds: [warnEmbed(`Supprimer le défi **${c!.title}** (récompense : ${c!.reward_label}) ? Les joueurs qui l’avaient débloqué le perdent dans /rewards ; ce qui a déjà été donné en jeu reste acquis.`, 'Confirmer la suppression')],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid(P, 'deleteok', c!.id)).setLabel('Supprimer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cid(P, 'pickback', c!.id)).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    case 'pickback':
      return show(i, detailPayload(c!));
    case 'deleteok':
      challenges.remove(c!.id);
      links.markDirty();
      await audit({ type: 'admin', action: 'reward_challenge', actorId: i.user.id, message: `Défi /rewards « ${c!.title} » supprimé.` });
      return show(i, listPayload(`🗑️ Défi « ${c!.title} » supprimé.`));
    case 'clear':
      if (!i.isButton()) return;
      return i.update({
        embeds: [warnEmbed(`Supprimer **les ${challenges.list().length} défis** pour repartir de zéro ? Ce qui a déjà été donné en jeu reste acquis.`, 'Tout supprimer')],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid(P, 'clearok')).setLabel('Tout supprimer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cid(P, 'list')).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    case 'clearok': {
      const n = challenges.removeAll();
      links.markDirty();
      await audit({ type: 'admin', action: 'reward_challenge', actorId: i.user.id, message: `Tous les défis /rewards supprimés (${n}).` });
      return show(i, listPayload(`🗑️ ${n} défi(s) supprimé(s). Ajoute tes propres défis avec le menu ci-dessous.`));
    }
  }
}

export const rewardsConfigCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('rewardsconfig').setDescription('Gérer les défis et récompenses de /rewards'),
  feature: 'rewards.manage',
  category: '💬 Communauté',
  help: [{ usage: '/rewardsconfig', description: 'Ajouter, modifier, activer, ordonner ou supprimer les défis et récompenses', feature: 'rewards.manage' }],
  execute: (i) => i.reply({ ...listPayload(), flags: MessageFlags.Ephemeral }),
};
