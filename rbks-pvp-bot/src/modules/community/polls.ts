import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS } from '../../config/constants';
import { db, parseJson } from '../../db';
import type { BotModule, ComponentInteraction } from '../../bot/types';
import { cid } from '../../bot/types';
import { deferEphemeral, ephemeral, fail, openModal, requireFeature } from '../../bot/reply';
import { brandEmbed, infoEmbed } from '../../bot/ui/embeds';
import { fetchMessage, upsertMessage } from '../../bot/messages';
import { withLock } from '../../core/guards';
import { discordTs, parseDuration } from '../../core/time';
import { progressBar, sanitizeMentions, splitLines, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../logs/audit';

const log = childLogger('polls');
const MAX_OPTIONS = 20;

export interface Poll {
  id: number;
  question: string;
  options: string;
  multi: number;
  anonymous: number;
  live_results: number;
  ends_at: number | null;
  channel_id: string | null;
  message_id: string | null;
  status: 'open' | 'closed';
  created_by: string | null;
  created_at: number;
}

export const optionsOf = (p: Poll) => parseJson<string[]>(p.options, []);

export const polls = {
  get: (id: number) => db().prepare('SELECT * FROM polls WHERE id = ?').get(id) as Poll | undefined,
  list: (limit = 50) => db().prepare('SELECT * FROM polls ORDER BY id DESC LIMIT ?').all(limit) as Poll[],
  open: () => db().prepare("SELECT * FROM polls WHERE status = 'open'").all() as Poll[],
  create(p: { question: string; options: string[]; multi: boolean; anonymous: boolean; live: boolean; ends_at: number | null; created_by: string }): number {
    return Number(
      db()
        .prepare('INSERT INTO polls (question, options, multi, anonymous, live_results, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.question, JSON.stringify(p.options), p.multi ? 1 : 0, p.anonymous ? 1 : 0, p.live ? 1 : 0, p.ends_at, p.created_by, Date.now()).lastInsertRowid,
    );
  },
  setMessage: (id: number, ch: string, msg: string) => db().prepare('UPDATE polls SET channel_id = ?, message_id = ? WHERE id = ?').run(ch, msg, id),
  close: (id: number) => db().prepare("UPDATE polls SET status = 'closed' WHERE id = ? AND status = 'open'").run(id).changes === 1,
  results(id: number): { counts: number[]; voters: number } {
    const p = polls.get(id)!;
    const counts = optionsOf(p).map(() => 0);
    for (const r of db().prepare('SELECT option_index, COUNT(*) n FROM poll_votes WHERE poll_id = ? GROUP BY option_index').all(id) as { option_index: number; n: number }[]) {
      if (r.option_index < counts.length) counts[r.option_index] = r.n;
    }
    const voters = (db().prepare('SELECT COUNT(DISTINCT user_id) n FROM poll_votes WHERE poll_id = ?').get(id) as { n: number }).n;
    return { counts, voters };
  },
  votersByOption(id: number): Map<number, string[]> {
    const map = new Map<number, string[]>();
    for (const r of db().prepare('SELECT option_index, user_id FROM poll_votes WHERE poll_id = ? ORDER BY created_at').all(id) as { option_index: number; user_id: string }[]) {
      map.set(r.option_index, [...(map.get(r.option_index) ?? []), r.user_id]);
    }
    return map;
  },
  /** Remplace les choix du membre (transaction). */
  vote(id: number, userId: string, indexes: number[]): void {
    db().transaction(() => {
      db().prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(id, userId);
      const stmt = db().prepare('INSERT INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)');
      for (const idx of indexes) stmt.run(id, userId, idx, Date.now());
    })();
  },
  myVotes: (id: number, userId: string) => (db().prepare('SELECT option_index FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(id, userId) as { option_index: number }[]).map((r) => r.option_index),
};

const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯', '🇰', '🇱', '🇲', '🇳', '🇴', '🇵', '🇶', '🇷', '🇸', '🇹'];

export function pollPayload(p: Poll) {
  const opts = optionsOf(p);
  const { counts, voters } = polls.results(p.id);
  const total = counts.reduce((a, b) => a + b, 0);
  const closed = p.status === 'closed';
  const showResults = closed || !!p.live_results;
  const max = Math.max(...counts);
  const lines = opts.map((o, i) => {
    const pct = total ? (counts[i] / total) * 100 : 0;
    const crown = closed && total && counts[i] === max ? ' 🏆' : '';
    return showResults ? `${LETTERS[i]} **${o}**${crown}\n\`${progressBar(pct, 12)}\` — ${counts[i]} vote(s)` : `${LETTERS[i]} **${o}**`;
  });
  const e = brandEmbed({
    title: `📊 ${p.question}`,
    description: truncate(lines.join('\n\n'), 4096),
    color: closed ? COLORS.muted : undefined,
    footerExtra: `Sondage n°${p.id}${p.anonymous ? ' • votes anonymes' : ' • votes publics'}${p.multi ? ' • choix multiples' : ''}`,
  }).addFields(
    { name: 'Participants', value: String(voters), inline: true },
    { name: closed ? 'Terminé' : 'Fin', value: closed ? '✅ Résultats définitifs' : p.ends_at ? discordTs(p.ends_at, 'R') : 'Fermeture manuelle', inline: true },
  );
  if (!showResults) e.addFields({ name: 'Résultats', value: 'Visibles à la fin du sondage', inline: true });
  const components: ActionRowBuilder<any>[] = [];
  if (!closed) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid('poll', 'vote', p.id))
          .setPlaceholder(p.multi ? 'Choisis une ou plusieurs réponses' : 'Choisis ta réponse')
          .setMinValues(1)
          .setMaxValues(p.multi ? opts.length : 1)
          .addOptions(opts.map((o, i) => ({ label: truncate(o, 100), value: String(i), emoji: LETTERS[i] }))),
      ),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!closed) row.addComponents(new ButtonBuilder().setCustomId(cid('poll', 'clear', p.id)).setLabel('Retirer mon vote').setStyle(ButtonStyle.Secondary));
  if (!p.anonymous && showResults) row.addComponents(new ButtonBuilder().setCustomId(cid('poll', 'voters', p.id)).setLabel('Voir les votants').setEmoji('👥').setStyle(ButtonStyle.Secondary));
  if (row.components.length) components.push(row);
  return { embeds: [e], components };
}

export async function refreshPoll(id: number): Promise<void> {
  const p = polls.get(id);
  if (!p?.message_id) return;
  const msg = await fetchMessage(p.channel_id, p.message_id);
  await msg?.edit(pollPayload(p)).catch((e) => log.warn({ err: e }, 'Mise à jour sondage impossible'));
}

export async function createPoll(input: { question: string; options: string[]; multi: boolean; anonymous: boolean; live: boolean; durationMs: number | null; channelId: string; createdBy: string }): Promise<Poll> {
  const id = polls.create({ ...input, ends_at: input.durationMs ? Date.now() + input.durationMs : null, created_by: input.createdBy });
  const loc = await upsertMessage(input.channelId, {}, pollPayload(polls.get(id)!));
  polls.setMessage(id, loc.channelId, loc.messageId);
  await audit({ type: 'community', action: 'poll_create', actorId: input.createdBy, target: `Sondage n°${id}`, message: `Sondage créé : « ${input.question} ».` });
  return polls.get(id)!;
}

export async function endPoll(id: number, actorId: string | null): Promise<boolean> {
  if (!polls.close(id)) return false;
  await refreshPoll(id);
  const p = polls.get(id)!;
  await audit({ type: 'community', action: 'poll_end', actorId, target: `Sondage n°${id}`, message: `Sondage terminé : « ${p.question} ».` });
  return true;
}

/** Tâche planifiée : ferme les sondages arrivés à échéance (y compris pendant un arrêt du bot). */
export async function tickPolls(): Promise<void> {
  for (const p of polls.open()) if (p.ends_at && p.ends_at <= Date.now()) await endPoll(p.id, null).catch((e) => log.warn({ err: e }, 'Clôture sondage impossible'));
}

export function parsePollOptions(raw: string): { ok: true; options: string[] } | { ok: false; error: string } {
  const options = [...new Set(splitLines(raw).map((o) => o.slice(0, 100)))];
  if (options.length < 2) return { ok: false, error: 'Indique au moins 2 réponses (une par ligne).' };
  if (options.length > MAX_OPTIONS) return { ok: false, error: `${MAX_OPTIONS} réponses maximum.` };
  return { ok: true, options };
}

export const pollsModule: BotModule = {
  name: 'polls',
  components: [
    {
      prefix: 'poll',
      async handle(i: ComponentInteraction, action, args) {
        if (action === 'create' && i.isModalSubmit()) {
          if (!(await requireFeature(i, 'polls.manage'))) return;
          const [multi, anon, live, duration, channel] = args;
          const parsed = parsePollOptions(i.fields.getTextInputValue('options'));
          if (!parsed.ok) return fail(i, parsed.error);
          await deferEphemeral(i);
          const p = await createPoll({
            question: sanitizeMentions(i.fields.getTextInputValue('question').trim()),
            options: parsed.options,
            multi: multi === '1',
            anonymous: anon === '1',
            live: live === '1',
            durationMs: Number(duration) || null,
            channelId: channel,
            createdBy: i.user.id,
          });
          return ephemeral(i, `Sondage **n°${p.id}** publié dans <#${p.channel_id}>.`);
        }
        const p = polls.get(Number(args[0]));
        if (!p) return fail(i, 'Sondage introuvable.');
        if (action === 'voters') {
          if (p.anonymous) return fail(i, 'Ce sondage est anonyme.');
          const by = polls.votersByOption(p.id);
          const e = brandEmbed({ title: `👥 Votants — ${truncate(p.question, 200)}` });
          optionsOf(p).forEach((o, idx) => e.addFields({ name: `${LETTERS[idx]} ${truncate(o, 200)}`, value: truncate((by.get(idx) ?? []).map((u) => `<@${u}>`).join(' ') || '—', 1024) }));
          return ephemeral(i, e);
        }
        if (p.status !== 'open' || (p.ends_at && p.ends_at <= Date.now())) return fail(i, 'Ce sondage est terminé.');
        if (action === 'vote' && i.isStringSelectMenu()) {
          const indexes = i.values.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < optionsOf(p).length);
          if (!indexes.length || (!p.multi && indexes.length > 1)) return fail(i, 'Choix invalide.');
          await withLock(`poll:${p.id}`, async () => polls.vote(p.id, i.user.id, indexes));
          await i.update(pollPayload(polls.get(p.id)!));
          return ephemeral(i, infoEmbed(`Vote enregistré : ${indexes.map((x) => `${LETTERS[x]} ${optionsOf(p)[x]}`).join(', ')}`));
        }
        if (action === 'clear' && i.isButton()) {
          if (!polls.myVotes(p.id, i.user.id).length) return fail(i, 'Tu n’as pas encore voté.');
          polls.vote(p.id, i.user.id, []);
          await i.update(pollPayload(polls.get(p.id)!));
          return ephemeral(i, infoEmbed('Ton vote a été retiré.'));
        }
      },
    },
  ],
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Sondages')
        .addSubcommand((s) =>
          s
            .setName('create')
            .setDescription('Créer un sondage')
            .addStringOption((o) => o.setName('duree').setDescription('Durée (ex. 30m, 2h, 3j). Vide = fermeture manuelle').setMaxLength(10))
            .addBooleanOption((o) => o.setName('choix_multiples').setDescription('Autoriser plusieurs réponses'))
            .addBooleanOption((o) => o.setName('anonyme').setDescription('Votes anonymes (par défaut : oui)'))
            .addBooleanOption((o) => o.setName('resultats_en_direct').setDescription('Afficher les résultats pendant le vote (par défaut : oui)'))
            .addChannelOption((o) => o.setName('salon').setDescription('Salon de publication').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
        )
        .addSubcommand((s) => s.setName('end').setDescription('Terminer un sondage').addIntegerOption((o) => o.setName('id').setDescription('Numéro du sondage').setRequired(true).setMinValue(1))),
      feature: 'polls.manage',
      category: '💬 Communauté',
      help: [{ usage: '/poll create|end', description: 'Créer et clôturer des sondages', feature: 'polls.manage' }],
      async execute(i) {
        if (i.options.getSubcommand() === 'end') {
          const ok = await endPoll(i.options.getInteger('id', true), i.user.id);
          return ok ? ephemeral(i, 'Sondage terminé, résultats affichés.') : fail(i, 'Sondage introuvable ou déjà terminé.');
        }
        const durRaw = i.options.getString('duree');
        const duration = durRaw ? parseDuration(durRaw) : null;
        if (durRaw && !duration) return fail(i, 'Durée invalide. Exemples : 30m, 2h, 1h30, 3j.');
        if (duration && duration > 60 * 864e5) return fail(i, '60 jours maximum.');
        const flag = (name: string, def: boolean) => ((i.options.getBoolean(name) ?? def) ? '1' : '0');
        const channel = i.options.getChannel('salon')?.id ?? i.channelId;
        return openModal(
          i,
          new ModalBuilder()
            .setCustomId(cid('poll', 'create', flag('choix_multiples', false), flag('anonyme', true), flag('resultats_en_direct', true), duration ?? 0, channel))
            .setTitle('Nouveau sondage')
            .addLabelComponents(
              new LabelBuilder().setLabel('Question').setTextInputComponent(new TextInputBuilder().setCustomId('question').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
              new LabelBuilder()
                .setLabel('Réponses (une par ligne)')
                .setDescription(`2 à ${MAX_OPTIONS} réponses`)
                .setTextInputComponent(new TextInputBuilder().setCustomId('options').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000).setPlaceholder('Mode classé\nMode 2v2\nNouvelle map')),
            ),
        );
      },
    },
  ],
};
