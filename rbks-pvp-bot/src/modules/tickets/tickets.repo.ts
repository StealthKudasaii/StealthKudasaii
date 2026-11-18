import { db } from '../../db';
import type { TicketStatus } from '../../config/constants';

export interface TicketReason {
  id: number;
  label: string;
  emoji: string | null;
  description: string | null;
  position: number;
  enabled: number;
}

export interface Ticket {
  id: number;
  channel_id: string | null;
  user_id: string;
  reason_id: number | null;
  reason_label: string;
  subject: string | null;
  details: string | null;
  status: TicketStatus;
  claimed_by: string | null;
  closed_by: string | null;
  close_reason: string | null;
  transcript_file: string | null;
  message_count: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface TicketNote {
  id: number;
  ticket_id: number;
  author_id: string;
  content: string;
  created_at: number;
}

export const reasons = {
  list(onlyEnabled = false): TicketReason[] {
    return db()
      .prepare(`SELECT * FROM ticket_reasons ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY position, id`)
      .all() as TicketReason[];
  },
  get(id: number): TicketReason | undefined {
    return db().prepare('SELECT * FROM ticket_reasons WHERE id = ?').get(id) as TicketReason | undefined;
  },
  create(r: { label: string; emoji?: string | null; description?: string | null; position?: number }): number {
    const pos = r.position ?? ((db().prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM ticket_reasons').get() as { p: number }).p);
    return Number(
      db().prepare('INSERT INTO ticket_reasons (label, emoji, description, position) VALUES (?, ?, ?, ?)').run(r.label, r.emoji || null, r.description || null, pos).lastInsertRowid,
    );
  },
  update(id: number, r: { label: string; emoji?: string | null; description?: string | null; position: number; enabled: boolean }): void {
    db()
      .prepare('UPDATE ticket_reasons SET label = ?, emoji = ?, description = ?, position = ?, enabled = ? WHERE id = ?')
      .run(r.label, r.emoji || null, r.description || null, r.position, r.enabled ? 1 : 0, id);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM ticket_reasons WHERE id = ?').run(id);
  },
};

export const tickets = {
  get(id: number): Ticket | undefined {
    return db().prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined;
  },
  byChannel(channelId: string): Ticket | undefined {
    return db().prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId) as Ticket | undefined;
  },
  openCountForUser(userId: string): number {
    return (db().prepare("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND status != 'closed'").get(userId) as { n: number }).n;
  },
  create(t: { userId: string; reasonId: number | null; reasonLabel: string; subject: string; details: string }): number {
    return Number(
      db()
        .prepare('INSERT INTO tickets (user_id, reason_id, reason_label, subject, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t.userId, t.reasonId, t.reasonLabel, t.subject, t.details, Date.now()).lastInsertRowid,
    );
  },
  setChannel(id: number, channelId: string): void {
    db().prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channelId, id);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM tickets WHERE id = ?').run(id);
  },
  setChannelNull(id: number): void {
    db().prepare('UPDATE tickets SET channel_id = NULL WHERE id = ?').run(id);
  },
  /** Prise en charge atomique : échoue si quelqu'un l'a déjà prise. */
  claim(id: number, staffId: string): boolean {
    return db().prepare("UPDATE tickets SET status = 'claimed', claimed_by = ? WHERE id = ? AND status = 'open'").run(staffId, id).changes === 1;
  },
  /** Fermeture atomique : un seul membre du staff peut fermer le ticket. */
  markClosed(id: number, staffId: string, reason: string | null): boolean {
    return (
      db()
        .prepare("UPDATE tickets SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ? WHERE id = ? AND status != 'closed'")
        .run(staffId, reason, Date.now(), id).changes === 1
    );
  },
  setTranscript(id: number, file: string | null, count: number): void {
    db().prepare('UPDATE tickets SET transcript_file = ?, message_count = ? WHERE id = ?').run(file, count, id);
  },
  list(opts: { status?: string; limit?: number; offset?: number } = {}): { rows: Ticket[]; total: number } {
    const where = opts.status ? 'WHERE status = ?' : '';
    const params = opts.status ? [opts.status] : [];
    const rows = db()
      .prepare(`SELECT * FROM tickets ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as Ticket[];
    const total = (db().prepare(`SELECT COUNT(*) n FROM tickets ${where}`).get(...params) as { n: number }).n;
    return { rows, total };
  },
  addNote(ticketId: number, authorId: string, content: string): void {
    db().prepare('INSERT INTO ticket_notes (ticket_id, author_id, content, created_at) VALUES (?, ?, ?, ?)').run(ticketId, authorId, content, Date.now());
  },
  notes(ticketId: number): TicketNote[] {
    return db().prepare('SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY id').all(ticketId) as TicketNote[];
  },
};
