import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder, type GuildMember } from 'discord.js';
import { env } from '../../config/env';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, requireFeature } from '../../bot/reply';
import { brandEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { discordTs } from '../../core/time';
import { progressBar, truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { links, unlocks } from './rewards.repo';
import { evaluate, metricLabel, progressFor, syncUser } from './rewards.service';
import { createLinkToken, oauthConfigured } from './roblox';

async function rewardsPayload(member: GuildMember) {
  await evaluate(member.id).catch(() => undefined);
  const link = links.get(member.id);
  const list = progressFor(member.id, member);
  const done = list.filter((p) => p.unlockedAt).length;
  const lines = list.map(({ challenge: c, value, unlockedAt }) => {
    if (unlockedAt) return `✅ **${c.title}** — 🎁 ${c.reward_label}`;
    const pct = c.threshold > 0 ? (value / c.threshold) * 100 : 0;
    const bar = c.threshold > 1 ? `\n> \`${progressBar(pct, 10)}\` ${metricLabel(c.metric, value, c.threshold)}` : '';
    return `${c.emoji ?? '⬜'} **${c.title}** — 🎁 ${c.reward_label}${c.description ? `\n> ${c.description}` : ''}${bar}`;
  });
  const e = brandEmbed({
    title: '🎁 Récompenses RBKS PVP',
    description: truncate(
      `${link ? `🔗 Compte Roblox relié : **${link.roblox_username}**${link.roblox_display_name && link.roblox_display_name !== link.roblox_username ? ` (${link.roblox_display_name})` : ''}` : '⚠️ **Relie ton compte Roblox** pour recevoir tes récompenses en jeu (elles restent débloquées en attendant).'}\n\n**${done}/${list.length}** défi(s) réussi(s)\n\n${lines.join('\n\n') || 'Aucun défi pour le moment.'}`,
      4096,
    ),
  });
  if (link?.sync_error) e.addFields({ name: 'Livraison en jeu', value: '⏳ En attente : le staff a été prévenu, nouvel essai automatique.' });
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!link && oauthConfigured()) {
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Relier mon compte Roblox').setEmoji('🔗').setURL(`${env().PUBLIC_URL}/roblox/link?t=${createLinkToken(member.id)}`));
  }
  row.addComponents(new ButtonBuilder().setCustomId(cid('rwd', 'refresh')).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary));
  if (!link && !oauthConfigured()) e.setFooter({ text: 'La liaison Roblox n’est pas encore activée par le staff.' });
  return { embeds: [e], components: [row] };
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (action === 'refresh' && i.isButton()) {
    await i.deferUpdate();
    return i.editReply(await rewardsPayload(i.member));
  }
  if (action === 'unlinkok' && i.isButton()) {
    if (!(await requireFeature(i, 'rewards.manage'))) return;
    const link = links.get(args[0]);
    if (!link) return fail(i, 'Ce membre n’a pas de compte relié.');
    links.remove(args[0]);
    await audit({ type: 'admin', action: 'roblox_unlink', actorId: i.user.id, target: `<@${args[0]}>`, message: `Compte Roblox ${link.roblox_username} (${link.roblox_id}) délié de <@${args[0]}>.` });
    return i.update({ embeds: [successEmbed(`Compte Roblox **${link.roblox_username}** délié. Le membre peut relier un autre compte avec /rewards.`)], components: [] });
  }
}

export const rewardsModule: BotModule = {
  name: 'rewards',
  components: [{ prefix: 'rwd', handle }],
  commands: [
    {
      data: new SlashCommandBuilder().setName('rewards').setDescription('Tes défis et récompenses en jeu (relier ton compte Roblox)'),
      category: '💬 Communauté',
      help: [{ usage: '/rewards', description: 'Défis à réaliser pour débloquer des récompenses en jeu' }],
      async execute(i) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return i.editReply(await rewardsPayload(i.member));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('rewardsadmin')
        .setDescription('Gestion des récompenses et des comptes Roblox')
        .addSubcommand((s) => s.setName('voir').setDescription('Progression et compte Roblox d’un membre').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
        .addSubcommand((s) => s.setName('resync').setDescription('Renvoyer ses récompenses au jeu').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)))
        .addSubcommand((s) => s.setName('delier').setDescription('Délier son compte Roblox (pour qu’il en relie un autre)').addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))),
      feature: 'rewards.manage',
      category: '💬 Communauté',
      help: [{ usage: '/rewardsadmin voir|resync|delier <membre>', description: 'Gérer les comptes Roblox et récompenses', feature: 'rewards.manage' }],
      async execute(i) {
        const sub = i.options.getSubcommand();
        const user = i.options.getUser('membre', true);
        const link = links.get(user.id);
        if (sub === 'delier') {
          if (!link) return fail(i, 'Ce membre n’a pas de compte Roblox relié.');
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('rwd', 'unlinkok', user.id)).setLabel('Délier').setStyle(ButtonStyle.Danger));
          return ephemeral(i, {
            embeds: [warnEmbed(`Délier le compte Roblox **${link.roblox_username}** de <@${user.id}> ? Ses récompenses restent débloquées côté Discord et seront envoyées au nouveau compte qu’il reliera.`)],
            components: [row],
          });
        }
        await deferEphemeral(i);
        if (sub === 'resync') {
          const res = await syncUser(user.id);
          return res.ok ? ephemeral(i, successEmbed('Récompenses renvoyées au jeu.')) : fail(i, res.error ?? 'Échec.');
        }
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        const list = progressFor(user.id, member);
        const e = brandEmbed({ title: `🎁 Récompenses de ${user.username}` }).addFields(
          { name: 'Compte Roblox', value: link ? `[${link.roblox_username}](https://www.roblox.com/users/${link.roblox_id}/profile) • relié ${discordTs(link.linked_at, 'R')}` : 'non relié', inline: false },
          { name: 'Livraison en jeu', value: !link ? '—' : link.sync_error ? `⚠️ ${truncate(link.sync_error, 200)}` : link.synced_at ? `✅ ${discordTs(link.synced_at, 'R')}` : '⏳ en attente', inline: false },
          { name: 'Défis réussis', value: `${unlocks.count(user.id)}/${list.length}`, inline: true },
        );
        e.setDescription(truncate(list.map((p) => `${p.unlockedAt ? '✅' : '⬜'} ${p.challenge.title} — ${metricLabel(p.challenge.metric, p.value, p.challenge.threshold)}`).join('\n'), 4000));
        return ephemeral(i, e);
      },
    },
  ],
};
