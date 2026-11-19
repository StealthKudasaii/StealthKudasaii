import { ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle, type GuildMember } from 'discord.js';
import { env } from '../../config/env';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, fromEphemeralMessage, openModal, requireFeature } from '../../bot/reply';
import { hitCooldown } from '../../core/guards';
import { brandEmbed, successEmbed, warnEmbed } from '../../bot/ui/embeds';
import { discordTs } from '../../core/time';
import { progressBar, truncate } from '../../core/text';
import { audit } from '../audit/audit';
import { links, unlocks } from './rewards.repo';
import { evaluate, metricLabel, progressFor, syncUser } from './rewards.service';
import { createLinkToken, oauthConfigured } from './roblox';
import { cancelVerification, completeLink, descriptionHasPhrase, fetchRobloxProfile, getVerification, linkConflict, lookupRobloxUser, startVerification, type PendingVerification } from './verify';

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
  if (!link) {
    // Connexion officielle Roblox si un domaine HTTPS est configuré, sinon vérification par la description du profil.
    if (oauthConfigured() && env().PUBLIC_URL.startsWith('https://')) {
      row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Relier mon compte Roblox').setEmoji('🔗').setURL(`${env().PUBLIC_URL}/roblox/link?t=${createLinkToken(member.id)}`));
    } else {
      row.addComponents(new ButtonBuilder().setCustomId(cid('rwd', 'link')).setLabel('Relier mon compte Roblox').setEmoji('🔗').setStyle(ButtonStyle.Primary));
    }
  }
  row.addComponents(new ButtonBuilder().setCustomId(cid('rwd', 'refresh')).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

function verificationPayload(v: PendingVerification, notice?: string) {
  const e = brandEmbed({
    title: '🔗 Relier ton compte Roblox',
    description: `${notice ? `${notice}\n\n` : ''}Compte : **${v.profile.username}**${v.profile.displayName && v.profile.displayName !== v.profile.username ? ` (${v.profile.displayName})` : ''}\n\n**1.** Ouvre ton profil Roblox (bouton ci-dessous) et clique sur le crayon à côté de **« À propos »**.\n**2.** Colle cette phrase dans ta description, puis **enregistre** :\n\`\`\`\n${v.phrase}\n\`\`\`**3.** Reviens ici et clique sur **Vérifier**.\n\nTu pourras retirer la phrase une fois le compte relié. Elle expire ${'<t:' + Math.floor(v.expires / 1000) + ':R>'}.`,
  });
  return {
    embeds: [e],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(cid('rwd', 'verify')).setLabel('Vérifier').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ouvrir mon profil Roblox').setURL(`https://www.roblox.com/users/${v.profile.id}/profile`),
        new ButtonBuilder().setCustomId(cid('rwd', 'cancel')).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function handle(i: ComponentInteraction, action: string, args: string[]) {
  if (action === 'link') {
    if (links.get(i.user.id)) return fail(i, 'Ton compte Roblox est déjà relié.');
    return openModal(
      i,
      new ModalBuilder()
        .setCustomId(cid('rwd', 'linkname'))
        .setTitle('Relier ton compte Roblox')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Ton nom d’utilisateur Roblox')
            .setDescription('Le nom exact (pas le nom d’affichage)')
            .setTextInputComponent(new TextInputBuilder().setCustomId('username').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(20)),
        ),
    );
  }
  if (action === 'linkname' && i.isModalSubmit()) {
    const username = i.fields.getTextInputValue('username').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(i, 'Nom d’utilisateur Roblox invalide (3 à 20 caractères : lettres, chiffres ou _).');
    await deferEphemeral(i);
    let profile;
    try {
      profile = await lookupRobloxUser(username);
    } catch (e) {
      return fail(i, (e as Error).message);
    }
    if (!profile) return fail(i, `Aucun compte Roblox nommé « ${username} ». Vérifie l’orthographe (nom d’utilisateur, pas nom d’affichage).`);
    const conflict = linkConflict(i.user.id, profile);
    if (conflict) return fail(i, conflict);
    return i.editReply(verificationPayload(startVerification(i.user.id, profile)));
  }
  if (action === 'verify' && i.isButton()) {
    const v = getVerification(i.user.id);
    if (!v) return i.update({ embeds: [warnEmbed('La vérification a expiré. Refais /rewards puis « Relier mon compte Roblox ».')], components: [] });
    const wait = hitCooldown(`rwdverify:${i.user.id}`, 5000);
    if (wait) return fail(i, 'Patiente quelques secondes avant de revérifier.');
    await i.deferUpdate();
    let profile;
    try {
      profile = await fetchRobloxProfile(v.profile.id);
    } catch (e) {
      return i.editReply(verificationPayload(v, `⚠️ ${(e as Error).message}`));
    }
    if (!descriptionHasPhrase(profile.description, v.phrase)) {
      return i.editReply(verificationPayload(v, '❌ Phrase introuvable dans ta description. Vérifie que tu as bien **enregistré** ton profil, puis réessaie (Roblox peut mettre quelques secondes à la mettre à jour). Si Roblox a remplacé des mots par des #, refais /rewards pour obtenir une nouvelle phrase.'));
    }
    const err = await completeLink(i.user.id, { id: profile.id, username: profile.username, displayName: profile.displayName }, 'description du profil');
    if (err) return i.editReply({ embeds: [warnEmbed(err)], components: [] });
    return i.editReply({ embeds: [successEmbed(`Compte Roblox **${profile.username}** relié ! Tu peux retirer la phrase de ta description. Tes récompenses débloquées arrivent en jeu automatiquement.`)], components: [] });
  }
  if (action === 'cancel' && i.isButton()) {
    cancelVerification(i.user.id);
    if (fromEphemeralMessage(i)) return i.update({ embeds: [warnEmbed('Liaison annulée.')], components: [] });
    return;
  }
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
