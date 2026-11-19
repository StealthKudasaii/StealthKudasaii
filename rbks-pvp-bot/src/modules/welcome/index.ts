import { Events, SlashCommandBuilder, type Client, type Guild, type GuildMember, type PartialGuildMember } from 'discord.js';
import { env } from '../../config/env';
import { db } from '../../db';
import type { BotModule } from '../../bot/types';
import { brandEmbed } from '../../bot/ui/embeds';
import { ephemeral } from '../../bot/reply';
import { fetchTextChannel } from '../../bot/messages';
import { channelId } from '../../core/resources';
import { getSetting } from '../../core/settings';
import { withLock } from '../../core/guards';
import { discordTs } from '../../core/time';
import { isHttpUrl, normalizeName, sanitizeMentions, truncate } from '../../core/text';
import { tryGetGuild } from '../../bot/client';
import { ChannelType } from 'discord.js';
import { childLogger } from '../../core/logger';
import { progress } from '../../core/progress';

const log = childLogger('welcome');

// ───────────── Suivi des invitations ─────────────
// Discord n'indique pas qui a invité un nouveau membre : on mémorise le nombre d'utilisations
// de chaque lien d'invitation et on regarde lequel a augmenté à chaque arrivée.

const inviteUses = new Map<string, { uses: number; inviterId: string | null }>();
let vanityUses: number | null = null;
let cacheReady = false;

export async function loadInviteCache(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    inviteUses.clear();
    for (const inv of invites.values()) inviteUses.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviterId ?? null });
    vanityUses = guild.vanityURLCode ? ((await guild.fetchVanityData().catch(() => null))?.uses ?? null) : null;
    cacheReady = true;
  } catch (e) {
    cacheReady = false;
    log.warn({ err: e }, 'Lecture des invitations impossible (permission « Gérer le serveur » manquante ?)');
  }
}

export interface JoinSource {
  source: 'invite' | 'vanity' | 'unknown';
  code: string | null;
  inviterId: string | null;
}

/** Compare l'état des invitations avant/après une arrivée pour trouver le lien utilisé. */
export function detectInvite(
  before: Map<string, { uses: number; inviterId: string | null }>,
  after: { code: string; uses: number; inviterId: string | null }[],
  vanityBefore: number | null,
  vanityAfter: number | null,
): JoinSource {
  const increased = after.filter((inv) => inv.uses > (before.get(inv.code)?.uses ?? 0));
  if (increased.length === 1) return { source: 'invite', code: increased[0].code, inviterId: increased[0].inviterId };
  if (increased.length === 0) {
    // Lien à usage limité qui vient d'atteindre son maximum : il disparaît de la liste.
    const vanished = [...before.entries()].filter(([code]) => !after.some((a) => a.code === code));
    if (vanityBefore !== null && vanityAfter !== null && vanityAfter > vanityBefore) return { source: 'vanity', code: null, inviterId: null };
    if (vanished.length === 1) return { source: 'invite', code: vanished[0][0], inviterId: vanished[0][1].inviterId };
  }
  return { source: 'unknown', code: null, inviterId: null };
}

async function resolveJoin(guild: Guild): Promise<JoinSource> {
  if (!cacheReady) {
    await loadInviteCache(guild);
    return { source: 'unknown', code: null, inviterId: null };
  }
  try {
    const fresh = await guild.invites.fetch();
    const after = [...fresh.values()].map((i) => ({ code: i.code, uses: i.uses ?? 0, inviterId: i.inviterId ?? null }));
    const vanityAfter = guild.vanityURLCode ? ((await guild.fetchVanityData().catch(() => null))?.uses ?? null) : null;
    const result = detectInvite(inviteUses, after, vanityUses, vanityAfter);
    inviteUses.clear();
    for (const a of after) inviteUses.set(a.code, { uses: a.uses, inviterId: a.inviterId });
    vanityUses = vanityAfter;
    return result;
  } catch (e) {
    log.warn({ err: e }, 'Détection de l’invitation impossible');
    return { source: 'unknown', code: null, inviterId: null };
  }
}

export const joins = {
  record(userId: string, s: JoinSource): void {
    db()
      .prepare('INSERT INTO member_joins (user_id, inviter_id, invite_code, source, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, s.inviterId, s.code, s.source, Date.now());
  },
  markLeft(userId: string): void {
    db().prepare('UPDATE member_joins SET left_at = ? WHERE id = (SELECT MAX(id) FROM member_joins WHERE user_id = ?) AND left_at IS NULL').run(Date.now(), userId);
  },
  /** Statistiques d'un parrain : on ne compte que la dernière arrivée de chaque membre (un retour ne compte pas double). */
  statsFor(inviterId: string): { total: number; active: number; left: number } {
    const r = db()
      .prepare(
        `SELECT COUNT(*) total, COALESCE(SUM(left_at IS NULL), 0) active FROM member_joins j
         WHERE inviter_id = ? AND user_id != ? AND id = (SELECT MAX(id) FROM member_joins WHERE user_id = j.user_id)`,
      )
      .get(inviterId, inviterId) as { total: number; active: number };
    return { total: r.total, active: r.active, left: r.total - r.active };
  },
  invitedBy(inviterId: string, limit = 15): { user_id: string; joined_at: number; left_at: number | null }[] {
    return db()
      .prepare(
        `SELECT user_id, joined_at, left_at FROM member_joins j
         WHERE inviter_id = ? AND user_id != ? AND id = (SELECT MAX(id) FROM member_joins WHERE user_id = j.user_id)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(inviterId, inviterId, limit) as { user_id: string; joined_at: number; left_at: number | null }[];
  },
  top(limit = 10): { inviter_id: string; active: number; total: number }[] {
    return db()
      .prepare(
        `SELECT inviter_id, COALESCE(SUM(left_at IS NULL), 0) active, COUNT(*) total FROM member_joins j
         WHERE inviter_id IS NOT NULL AND inviter_id != user_id AND id = (SELECT MAX(id) FROM member_joins WHERE user_id = j.user_id)
         GROUP BY inviter_id ORDER BY active DESC, total DESC LIMIT ?`,
      )
      .all(limit) as { inviter_id: string; active: number; total: number }[];
  },
  inviterOf(userId: string): JoinSource | null {
    const r = db().prepare('SELECT inviter_id, invite_code, source FROM member_joins WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) as
      | { inviter_id: string | null; invite_code: string | null; source: JoinSource['source'] }
      | undefined;
    return r ? { inviterId: r.inviter_id, code: r.invite_code, source: r.source } : null;
  },
};

// ───────────── Message de bienvenue ─────────────

/**
 * Salon de bienvenue : celui choisi avec /salon ou dans le panel, sinon celui créé par /setup,
 * sinon un salon existant dont le nom contient « bienvenue » ou « welcome » (aucune création nécessaire).
 */
export function welcomeChannelId(): string | null {
  const configured = channelId('welcome');
  if (configured) return configured;
  const guild = tryGetGuild();
  if (!guild) return null;
  const found = guild.channels.cache.find(
    (c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && /bienvenu|welcome/.test(normalizeName(c.name)),
  );
  return found?.id ?? null;
}

export interface WelcomeContext {
  userId: string;
  displayName: string;
  memberCount: number;
  join: JoinSource;
  inviterInvites: number | null;
}

export function renderWelcome(template: string, ctx: WelcomeContext): string {
  const ch = (key: Parameters<typeof channelId>[0], fallback: string) => (channelId(key) ? `<#${channelId(key)}>` : fallback);
  const inviter = ctx.join.inviterId ? `<@${ctx.join.inviterId}>` : ctx.join.source === 'vanity' ? 'le lien du serveur' : 'un lien inconnu';
  return template
    .replace(/\{membre\}/gi, `<@${ctx.userId}>`)
    .replace(/\{pseudo\}/gi, ctx.displayName)
    .replace(/\{serveur\}/gi, getSetting('brand.name'))
    .replace(/\{nombre\}/gi, String(ctx.memberCount))
    .replace(/\{invitepar\}/gi, inviter)
    .replace(/\{invitations\}/gi, ctx.inviterInvites === null ? '—' : String(ctx.inviterInvites))
    .replace(/\{regles\}/gi, ch('rules', '#règlement'))
    .replace(/\{notifications\}/gi, ch('notifications', '#notifications'));
}

export function welcomeEmbed(ctx: WelcomeContext, avatarUrl: string | null) {
  const e = brandEmbed({ title: `👋 Bienvenue sur ${getSetting('brand.name')} !`, description: sanitizeMentions(renderWelcome(getSetting('welcome.message'), ctx)) });
  if (avatarUrl) e.setThumbnail(avatarUrl);
  const img = getSetting('welcome.imageUrl');
  if (img && isHttpUrl(img)) e.setImage(img);
  if (ctx.join.inviterId) e.addFields({ name: 'Invité par', value: `<@${ctx.join.inviterId}>${ctx.inviterInvites !== null ? ` • ${ctx.inviterInvites} invitation(s)` : ''}`, inline: true });
  else if (ctx.join.source === 'vanity') e.addFields({ name: 'Arrivé via', value: 'le lien personnalisé du serveur', inline: true });
  e.addFields({ name: 'Membres', value: String(ctx.memberCount), inline: true });
  return e;
}

async function onJoin(member: GuildMember): Promise<JoinSource> {
  const join = await withLock('invites', () => resolveJoin(member.guild));
  joins.record(member.id, join);
  progress(join.inviterId);
  if (member.user.bot) return join;
  const ctx: WelcomeContext = {
    userId: member.id,
    displayName: member.displayName,
    memberCount: member.guild.memberCount,
    join,
    inviterInvites: join.inviterId ? joins.statsFor(join.inviterId).active : null,
  };
  if (getSetting('welcome.enabled')) {
    const ch = await fetchTextChannel(welcomeChannelId()).catch(() => null);
    if (ch) {
      await ch
        .send({ content: `<@${member.id}>`, embeds: [welcomeEmbed(ctx, member.displayAvatarURL({ size: 256 }))], allowedMentions: { users: [member.id] } })
        .catch((e) => log.warn({ err: e }, 'Message de bienvenue impossible'));
    }
  }
  if (getSetting('welcome.dmEnabled')) {
    await member.send({ embeds: [brandEmbed({ title: `👋 Bienvenue sur ${getSetting('brand.name')} !`, description: sanitizeMentions(renderWelcome(getSetting('welcome.dmMessage'), ctx)) })] }).catch(() => undefined);
  }
  return join;
}

/** Branché sur les événements Discord ; retourne la source d'arrivée pour enrichir le log « Arrivée ». */
export function attachWelcome(client: Client, onJoined: (member: GuildMember, join: JoinSource) => Promise<void>, onLeft: (member: GuildMember | PartialGuildMember) => Promise<void>): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== env().GUILD_ID) return;
    const join = await onJoin(member).catch((e) => {
      log.error({ err: e }, 'Traitement de l’arrivée impossible');
      return { source: 'unknown', code: null, inviterId: null } as JoinSource;
    });
    await onJoined(member, join);
  });
  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== env().GUILD_ID) return;
    joins.markLeft(member.id);
    await onLeft(member);
  });
  client.on(Events.InviteCreate, (inv) => {
    if (inv.guild?.id === env().GUILD_ID) inviteUses.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviterId ?? null });
  });
  client.on(Events.InviteDelete, (inv) => {
    // On garde un court instant le lien supprimé : il peut s'agir d'un lien à usage limité qui vient de servir.
    if (inv.guild?.id === env().GUILD_ID) setTimeout(() => inviteUses.delete(inv.code), 10_000);
  });
}

// ───────────── Commande /invites ─────────────

export const welcomeModule: BotModule = {
  name: 'welcome',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('invites')
        .setDescription('Invitations sur le serveur')
        .addSubcommand((s) => s.setName('voir').setDescription('Nombre d’invitations d’un membre').addUserOption((o) => o.setName('membre').setDescription('Membre (toi par défaut)')))
        .addSubcommand((s) => s.setName('classement').setDescription('Classement des membres qui ont le plus invité')),
      category: '💬 Communauté',
      help: [{ usage: '/invites voir [membre] | classement', description: 'Compter les invitations' }],
      async execute(i) {
        if (i.options.getSubcommand() === 'classement') {
          const top = joins.top(10);
          const medals = ['🥇', '🥈', '🥉'];
          const e = brandEmbed({
            title: '🏆 Classement des invitations',
            description: top.length
              ? top.map((t, idx) => `${medals[idx] ?? `**${idx + 1}.**`} <@${t.inviter_id}> — **${t.active}** invitation(s)${t.total > t.active ? ` *(+${t.total - t.active} parti(s))*` : ''}`).join('\n')
              : 'Aucune invitation enregistrée pour le moment.',
          });
          e.setFooter({ text: 'Seuls les membres encore présents comptent. Les arrivées antérieures à l’installation de ce système ne sont pas connues.' });
          return ephemeral(i, e);
        }
        const user = i.options.getUser('membre') ?? i.user;
        const s = joins.statsFor(user.id);
        const list = joins.invitedBy(user.id, 15);
        const mine = joins.inviterOf(user.id);
        const e = brandEmbed({ title: `📨 Invitations de ${user.username}` }).addFields(
          { name: 'Invitations', value: `**${s.active}**`, inline: true },
          { name: 'Partis depuis', value: String(s.left), inline: true },
          { name: 'Total', value: String(s.total), inline: true },
        );
        if (list.length) e.addFields({ name: 'Derniers membres invités', value: truncate(list.map((x) => `${x.left_at ? '~~' : ''}<@${x.user_id}>${x.left_at ? '~~' : ''} • ${discordTs(x.joined_at, 'R')}`).join('\n'), 1024) });
        if (mine?.inviterId) e.addFields({ name: 'A été invité par', value: `<@${mine.inviterId}>` });
        if (!s.total && !list.length) e.setDescription('Aucune invitation enregistrée pour ce membre.');
        return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
      },
    },
  ],
};

