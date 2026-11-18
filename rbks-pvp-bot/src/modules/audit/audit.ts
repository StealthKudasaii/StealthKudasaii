import type { EmbedBuilder } from 'discord.js';
import { db, parseJson } from '../../db';
import { getSetting } from '../../core/settings';
import { channelId } from '../../core/resources';
import { childLogger } from '../../core/logger';
import { brandEmbed } from '../../bot/ui/embeds';
import { fetchTextChannel } from '../../bot/messages';
import { isBotReady } from '../../bot/client';
import { truncate } from '../../core/text';
import { COLORS } from '../../config/constants';

const log = childLogger('audit');

export const LOG_TYPES = {
  members: { label: 'Arrivées et départs', emoji: '👋' },
  sanctions: { label: 'Sanctions', emoji: '🔨' },
  tickets: { label: 'Tickets', emoji: '🎫' },
  applications: { label: 'Candidatures', emoji: '📋' },
  roadmap: { label: 'Roadmap et versions', emoji: '🗺️' },
  tasks: { label: 'Tâches', emoji: '📝' },
  publications: { label: 'Annonces et patch notes', emoji: '📢' },
  community: { label: 'Suggestions, bugs, sessions, sondages', emoji: '💬' },
  admin: { label: 'Actions administratives', emoji: '⚙️' },
} as const;
export type LogType = keyof typeof LOG_TYPES;

export interface AuditEntry {
  id: number;
  type: LogType;
  action: string;
  actor_id: string | null;
  target: string | null;
  message: string;
  data: string | null;
  created_at: number;
}

export interface LogInput {
  type: LogType;
  action: string;
  actorId?: string | null;
  target?: string | null;
  message: string;
  data?: Record<string, unknown>;
  color?: number;
  /** Embed personnalisé envoyé dans le salon de logs (sinon embed générique). */
  embed?: EmbedBuilder;
  files?: { attachment: Buffer | string; name: string }[];
}

/** Enregistre l'événement en base, puis l'envoie dans le salon de logs si ce type est activé. */
export async function audit(input: LogInput): Promise<void> {
  try {
    db()
      .prepare('INSERT INTO audit_logs (type, action, actor_id, target, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.type, input.action, input.actorId ?? null, input.target ?? null, input.message, input.data ? JSON.stringify(input.data) : null, Date.now());
  } catch (e) {
    log.error({ err: e }, 'Écriture du log impossible');
  }
  if (!isBotReady()) return;
  const enabled = getSetting('logs.enabled');
  if (enabled[input.type] === false) return;
  try {
    const ch = await fetchTextChannel(channelId('logs'));
    if (!ch) return;
    const meta = LOG_TYPES[input.type];
    const embed =
      input.embed ??
      brandEmbed({ title: `${meta.emoji} ${meta.label}`, description: truncate(input.message, 4000), color: input.color ?? COLORS.dark }).addFields(
        ...(input.actorId ? [{ name: 'Par', value: `<@${input.actorId}>`, inline: true }] : []),
        ...(input.target ? [{ name: 'Cible', value: truncate(input.target, 1024), inline: true }] : []),
      );
    await ch.send({ embeds: [embed], files: input.files ?? [], allowedMentions: { parse: [] } });
  } catch (e) {
    log.warn({ err: e }, 'Envoi du log Discord impossible');
  }
}

export function listLogs(opts: { type?: string; limit?: number; offset?: number } = {}): { rows: AuditEntry[]; total: number } {
  const where = opts.type ? 'WHERE type = ?' : '';
  const params = opts.type ? [opts.type] : [];
  const rows = db()
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as AuditEntry[];
  const total = (db().prepare(`SELECT COUNT(*) n FROM audit_logs ${where}`).get(...params) as { n: number }).n;
  return { rows, total };
}

export function logData(entry: AuditEntry): Record<string, unknown> {
  return parseJson(entry.data, {});
}
