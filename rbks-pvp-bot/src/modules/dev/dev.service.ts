import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  COLORS,
  ROADMAP_STATUS,
  TASK_PRIORITY,
  TASK_STATUS,
  VERSION_STATUS,
  type RoadmapStatus,
  type TaskStatus,
} from '../../config/constants';
import { brandEmbed } from '../../bot/ui/embeds';
import { deleteMessage, fetchMessage, upsertMessage } from '../../bot/messages';
import { cid } from '../../bot/types';
import { channelId } from '../../core/resources';
import { debounce } from '../../core/guards';
import { getSetting, setSetting } from '../../core/settings';
import { discordTs } from '../../core/time';
import { progressBar, truncate } from '../../core/text';
import { childLogger } from '../../core/logger';
import { audit } from '../audit/audit';
import { featuresOf, roadmap, tasks, versions, type RoadmapItem, type Task, type Version } from './dev.repo';

const log = childLogger('dev');
const onError = (what: string) => (e: unknown) => log.warn({ err: e }, `Mise à jour Discord impossible : ${what}`);

// ───────────── Versions (#release) ─────────────

export function versionEmbed(v: Version) {
  const st = VERSION_STATUS[v.status] ?? VERSION_STATUS.planned;
  const feats = featuresOf(v);
  const lines = feats.map((f) => (/^\[x\]\s*/i.test(f) ? `✅ ${f.replace(/^\[x\]\s*/i, '')}` : `▫️ ${f.replace(/^\[\s?\]\s*/, '')}`));
  const e = brandEmbed({ title: `${st.emoji} ${v.version} — ${v.name}`, description: v.description || undefined, color: st.color, footerExtra: 'Version' });
  if (lines.length) e.addFields({ name: 'Fonctionnalités prévues', value: truncate(lines.join('\n'), 1024) });
  e.addFields({ name: 'Statut', value: st.label, inline: true }, { name: 'Date prévisionnelle', value: v.target_date ? discordTs(v.target_date, 'D') : 'À définir', inline: true });
  if (v.progress !== null && v.progress !== undefined) e.addFields({ name: 'Progression', value: progressBar(v.progress), inline: false });
  return e;
}

export async function syncVersion(id: number): Promise<void> {
  const v = versions.get(id);
  const target = channelId('release');
  if (!v || !target) return;
  const loc = await upsertMessage(target, { channelId: v.channel_id, messageId: v.message_id }, { embeds: [versionEmbed(v)] });
  versions.update(v.id, { message_id: loc.messageId, channel_id: loc.channelId });
}

export const scheduleVersionSync = (id: number) => debounce(`version:${id}`, 1000, () => syncVersion(id), onError('version'));

export async function deleteVersion(id: number, actorId: string): Promise<void> {
  const v = versions.get(id);
  if (!v) return;
  await deleteMessage(v.channel_id, v.message_id);
  versions.remove(id);
  await audit({ type: 'roadmap', action: 'version_delete', actorId, target: v.version, message: `Version ${v.version} supprimée.` });
}

// ───────────── Tâches (#to-do) ─────────────

export function taskEmbed(t: Task) {
  const st = TASK_STATUS[t.status] ?? TASK_STATUS.todo;
  const pr = TASK_PRIORITY[t.priority] ?? TASK_PRIORITY.medium;
  const overdue = t.due_date && t.status !== 'done' && t.due_date < Date.now();
  const e = brandEmbed({ title: `${st.emoji} ${t.title}`, description: t.description || undefined, color: st.color, footerExtra: `Tâche n°${t.id}` }).addFields(
    { name: 'Statut', value: st.label, inline: true },
    { name: 'Priorité', value: `${pr.emoji} ${pr.label}`, inline: true },
    { name: 'Catégorie', value: t.category, inline: true },
    { name: 'Responsable', value: t.assignee_id ? `<@${t.assignee_id}>` : '—', inline: true },
    { name: 'Échéance', value: t.due_date ? `${overdue ? '⚠️ ' : ''}${discordTs(t.due_date, 'D')} (${discordTs(t.due_date, 'R')})` : '—', inline: true },
  );
  if (t.completed_at) e.addFields({ name: 'Terminée', value: discordTs(t.completed_at, 'R'), inline: true });
  return e;
}

export function taskButtons(t: Task) {
  const b = (status: TaskStatus, label: string, emoji: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(cid('task', 'status', t.id, status)).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(t.status === status);
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (t.status === 'done') {
    row.addComponents(b('todo', 'Rouvrir', '↩️', ButtonStyle.Secondary));
  } else {
    row.addComponents(
      b('in_progress', 'En cours', '🔨', ButtonStyle.Primary),
      b('testing', 'En test', '🧪', ButtonStyle.Secondary),
      b('done', 'Terminé', '✅', ButtonStyle.Success),
      b('postponed', 'Reporter', '⏸️', ButtonStyle.Secondary),
    );
  }
  return [row];
}

export async function syncTask(id: number): Promise<void> {
  const t = tasks.get(id);
  const target = channelId('todo');
  if (!t || !target) return;
  const loc = await upsertMessage(target, { channelId: t.channel_id, messageId: t.message_id }, { embeds: [taskEmbed(t)], components: taskButtons(t), allowedMentions: { parse: [] } });
  tasks.update(t.id, { message_id: loc.messageId, channel_id: loc.channelId });
}

export const scheduleTaskSync = (id: number) => debounce(`task:${id}`, 800, () => syncTask(id), onError('tâche'));

export async function setTaskStatus(id: number, status: TaskStatus, actorId: string): Promise<Task | null> {
  const t = tasks.get(id);
  if (!t) return null;
  tasks.update(id, { status, completed_at: status === 'done' ? Date.now() : null });
  await syncTask(id).catch(onError('tâche'));
  await audit({ type: 'tasks', action: 'status', actorId, target: `Tâche n°${id}`, message: `Tâche « ${t.title} » : ${TASK_STATUS[t.status].label} → **${TASK_STATUS[status].label}**.`, color: TASK_STATUS[status].color });
  return tasks.get(id)!;
}

export async function deleteTask(id: number, actorId: string): Promise<void> {
  const t = tasks.get(id);
  if (!t) return;
  await deleteMessage(t.channel_id, t.message_id);
  tasks.remove(id);
  await audit({ type: 'tasks', action: 'delete', actorId, target: `Tâche n°${id}`, message: `Tâche « ${t.title} » supprimée.` });
}

// ───────────── Roadmap ─────────────

/** Salon de la roadmap : réaffectable dans le panel (clé « roadmap »), sinon #release. */
export function roadmapChannelId(): string | null {
  return getSetting('channels.overrides')['roadmap'] ?? channelId('release');
}

export function normalizeRoadmap(status: RoadmapStatus, progress: number): { status: RoadmapStatus; progress: number } {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  if (status === 'done') return { status, progress: 100 };
  if (p === 100 && status !== 'postponed') return { status: 'done', progress: 100 };
  return { status, progress: p };
}

function averageProgress(items: RoadmapItem[]): number {
  return items.length ? items.reduce((n, i) => n + i.progress, 0) / items.length : 0;
}

export function roadmapHeaderEmbed() {
  const items = roadmap.items();
  const done = items.filter((i) => i.status === 'done').length;
  const legend = Object.values(ROADMAP_STATUS)
    .map((s) => `${s.emoji} ${s.label}`)
    .join(' • ');
  return brandEmbed({
    title: `🗺️ Roadmap — ${getSetting('brand.name')}`,
    description: `Suis l’avancement du développement du jeu, mis à jour en direct par l’équipe.\n\n**Progression globale**\n${progressBar(averageProgress(items), 14)}\n${done}/${items.length} fonctionnalité(s) terminée(s)\n\n${legend}`,
  });
}

export function roadmapCategoryEmbed(categoryId: number) {
  const c = roadmap.category(categoryId)!;
  const items = roadmap.items(categoryId);
  const lines = items.map((i) => {
    const st = ROADMAP_STATUS[i.status] ?? ROADMAP_STATUS.upcoming;
    const date = i.target_date ? ` • 📅 ${discordTs(i.target_date, 'D')}` : '';
    const desc = i.description ? `\n> ${truncate(i.description.replace(/\n+/g, ' '), 180)}` : '';
    return `${st.emoji} **${i.title}** — ${st.label}\n\`${progressBar(i.progress)}\`${date}${desc}`;
  });
  const avg = averageProgress(items);
  return brandEmbed({
    title: `${c.emoji ?? '📁'} ${c.name}`,
    description: truncate(`${items.length ? `**${Math.round(avg)} %** complété\n\n` : ''}${lines.join('\n\n') || '*Rien de prévu pour le moment.*'}`, 4096),
    color: avg >= 100 && items.length ? COLORS.success : undefined,
    timestamp: false,
  });
}

/** Met à jour les messages de roadmap existants (un en-tête + un message par catégorie). */
export async function syncRoadmap(reset = false): Promise<void> {
  const target = roadmapChannelId();
  if (!target) return;
  const cats = roadmap.categories();
  if (reset) {
    const header = getSetting('roadmap.header');
    if (header) await deleteMessage(header.channelId, header.messageId);
    for (const c of cats) if (c.message_id) await deleteMessage(header?.channelId ?? target, c.message_id);
    setSetting('roadmap.header', null);
    for (const c of cats) roadmap.setCategoryMessage(c.id, null);
  }
  const header = getSetting('roadmap.header');
  const loc = await upsertMessage(target, header ?? {}, { embeds: [roadmapHeaderEmbed()] });
  setSetting('roadmap.header', loc);
  for (const c of roadmap.categories()) {
    const msg = await upsertMessage(target, { channelId: header?.channelId ?? target, messageId: c.message_id }, { embeds: [roadmapCategoryEmbed(c.id)] });
    roadmap.setCategoryMessage(c.id, msg.messageId);
  }
}

export const scheduleRoadmapSync = () => debounce('roadmap', 2000, () => syncRoadmap(), onError('roadmap'));

export async function deleteRoadmapCategory(id: number): Promise<void> {
  const c = roadmap.category(id);
  if (!c) return;
  const header = getSetting('roadmap.header');
  if (c.message_id) await deleteMessage(header?.channelId ?? roadmapChannelId(), c.message_id);
  roadmap.removeCategory(id);
  scheduleRoadmapSync();
}

export async function hasRoadmapMessage(): Promise<boolean> {
  const h = getSetting('roadmap.header');
  return !!(h && (await fetchMessage(h.channelId, h.messageId)));
}
