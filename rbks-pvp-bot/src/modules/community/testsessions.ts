import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, SlashCommandBuilder } from 'discord.js';
import { COLORS, SESSION_STATUS } from '../../config/constants';
import { db } from '../../db';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, requireFeature } from '../../bot/reply';
import { brandEmbed, warnEmbed } from '../../bot/ui/embeds';
import { fetchMessage, fetchTextChannel, upsertMessage } from '../../bot/messages';
import { getGuild } from '../../bot/client';
import { channelId } from '../../core/resources';
import { getSetting } from '../../core/settings';
import { withLock } from '../../core/guards';
import { discordTs, formatDuration, parseDate } from '../../core/time';
import { truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../logs/audit';
import { notificationRoleId } from '../notifications';

const log = childLogger('testsessions');

export interface TestSession {
  id: number;
  name: string;
  description: string;
  starts_at: number;
  duration_minutes: number | null;
  slots: number;
  role_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  reminder_sent: number;
  created_by: string | null;
  created_at: number;
}

interface Participant {
  user_id: string;
  status: 'registered' | 'waitlist';
  created_at: number;
}

export const sessions = {
  get: (id: number) => db().prepare('SELECT * FROM test_sessions WHERE id = ?').get(id) as TestSession | undefined,
  list(limit = 50): TestSession[] {
    return db().prepare('SELECT * FROM test_sessions ORDER BY starts_at DESC LIMIT ?').all(limit) as TestSession[];
  },
  upcoming(): TestSession[] {
    return db().prepare("SELECT * FROM test_sessions WHERE status IN ('scheduled','live') ORDER BY starts_at").all() as TestSession[];
  },
  create(s: { name: string; description: string; starts_at: number; duration_minutes: number | null; slots: number; role_id: string | null; channel_id: string; created_by: string }): number {
    return Number(
      db()
        .prepare('INSERT INTO test_sessions (name, description, starts_at, duration_minutes, slots, role_id, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.name, s.description, s.starts_at, s.duration_minutes, s.slots, s.role_id, s.channel_id, s.created_by, Date.now()).lastInsertRowid,
    );
  },
  setMessage: (id: number, ch: string, msg: string) => db().prepare('UPDATE test_sessions SET channel_id = ?, message_id = ? WHERE id = ?').run(ch, msg, id),
  setStatus: (id: number, status: TestSession['status']) => db().prepare('UPDATE test_sessions SET status = ? WHERE id = ?').run(status, id),
  markReminded: (id: number) => db().prepare('UPDATE test_sessions SET reminder_sent = 1 WHERE id = ?').run(id),
  participants: (id: number) => db().prepare('SELECT user_id, status, created_at FROM test_session_participants WHERE session_id = ? ORDER BY created_at').all(id) as Participant[],
  count: () => (db().prepare('SELECT COUNT(*) n FROM test_sessions').get() as { n: number }).n,
};

function sessionPayload(s: TestSession) {
  const parts = sessions.participants(s.id);
  const registered = parts.filter((p) => p.status === 'registered');
  const waitlist = parts.filter((p) => p.status === 'waitlist');
  const st = SESSION_STATUS[s.status];
  const e = brandEmbed({ title: `🎮 ${s.name}`, description: s.description || undefined, color: s.status === 'scheduled' ? COLORS.info : st.color, footerExtra: `Session n°${s.id}` }).addFields(
    { name: 'Date', value: `${discordTs(s.starts_at, 'F')}\n${discordTs(s.starts_at, 'R')}`, inline: true },
    { name: 'Durée', value: s.duration_minutes ? formatDuration(s.duration_minutes * 6e4) : '—', inline: true },
    { name: 'Statut', value: `${st.emoji} ${st.label}`, inline: true },
    { name: 'Places', value: `${registered.length} / ${s.slots} (${Math.max(0, s.slots - registered.length)} restante(s))`, inline: true },
    { name: 'Accès', value: s.role_id ? `<@&${s.role_id}>` : 'Tout le monde', inline: true },
    { name: '​', value: '​', inline: true },
    { name: `Inscrits (${registered.length})`, value: truncate(registered.map((p, i) => `${i + 1}. <@${p.user_id}>`).join('\n') || '—', 1024) },
  );
  if (waitlist.length) e.addFields({ name: `Liste d’attente (${waitlist.length})`, value: truncate(waitlist.map((p, i) => `${i + 1}. <@${p.user_id}>`).join('\n'), 1024) });
  const open = s.status === 'scheduled';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid('ts', 'join', s.id)).setLabel(registered.length >= s.slots ? 'Liste d’attente' : 'S’inscrire').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!open),
    new ButtonBuilder().setCustomId(cid('ts', 'leave', s.id)).setLabel('Se désinscrire').setEmoji('❌').setStyle(ButtonStyle.Secondary).setDisabled(!open),
  );
  return { embeds: [e], components: [row] };
}

export async function refreshSession(id: number): Promise<void> {
  const s = sessions.get(id);
  if (!s?.message_id) return;
  const msg = await fetchMessage(s.channel_id, s.message_id);
  await msg?.edit({ ...sessionPayload(s), allowedMentions: { parse: [] } }).catch((e) => log.warn({ err: e }, 'Mise à jour session impossible'));
}

export async function createSession(input: { name: string; description: string; starts_at: number; duration_minutes: number | null; slots: number; role_id: string | null; channel_id: string; created_by: string; ping: boolean }): Promise<TestSession> {
  const id = sessions.create(input);
  const s = sessions.get(id)!;
  const pingRole = input.ping ? notificationRoleId('sessions') : null;
  const loc = await upsertMessage(input.channel_id, {}, { ...sessionPayload(s), content: pingRole ? `<@&${pingRole}>` : undefined, allowedMentions: { roles: pingRole ? [pingRole] : [] } });
  sessions.setMessage(id, loc.channelId, loc.messageId);
  await audit({ type: 'community', action: 'session_create', actorId: input.created_by, target: `Session n°${id}`, message: `Session de test « ${s.name} » planifiée le ${discordTs(s.starts_at, 'F')}.` });
  return sessions.get(id)!;
}

export async function cancelSession(id: number, actorId: string): Promise<void> {
  const s = sessions.get(id);
  if (!s || s.status === 'cancelled' || s.status === 'ended') return;
  sessions.setStatus(id, 'cancelled');
  await refreshSession(id);
  const guild = getGuild();
  for (const p of sessions.participants(id)) {
    const m = await guild.members.fetch(p.user_id).catch(() => null);
    await m?.send({ embeds: [warnEmbed(`La session de test **${s.name}** prévue ${discordTs(s.starts_at, 'F')} est annulée.`)] }).catch(() => undefined);
  }
  await audit({ type: 'community', action: 'session_cancel', actorId, target: `Session n°${id}`, message: `Session de test « ${s.name} » annulée.` });
}

/** Inscription/désinscription atomique, avec promotion automatique de la liste d'attente. */
async function toggle(s: TestSession, userId: string, join: boolean): Promise<string> {
  return withLock(`ts:${s.id}`, async () => {
    const existing = db().prepare('SELECT status FROM test_session_participants WHERE session_id = ? AND user_id = ?').get(s.id, userId) as { status: string } | undefined;
    if (join) {
      if (existing) return existing.status === 'registered' ? 'Tu es déjà inscrit(e).' : 'Tu es déjà sur la liste d’attente.';
      const count = sessions.participants(s.id).filter((p) => p.status === 'registered').length;
      const status = count >= s.slots ? 'waitlist' : 'registered';
      db().prepare('INSERT INTO test_session_participants (session_id, user_id, status, created_at) VALUES (?, ?, ?, ?)').run(s.id, userId, status, Date.now());
      return status === 'registered' ? `✅ Inscription confirmée pour **${s.name}** (${discordTs(s.starts_at, 'F')}). Tu recevras un rappel.` : '⏳ La session est complète : tu es sur la liste d’attente. Tu seras prévenu(e) si une place se libère.';
    }
    if (!existing) return 'Tu n’es pas inscrit(e) à cette session.';
    db().prepare('DELETE FROM test_session_participants WHERE session_id = ? AND user_id = ?').run(s.id, userId);
    if (existing.status === 'registered') {
      const next = db().prepare("SELECT user_id FROM test_session_participants WHERE session_id = ? AND status = 'waitlist' ORDER BY created_at LIMIT 1").get(s.id) as { user_id: string } | undefined;
      if (next) {
        db().prepare("UPDATE test_session_participants SET status = 'registered' WHERE session_id = ? AND user_id = ?").run(s.id, next.user_id);
        const m = await getGuild().members.fetch(next.user_id).catch(() => null);
        await m?.send({ embeds: [brandEmbed({ title: '🎮 Une place s’est libérée !', description: `Tu es maintenant inscrit(e) à la session **${s.name}** (${discordTs(s.starts_at, 'F')}).` })] }).catch(() => undefined);
      }
    }
    return 'Tu es désinscrit(e).';
  });
}

/** Tâche planifiée : rappels, passage en direct puis fin des sessions. */
export async function tickSessions(): Promise<void> {
  const now = Date.now();
  const reminder = getSetting('testsessions.reminderMinutes') * 6e4;
  for (const s of sessions.upcoming()) {
    try {
      if (s.status === 'scheduled' && !s.reminder_sent && s.starts_at - reminder <= now && s.starts_at > now - 5 * 6e4) {
        sessions.markReminded(s.id);
        const parts = sessions.participants(s.id).filter((p) => p.status === 'registered');
        const guild = getGuild();
        for (const p of parts) {
          const m = await guild.members.fetch(p.user_id).catch(() => null);
          await m
            ?.send({ embeds: [brandEmbed({ title: '⏰ Rappel : session de test', description: `**${s.name}** commence ${discordTs(s.starts_at, 'R')}.${channelId('test_voice') ? `\nRejoins le salon vocal <#${channelId('test_voice')}>.` : ''}` })] })
            .catch(() => undefined);
        }
        const ch = await fetchTextChannel(s.channel_id);
        if (ch && parts.length) await ch.send({ content: `⏰ **${s.name}** commence ${discordTs(s.starts_at, 'R')} ! ${parts.map((p) => `<@${p.user_id}>`).join(' ')}`.slice(0, 2000), allowedMentions: { users: parts.map((p) => p.user_id) } });
      }
      if (s.status === 'scheduled' && s.starts_at <= now) {
        sessions.setStatus(s.id, 'live');
        await refreshSession(s.id);
      } else if (s.status === 'live' && now >= s.starts_at + (s.duration_minutes ?? 120) * 6e4) {
        sessions.setStatus(s.id, 'ended');
        await refreshSession(s.id);
      }
    } catch (e) {
      log.warn({ err: e, session: s.id }, 'Traitement de session impossible');
    }
  }
}

export const testSessionsModule: BotModule = {
  name: 'testsessions',
  components: [
    {
      prefix: 'ts',
      async handle(i: ComponentInteraction, action, args) {
        const s = sessions.get(Number(args[0]));
        if (!s) return fail(i, 'Session introuvable.');
        if (action === 'cancelok') {
          if (!(await requireFeature(i, 'testsessions.manage')) || !i.isButton()) return;
          await i.update({ embeds: [warnEmbed('Annulation…')], components: [] });
          await cancelSession(s.id, i.user.id);
          return i.editReply({ embeds: [warnEmbed(`Session « ${s.name} » annulée, participants prévenus.`)] });
        }
        if (s.status !== 'scheduled') return fail(i, 'Les inscriptions sont closes pour cette session.');
        if (action === 'join' && s.role_id && !i.member.roles.cache.has(s.role_id)) return fail(i, `Cette session est réservée au rôle <@&${s.role_id}>.`);
        const msg = await toggle(s, i.user.id, action === 'join');
        await refreshSession(s.id);
        return ephemeral(i, brandEmbed({ description: msg, timestamp: false }));
      },
    },
  ],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('testsession')
        .setDescription('Sessions de test')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Planifier une session de test')
            .addStringOption((o) => o.setName('nom').setDescription('Nom de la session').setRequired(true).setMaxLength(100))
            .addStringOption((o) => o.setName('date').setDescription('Date et heure (JJ/MM/AAAA HH:MM)').setRequired(true).setMaxLength(20))
            .addIntegerOption((o) => o.setName('places').setDescription('Nombre de places').setRequired(true).setMinValue(1).setMaxValue(500))
            .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(1500))
            .addIntegerOption((o) => o.setName('duree').setDescription('Durée en minutes').setMinValue(5).setMaxValue(1440))
            .addRoleOption((o) => o.setName('role').setDescription('Rôle autorisé à s’inscrire (ex. 🧪 Testeur)'))
            .addChannelOption((o) => o.setName('salon').setDescription('Salon de publication (par défaut #testeurs)').addChannelTypes(ChannelType.GuildText))
            .addBooleanOption((o) => o.setName('notifier').setDescription('Mentionner le rôle « Sessions de test »')),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Sessions à venir'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Annuler une session').addIntegerOption((o) => o.setName('id').setDescription('Numéro de la session').setRequired(true).setMinValue(1))),
      feature: 'testsessions.manage',
      category: '💬 Communauté',
      help: [{ usage: '/testsession create|list|cancel', description: 'Organiser des sessions de test', feature: 'testsessions.manage' }],
      async execute(i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const list = sessions.upcoming();
          const e = brandEmbed({ title: '🎮 Sessions de test à venir', description: list.length ? undefined : 'Aucune session planifiée.' });
          for (const s of list.slice(0, 20)) {
            const n = sessions.participants(s.id).filter((p) => p.status === 'registered').length;
            e.addFields({ name: `n°${s.id} — ${s.name}`, value: `${discordTs(s.starts_at, 'F')} • ${n}/${s.slots} inscrits • ${SESSION_STATUS[s.status].label}` });
          }
          return ephemeral(i, e);
        }
        if (sub === 'cancel') {
          const s = sessions.get(i.options.getInteger('id', true));
          if (!s) return fail(i, 'Session introuvable.');
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(cid('ts', 'cancelok', s.id)).setLabel('Annuler la session').setStyle(ButtonStyle.Danger));
          return ephemeral(i, { embeds: [warnEmbed(`Annuler **${s.name}** ? Les inscrits seront prévenus en MP.`)], components: [row] });
        }
        const startsAt = parseDate(i.options.getString('date', true));
        if (!startsAt) return fail(i, 'Date invalide. Format attendu : JJ/MM/AAAA HH:MM');
        if (startsAt < Date.now()) return fail(i, 'La date est déjà passée.');
        const channel = i.options.getChannel('salon')?.id ?? channelId('testers') ?? i.channelId;
        await deferEphemeral(i);
        const s = await createSession({
          name: i.options.getString('nom', true),
          description: i.options.getString('description') ?? '',
          starts_at: startsAt,
          duration_minutes: i.options.getInteger('duree'),
          slots: i.options.getInteger('places', true),
          role_id: i.options.getRole('role')?.id ?? null,
          channel_id: channel,
          created_by: i.user.id,
          ping: i.options.getBoolean('notifier') ?? false,
        });
        return ephemeral(i, `Session **n°${s.id}** publiée dans <#${s.channel_id}>.`);
      },
    },
  ],
};
