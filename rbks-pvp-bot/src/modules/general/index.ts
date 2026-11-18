import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  version as djsVersion,
} from 'discord.js';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { allCommands } from '../../bot/registry';
import { deferEphemeral, ephemeral, fail } from '../../bot/reply';
import { brandEmbed, successEmbed } from '../../bot/ui/embeds';
import { publishPanel } from '../../bot/panels';
import { can, FEATURES, featureRoleIds, isFeature, isFeatureCustomized, setFeatureRoles, type Feature } from '../../core/permissions';
import { getSetting } from '../../core/settings';
import { roleId } from '../../core/resources';
import { discordTs, formatDuration } from '../../core/time';
import { truncate } from '../../core/text';
import { env } from '../../config/env';
import { readDeployInfo } from '../../core/deploy';
import { audit } from '../audit/audit';
import { serverStats } from '../stats/stats.service';

const startedAt = Date.now();
const pkgVersion = (() => {
  try {
    return (require('../../../package.json') as { version: string }).version;
  } catch {
    return '1.0.0';
  }
})();

// ───────────── Règlement ─────────────

export async function publishRulesPanel() {
  const e = brandEmbed({ title: getSetting('rules.title'), description: getSetting('rules.text'), timestamp: false });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('rules', 'accept')).setLabel('J’ai lu et j’accepte le règlement').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  return publishPanel('rules', 'rules', { embeds: [e], components: [row] });
}

async function handleRules(i: ComponentInteraction) {
  const member = roleId('member');
  if (!member) return fail(i, 'Le rôle Membre n’est pas encore configuré.');
  if (i.member.roles.cache.has(member)) return ephemeral(i, 'Tu as déjà accepté le règlement. Bon jeu ! ⚔️');
  await i.member.roles.add(member, 'Règlement accepté');
  return ephemeral(i, successEmbed(`Bienvenue sur ${getSetting('brand.name')} ! Tu as maintenant accès au serveur. Pense à choisir tes notifications.`));
}

// ───────────── Permissions ─────────────

const featureChoices = (Object.keys(FEATURES) as Feature[]).map((f) => ({ name: truncate(`${FEATURES[f].group} — ${FEATURES[f].label}`, 100), value: f }));

function permissionsEmbed() {
  const e = brandEmbed({ title: '🔐 Permissions du bot', description: 'Rôles autorisés pour chaque fonctionnalité. Le propriétaire du serveur et les membres avec la permission Administrateur ont toujours accès à tout.' });
  const groups = new Map<string, string[]>();
  for (const f of Object.keys(FEATURES) as Feature[]) {
    const roles = featureRoleIds(f);
    const line = `**${FEATURES[f].label}** ${isFeatureCustomized(f) ? '' : '*(défaut)*'}\n${roles.length ? roles.map((r) => `<@&${r}>`).join(' ') : '— personne —'}`;
    groups.set(FEATURES[f].group, [...(groups.get(FEATURES[f].group) ?? []), line]);
  }
  for (const [g, lines] of groups) e.addFields({ name: g, value: truncate(lines.join('\n'), 1024) });
  return e;
}

// ───────────── Aide ─────────────

function helpPayload(i: ComponentInteraction | Parameters<NonNullable<BotModule['commands']>[number]['execute']>[0], category?: string) {
  const cats = new Map<string, string[]>();
  for (const c of allCommands()) {
    for (const h of c.help) {
      const feature = h.feature ?? c.feature;
      if (feature && !can(i.member, feature)) continue;
      cats.set(c.category, [...(cats.get(c.category) ?? []), `\`${h.usage}\` — ${h.description}`]);
    }
  }
  const names = [...cats.keys()];
  const selected = category && cats.has(category) ? category : null;
  const e = brandEmbed({
    title: `📖 Aide — ${getSetting('brand.name')}`,
    description: selected ? undefined : 'Voici les commandes auxquelles tu as accès. Choisis une catégorie pour le détail.',
  });
  for (const name of selected ? [selected] : names) e.addFields({ name, value: truncate(cats.get(name)!.join('\n'), 1024) });
  const select = new StringSelectMenuBuilder()
    .setCustomId(cid('help', 'cat'))
    .setPlaceholder('Filtrer par catégorie…')
    .addOptions([{ label: 'Toutes les catégories', value: '*' }, ...names.map((n) => ({ label: n, value: n, default: n === selected }))].slice(0, 25));
  return { embeds: [e], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
}

export const generalModule: BotModule = {
  name: 'general',
  components: [
    { prefix: 'rules', handle: (i) => handleRules(i) },
    {
      prefix: 'help',
      async handle(i) {
        if (!i.isStringSelectMenu()) return;
        return i.update(helpPayload(i, i.values[0] === '*' ? undefined : i.values[0]));
      },
    },
  ],
  commands: [
    {
      data: new SlashCommandBuilder().setName('help').setDescription('Liste des commandes disponibles pour toi'),
      category: 'ℹ️ Général',
      help: [{ usage: '/help', description: 'Cette aide' }],
      execute: (i) => ephemeral(i, helpPayload(i)),
    },
    {
      data: new SlashCommandBuilder().setName('ping').setDescription('Vérifier que le bot répond'),
      category: 'ℹ️ Général',
      help: [{ usage: '/ping', description: 'Latence du bot' }],
      async execute(i) {
        const t = Date.now();
        await deferEphemeral(i);
        return ephemeral(i, brandEmbed({ title: '🏓 Pong !', description: `Latence API : **${Date.now() - t} ms**\nLatence WebSocket : **${Math.round(i.client.ws.ping)} ms**` }));
      },
    },
    {
      data: new SlashCommandBuilder().setName('botinfo').setDescription('Informations sur le bot'),
      category: 'ℹ️ Général',
      help: [{ usage: '/botinfo', description: 'Informations sur le bot' }],
      async execute(i) {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        const e = brandEmbed({ title: `🤖 ${i.client.user.username}`, description: `Bot officiel de **${getSetting('brand.name')}**.` })
          .setThumbnail(i.client.user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: 'Version', value: `v${pkgVersion}${readDeployInfo() ? ` (\`${readDeployInfo()!.commit.slice(0, 7)}\`)` : ''}`, inline: true },
            { name: 'En ligne depuis', value: discordTs(startedAt, 'R'), inline: true },
            { name: 'Latence', value: `${Math.round(i.client.ws.ping)} ms`, inline: true },
            { name: 'Mémoire', value: `${mem.toFixed(0)} Mo`, inline: true },
            { name: 'Commandes', value: String(allCommands().length), inline: true },
            { name: 'Technologies', value: `Node.js ${process.version} • discord.js ${djsVersion}`, inline: true },
          );
        if (env().WEB_ENABLED) e.addFields({ name: 'Panel web', value: env().PUBLIC_URL });
        return ephemeral(i, e);
      },
    },
    {
      data: new SlashCommandBuilder().setName('stats').setDescription('Statistiques du serveur RBKS PVP'),
      category: 'ℹ️ Général',
      help: [{ usage: '/stats', description: 'Statistiques du serveur' }],
      async execute(i) {
        const s = serverStats();
        const detailed = can(i.member, 'stats.view');
        const e = brandEmbed({ title: `📊 Statistiques — ${getSetting('brand.name')}` }).addFields(
          { name: '👥 Membres', value: String(s.members ?? '—'), inline: true },
          { name: '🧪 Testeurs', value: String(s.testers ?? '—'), inline: true },
          { name: '🎮 Sessions de test', value: String(s.testSessions), inline: true },
          { name: '💡 Suggestions', value: String(s.suggestions), inline: true },
          { name: '🐞 Bugs signalés', value: String(s.bugsTotal), inline: true },
          { name: '📋 Candidatures', value: String(s.applications), inline: true },
        );
        if (detailed) {
          e.addFields(
            { name: '✅ Candidatures acceptées', value: String(s.applicationsAccepted), inline: true },
            { name: '⏳ Candidatures à traiter', value: String(s.applicationsPending), inline: true },
            { name: '🎫 Tickets ouverts', value: `${s.ticketsOpen} (${s.ticketsTotal} au total)`, inline: true },
            { name: '🐞 Bugs ouverts', value: String(s.bugsOpen), inline: true },
            { name: '📝 Tâches', value: `${s.tasksOpen} en cours • ${s.tasksDone} terminées`, inline: true },
            { name: '⏱️ Bot en ligne', value: formatDuration(Date.now() - startedAt), inline: true },
          );
        }
        return ephemeral(i, e);
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('permissions')
        .setDescription('Rôles autorisés pour chaque fonctionnalité du bot')
        .addSubcommand((s) => s.setName('view').setDescription('Voir la configuration'))
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Autoriser un rôle')
            .addStringOption((o) => o.setName('fonction').setDescription('Fonctionnalité').setRequired(true).addChoices(...featureChoices))
            .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Retirer un rôle')
            .addStringOption((o) => o.setName('fonction').setDescription('Fonctionnalité').setRequired(true).addChoices(...featureChoices))
            .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Revenir aux rôles par défaut')
            .addStringOption((o) => o.setName('fonction').setDescription('Fonctionnalité').setRequired(true).addChoices(...featureChoices)),
        ),
      feature: 'permissions',
      category: '⚙️ Administration',
      help: [{ usage: '/permissions view|add|remove|reset', description: 'Configurer les accès aux fonctionnalités', feature: 'permissions' }],
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'view') return ephemeral(i, permissionsEmbed());
        const f = i.options.getString('fonction', true);
        if (!isFeature(f)) return fail(i, 'Fonctionnalité inconnue.');
        if (sub === 'reset') setFeatureRoles(f, null);
        else {
          const role = i.options.getRole('role', true);
          const current = featureRoleIds(f);
          setFeatureRoles(f, sub === 'add' ? [...current, role.id] : current.filter((r) => r !== role.id));
        }
        await audit({ type: 'admin', action: 'permissions', actorId: i.user.id, target: f, message: `Permissions « ${FEATURES[f].label} » modifiées (${sub}).` });
        return ephemeral(i, permissionsEmbed());
      },
    },
  ],
};

