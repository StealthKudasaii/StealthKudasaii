import type { Collection, GuildTextBasedChannel, Message } from 'discord.js';
import { escapeHtml } from '../../core/text';
import { formatDate } from '../../core/time';
import type { Ticket, TicketNote } from './tickets.repo';

const MAX_MESSAGES = 5000;

/** Récupère tout l'historique du salon (pagination de 100 en 100, plafonné). */
export async function fetchAllMessages(channel: GuildTextBasedChannel): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;
  while (all.length < MAX_MESSAGES) {
    const batch: Collection<string, Message> = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

export interface TranscriptMessage {
  author: string;
  authorId: string;
  avatar: string;
  bot: boolean;
  createdAt: number;
  content: string;
  embeds: { title?: string; description?: string }[];
  attachments: { name: string; url: string }[];
}

export function toTranscriptMessages(messages: Message[]): TranscriptMessage[] {
  return messages.map((m) => ({
    author: m.member?.displayName ?? m.author.username,
    authorId: m.author.id,
    avatar: m.author.displayAvatarURL({ size: 64 }),
    bot: m.author.bot,
    createdAt: m.createdTimestamp,
    content: m.content,
    embeds: m.embeds.map((e) => ({ title: e.title ?? undefined, description: e.description ?? undefined })),
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
  }));
}

/** Rendu HTML autonome (aucun script), tout le contenu utilisateur est échappé. */
export function renderTranscriptHtml(ticket: Ticket, messages: TranscriptMessage[], notes: TicketNote[], names: Record<string, string>, brand: string): string {
  const nameOf = (id: string | null) => (id ? escapeHtml(names[id] ?? id) : '—');
  const body = messages
    .map((m) => {
      const embeds = m.embeds
        .map((e) => `<div class="embed">${e.title ? `<strong>${escapeHtml(e.title)}</strong><br>` : ''}${escapeHtml(e.description ?? '').replace(/\n/g, '<br>')}</div>`)
        .join('');
      const files = m.attachments.map((a) => `<div class="file">📎 <a href="${escapeHtml(a.url)}" rel="noopener noreferrer">${escapeHtml(a.name)}</a></div>`).join('');
      return `<div class="msg"><img src="${escapeHtml(m.avatar)}" alt=""><div><div class="meta"><span class="author${m.bot ? ' bot' : ''}">${escapeHtml(m.author)}</span><span class="date">${formatDate(m.createdAt)}</span></div><div class="content">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>${embeds}${files}</div></div>`;
    })
    .join('\n');
  const notesHtml = notes.length
    ? `<h2>Notes internes du staff</h2>${notes.map((n) => `<div class="note"><b>${nameOf(n.author_id)}</b> — ${formatDate(n.created_at)}<br>${escapeHtml(n.content).replace(/\n/g, '<br>')}</div>`).join('')}`
    : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket n°${ticket.id} — ${escapeHtml(brand)}</title>
<style>
body{margin:0;background:#0f1115;color:#dcdfe4;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:linear-gradient(135deg,#1a1d24,#2a1410);padding:24px 32px;border-bottom:2px solid #ff4d2e}
h1{margin:0 0 8px;font-size:22px}h2{padding:0 32px;font-size:17px;color:#ff8a65}
.info{display:flex;flex-wrap:wrap;gap:8px 24px;color:#9aa0aa;font-size:14px}
main{padding:16px 32px}.msg{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #1d2027}
.msg img{width:40px;height:40px;border-radius:50%}.meta{display:flex;gap:8px;align-items:baseline}
.author{font-weight:600;color:#fff}.author.bot{color:#7289ff}.date{font-size:12px;color:#6b717c}
.embed{border-left:4px solid #ff4d2e;background:#161920;padding:8px 12px;margin-top:4px;border-radius:4px}
.file a{color:#3ba7ff}.note{margin:0 32px 8px;padding:10px 14px;background:#1d1a12;border-left:4px solid #f1c40f;border-radius:4px}
</style></head><body>
<header><h1>🎫 Ticket n°${ticket.id} — ${escapeHtml(ticket.reason_label)}</h1>
<div class="info"><span>Créé par <b>${nameOf(ticket.user_id)}</b></span><span>Ouvert le ${formatDate(ticket.created_at)}</span>
<span>Pris en charge par ${nameOf(ticket.claimed_by)}</span><span>Fermé par ${nameOf(ticket.closed_by)} le ${formatDate(ticket.closed_at ?? Date.now())}</span>
${ticket.close_reason ? `<span>Motif de fermeture : ${escapeHtml(ticket.close_reason)}</span>` : ''}<span>${messages.length} message(s)</span></div></header>
<main>${body || '<p>Aucun message.</p>'}</main>${notesHtml}</body></html>`;
}
