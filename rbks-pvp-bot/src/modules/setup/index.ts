import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, requireFeature } from '../../bot/reply';
import { brandEmbed, infoEmbed, successEmbed } from '../../bot/ui/embeds';
import { COLORS } from '../../config/constants';
import { truncate } from '../../core/text';
import { tryLock } from '../../core/guards';
import { childLogger } from '../../core/logger';
import { audit } from '../logs/audit';
import { applyCleanup, computeCleanup, runSetup, type PlanItem, type SetupResult } from './setup.service';
import { publishTicketPanel } from '../tickets/tickets.service';
import { publishNotificationPanel } from '../notifications';
import { publishSuggestionPanel } from '../community/suggestions';
import { publishBugPanel } from '../community/bugs';
import { publishRulesPanel } from '../general';
import { syncRoadmap } from '../dev/dev.service';

const log = childLogger('setup');

const ACTION_LABEL: Record<PlanItem['action'], string> = { create: '🆕 à créer', adopt: '🔗 existant repris', fix: '🔧 à corriger', ok: '✅ conforme', skip: '⏭️ ignoré' };
const ACTION_DONE: Record<PlanItem['action'], string> = { create: '🆕 créé', adopt: '🔗 repris', fix: '🔧 corrigé', ok: '✅ conforme', skip: '⏭️ ignoré' };

function summarize(result: SetupResult, done: boolean) {
  const changes = result.items.filter((i) => i.action !== 'ok');
  const okCount = result.items.length - changes.length;
  const labels = done ? ACTION_DONE : ACTION_LABEL;
  const e = brandEmbed({
    title: done ? '✅ Configuration appliquée' : '🧭 Aperçu de la configuration',
    description: done
      ? `${changes.length} modification(s) appliquée(s), ${okCount} élément(s) déjà conformes.`
      : changes.length
        ? `**${changes.length}** modification(s) prévue(s), ${okCount} élément(s) déjà conformes.\nAucun salon ni rôle existant ne sera supprimé.`
        : 'Tout est déjà conforme. Tu peux quand même appliquer pour republier les panneaux.',
    color: result.errors.length ? COLORS.danger : undefined,
  });
  const group = (kind: PlanItem['kind'][], title: string) => {
    const lines = changes.filter((c) => kind.includes(c.kind)).map((c) => `${labels[c.action]} — **${c.name}**${c.details.length ? `\n  ↳ ${c.details.join(' ; ')}` : ''}`);
    if (lines.length) e.addFields({ name: title, value: truncate(lines.join('\n'), 1024) });
  };
  group(['role', 'order', 'member'], 'Rôles');
  group(['category'], 'Catégories');
  group(['channel'], 'Salons');
  if (result.warnings.length) e.addFields({ name: '⚠️ À savoir', value: truncate(result.warnings.map((w) => `• ${w}`).join('\n'), 1024) });
  if (result.errors.length) e.addFields({ name: '⛔ Erreurs', value: truncate(result.errors.map((w) => `• ${w}`).join('\n'), 1024) });
  return e;
}

/** Publie ou met à jour tous les messages permanents (idempotent). */
export async function publishAllPanels(): Promise<string[]> {
  const report: string[] = [];
  const steps: [string, () => Promise<unknown>][] = [
    ['Règlement', publishRulesPanel],
    ['Notifications', publishNotificationPanel],
    ['Tickets', publishTicketPanel],
    ['Suggestions', publishSuggestionPanel],
    ['Bugs', publishBugPanel],
    ['Roadmap', () => syncRoadmap(false)],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
      report.push(`✅ ${name}`);
    } catch (e) {
      log.warn({ err: e, panel: name }, 'Publication du panneau impossible');
      report.push(`⛔ ${name} : ${(e as Error).message}`);
    }
  }
  return report;
}

async function apply(guild: Guild, actorId: string) {
  const result = await runSetup(guild, true);
  const panels = result.errors.length && !result.items.some((i) => i.kind === 'channel') ? [] : await publishAllPanels();
  await audit({
    type: 'admin',
    action: 'setup',
    actorId,
    message: `/setup appliqué : ${result.items.filter((i) => i.action !== 'ok').length} modification(s), ${result.errors.length} erreur(s).`,
  });
  return { result, panels };
}

async function handle(i: ComponentInteraction, action: string) {
  if (!(await requireFeature(i, 'setup')) || !i.isButton()) return;
  switch (action) {
    case 'cancel':
      return i.update({ embeds: [infoEmbed('Configuration annulée, rien n’a été modifié.')], components: [] });
    case 'apply': {
      await i.update({ embeds: [infoEmbed('Application de la configuration en cours… (cela peut prendre une minute)')], components: [] });
      const res = await tryLock('setup', () => apply(i.guild, i.user.id));
      if (!res.ok) return i.editReply({ embeds: [infoEmbed('Une configuration est déjà en cours.')] });
      const e = summarize(res.value.result, true);
      if (res.value.panels.length) e.addFields({ name: 'Panneaux publiés', value: res.value.panels.join('\n') });
      e.addFields({
        name: 'Étapes suivantes',
        value:
          '1. Active la permission **Administrateur** sur 👑 Fondateur (le bot ne la possède pas, par sécurité).\n2. Dans Paramètres du serveur → Rôles, place les rôles 👑 Fondateur, ⚜️ Co-Fondateur et 🛡️ Administrateur **au-dessus** du rôle du bot.\n3. Attribue-toi le rôle 👑 Fondateur manuellement.\n4. Ouvre le panel web pour personnaliser le reste.',
      });
      return i.editReply({ embeds: [e] });
    }
    case 'cleanupok': {
      await i.update({ embeds: [infoEmbed('Nettoyage en cours…')], components: [] });
      const items = await computeCleanup(i.guild);
      const res = await applyCleanup(i.guild, items);
      await audit({ type: 'admin', action: 'setup_cleanup', actorId: i.user.id, message: `/setup cleanup : ${res.done} élément(s) nettoyé(s).` });
      return i.editReply({ embeds: [successEmbed(`${res.done} élément(s) nettoyé(s).${res.errors.length ? `\n\n⛔ ${res.errors.join('\n⛔ ')}` : ''}`)] });
    }
  }
}

export const setupModule: BotModule = {
  name: 'setup',
  components: [{ prefix: 'setup', handle }],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configuration automatique du serveur RBKS PVP')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('installer').setDescription('Créer/corriger rôles, salons et permissions (aperçu avant application)'))
        .addSubcommand((s) => s.setName('cleanup').setDescription('Nettoyer les éléments gérés par le bot devenus inutiles (aperçu + confirmation)'))
        .addSubcommand((s) => s.setName('panneaux').setDescription('Republier/mettre à jour les messages permanents (tickets, notifications…)')),
      feature: 'setup',
      category: '⚙️ Administration',
      help: [
        { usage: '/setup installer', description: 'Configurer le serveur (aperçu puis confirmation)', feature: 'setup' },
        { usage: '/setup cleanup', description: 'Nettoyer les éléments obsolètes gérés par le bot', feature: 'setup' },
        { usage: '/setup panneaux', description: 'Republier les panneaux permanents', feature: 'setup' },
      ],
      async execute(i) {
        const sub = i.options.getSubcommand();
        await deferEphemeral(i);
        if (sub === 'panneaux') {
          const report = await publishAllPanels();
          return ephemeral(i, brandEmbed({ title: '📌 Panneaux', description: report.join('\n') }));
        }
        if (sub === 'cleanup') {
          const items = await computeCleanup(i.guild);
          if (!items.length) return ephemeral(i, successEmbed('Rien à nettoyer : tout est propre.'));
          const e = brandEmbed({
            title: '🧹 Aperçu du nettoyage',
            description: `Seuls des éléments **gérés par le bot** sont concernés. Rien d’autre ne sera touché.\n\n${truncate(items.map((x) => `${x.discord ? '🗑️' : '🧾'} **${x.label}** — ${x.reason}`).join('\n'), 3500)}`,
            color: COLORS.warning,
          }).addFields({ name: 'Légende', value: '🗑️ supprimé de Discord • 🧾 nettoyé uniquement en base' });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(cid('setup', 'cleanupok')).setLabel(`Confirmer le nettoyage (${items.length})`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cid('setup', 'cancel')).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          );
          return ephemeral(i, { embeds: [e], components: [row] });
        }
        const preview = await runSetup(i.guild, false);
        if (preview.errors.length && !preview.items.length) return fail(i, preview.errors.join('\n'));
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(cid('setup', 'apply')).setLabel('Appliquer').setEmoji('🚀').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(cid('setup', 'cancel')).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
        );
        return ephemeral(i, { embeds: [summarize(preview, false)], components: [row] });
      },
    },
  ],
};
