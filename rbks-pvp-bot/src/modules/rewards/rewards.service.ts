import { ChannelType, Events, type Client, type GuildMember } from 'discord.js';
import { env } from '../../config/env';
import { COLORS } from '../../config/constants';
import { db } from '../../db';
import { tryGetGuild } from '../../bot/client';
import { brandEmbed } from '../../bot/ui/embeds';
import { channelId, roleId } from '../../core/resources';
import { debounce } from '../../core/guards';
import { onProgress, progress } from '../../core/progress';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';
import { joins } from '../welcome';
import { activity, challenges, links, unlocks, METRICS, type Challenge, type Metric } from './rewards.repo';
import { notifyGameServers, openCloudConfigured, writeRewardsEntry } from './roblox';

const log = childLogger('rewards');

// ───────────── Calcul de la progression ─────────────

const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...(params as never[])) as { n: number }).n;

/** Valeur actuelle de chaque mesure pour un membre. */
export function metricsFor(userId: string, member: GuildMember | null): Record<Metric, number> {
  const act = activity.get(userId);
  const tester = roleId('tester');
  return {
    linked: links.get(userId) ? 1 : 0,
    invites: joins.statsFor(userId).active,
    beta: count("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND status = 'accepted'", userId) > 0 || (!!tester && !!member?.roles.cache.has(tester)) ? 1 : 0,
    test_sessions: count(
      "SELECT COUNT(*) n FROM test_session_participants p JOIN test_sessions s ON s.id = p.session_id WHERE p.user_id = ? AND p.status = 'registered' AND s.status = 'ended'",
      userId,
    ),
    bugs_resolved: count("SELECT COUNT(*) n FROM bugs WHERE user_id = ? AND status = 'resolved'", userId),
    suggestions_accepted: count("SELECT COUNT(*) n FROM suggestions WHERE user_id = ? AND status IN ('accepted','in_progress','implemented')", userId),
    boost: member?.premiumSinceTimestamp ? 1 : 0,
    voice_minutes: Math.floor(act.voice_seconds / 60),
    messages: act.messages,
    polls: count('SELECT COUNT(DISTINCT poll_id) n FROM poll_votes WHERE user_id = ?', userId),
    announcement_reactions: count('SELECT COUNT(*) n FROM announcement_reactions WHERE user_id = ?', userId),
  };
}

export interface ChallengeProgress {
  challenge: Challenge;
  value: number;
  unlockedAt: number | null;
}

export function progressFor(userId: string, member: GuildMember | null): ChallengeProgress[] {
  const m = metricsFor(userId, member);
  const done = unlocks.forUser(userId);
  return challenges.list(true).map((c) => ({ challenge: c, value: Math.min(m[c.metric] ?? 0, c.threshold), unlockedAt: done.get(c.id) ?? null }));
}

/** Débloque les défis atteints (une récompense débloquée le reste, même si la valeur redescend). */
export async function evaluate(userId: string): Promise<Challenge[]> {
  const guild = tryGetGuild();
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  if (member?.user.bot) return [];
  const m = metricsFor(userId, member);
  const done = unlocks.forUser(userId);
  const fresh: Challenge[] = [];
  for (const c of challenges.list(true)) {
    if (done.has(c.id) || (m[c.metric] ?? 0) < c.threshold) continue;
    if (unlocks.add(userId, c.id)) fresh.push(c);
  }
  if (!fresh.length) return [];
  const link = links.get(userId);
  if (link) {
    links.markDirty(userId);
    void syncUser(userId);
  }
  await audit({ type: 'community', action: 'reward_unlock', actorId: userId, message: `🎁 <@${userId}> a débloqué : ${fresh.map((c) => `**${c.title}** (${c.reward_label})`).join(', ')}.` });
  if (member) {
    const e = brandEmbed({
      title: fresh.length > 1 ? '🎁 Nouvelles récompenses débloquées !' : '🎁 Récompense débloquée !',
      description: fresh.map((c) => `${c.emoji ?? '✅'} **${c.title}** → ${c.reward_label}`).join('\n'),
      color: COLORS.success,
    });
    e.addFields({
      name: 'Comment la récupérer ?',
      value: link
        ? `Elle arrive automatiquement sur ton compte Roblox **${link.roblox_username}** : lance le jeu !`
        : 'Relie ton compte Roblox avec `/rewards` pour la recevoir en jeu (elle reste débloquée en attendant).',
    });
    await member.send({ embeds: [e] }).catch(() => undefined);
  }
  return fresh;
}

/** Les signalements de progression sont regroupés par membre (3 s) pour éviter les calculs inutiles. */
export function scheduleEvaluate(userId: string): void {
  debounce(`rewards:${userId}`, 3000, () => evaluate(userId), (e) => log.warn({ err: e }, 'Évaluation /rewards impossible'));
}

// ───────────── Livraison en jeu (Open Cloud) ─────────────

const syncing = new Set<string>();

export async function syncUser(discordId: string): Promise<{ ok: boolean; error?: string }> {
  const link = links.get(discordId);
  if (!link) return { ok: false, error: 'Compte Roblox non relié.' };
  if (!openCloudConfigured()) return { ok: false, error: 'Open Cloud n’est pas configuré (ROBLOX_OPEN_CLOUD_API_KEY / ROBLOX_UNIVERSE_ID).' };
  if (syncing.has(discordId)) return { ok: true };
  syncing.add(discordId);
  try {
    await writeRewardsEntry({ discordId, robloxId: link.roblox_id, rewards: unlocks.rewardIds(discordId), updatedAt: new Date().toISOString() });
    links.markSynced(discordId);
    await notifyGameServers(link.roblox_id);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    links.markError(discordId, msg);
    log.warn({ err: msg, discordId }, 'Livraison des récompenses impossible (nouvel essai automatique)');
    return { ok: false, error: msg };
  } finally {
    syncing.delete(discordId);
  }
}

/** Tâche périodique : renvoie les livraisons en attente ou échouées. */
export async function syncPending(): Promise<void> {
  if (!openCloudConfigured()) return;
  for (const l of links.dirty().slice(0, 50)) {
    await syncUser(l.discord_id);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ───────────── Suivi de l'activité Discord ─────────────

const MESSAGE_COOLDOWN_MS = 15_000;
const lastMessage = new Map<string, number>();
const ANNOUNCEMENT_WINDOW_MS = 3600_000;

function announcementChannels(): Set<string> {
  return new Set([channelId('announcements'), channelId('updates'), channelId('patchnotes')].filter((x): x is string => !!x));
}

/** Compte une minute pour chaque membre réellement en conversation vocale. */
export function voiceTick(seconds = 60): void {
  const guild = tryGetGuild();
  if (!guild) return;
  const counted: string[] = [];
  for (const ch of guild.channels.cache.values()) {
    if ((ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) || ch.id === guild.afkChannelId) continue;
    const humans = [...ch.members.values()].filter((m) => !m.user.bot);
    if (humans.length < 2) continue; // seul dans un salon : pas compté (anti-farm)
    for (const m of humans) if (!m.voice.deaf) counted.push(m.id); // sourdine casque : pas compté
  }
  if (!counted.length) return;
  const before = new Map(counted.map((id) => [id, Math.floor(activity.get(id).voice_seconds / 60)]));
  activity.addVoice(counted, seconds);
  const thresholds = challenges.thresholds('voice_minutes');
  for (const id of counted) {
    const now = Math.floor(activity.get(id).voice_seconds / 60);
    if (thresholds.some((t) => before.get(id)! < t && now >= t)) scheduleEvaluate(id);
  }
}

let voiceTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;

export function attachRewardTracking(client: Client): void {
  onProgress(scheduleEvaluate);

  client.on(Events.MessageCreate, (msg) => {
    if (!msg.inGuild() || msg.guildId !== env().GUILD_ID || msg.author.bot || msg.system) return;
    if (msg.content.trim().length < 3 && !msg.attachments.size) return;
    const t = Date.now();
    if ((lastMessage.get(msg.author.id) ?? 0) > t - MESSAGE_COOLDOWN_MS) return; // anti-spam : 1 message compté / 15 s
    lastMessage.set(msg.author.id, t);
    if (lastMessage.size > 20_000) lastMessage.clear();
    const total = activity.addMessage(msg.author.id);
    if (challenges.thresholds('messages').includes(total)) scheduleEvaluate(msg.author.id);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot) return;
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (message.guildId !== env().GUILD_ID || !announcementChannels().has(message.channelId)) return;
      // Seulement dans l'heure qui suit la publication, et une seule fois par annonce.
      if (Date.now() - message.createdTimestamp > ANNOUNCEMENT_WINDOW_MS) return;
      if (activity.addAnnouncementReaction(user.id, message.id, message.channelId)) scheduleEvaluate(user.id);
    } catch (e) {
      log.debug({ err: e }, 'Réaction ignorée');
    }
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (newMember.guild.id !== env().GUILD_ID) return;
    if (!oldMember.premiumSinceTimestamp && newMember.premiumSinceTimestamp) progress(newMember.id);
    const tester = roleId('tester');
    if (tester && !oldMember.roles.cache.has(tester) && newMember.roles.cache.has(tester)) progress(newMember.id);
  });

  client.once(Events.ClientReady, () => {
    voiceTimer = setInterval(() => {
      try {
        voiceTick(60);
      } catch (e) {
        log.warn({ err: e }, 'Comptage vocal impossible');
      }
    }, 60_000);
    syncTimer = setInterval(() => void syncPending().catch(() => undefined), 5 * 60_000);
    setTimeout(() => void syncPending().catch(() => undefined), 20_000);
  });
}

export function stopRewardTimers(): void {
  if (voiceTimer) clearInterval(voiceTimer);
  if (syncTimer) clearInterval(syncTimer);
}

export function metricLabel(metric: Metric, value: number, threshold: number): string {
  const meta = METRICS[metric];
  if (threshold <= 1 && !meta.unit) return value >= 1 ? 'fait' : 'à faire';
  return `${value}/${threshold}${meta.unit ? ` ${meta.unit}` : ''}`;
}
