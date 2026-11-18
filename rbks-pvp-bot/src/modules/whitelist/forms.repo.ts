import { db, parseJson } from '../../db';
import type { ApplicationStatus, QuestionType } from '../../config/constants';

export interface Form {
  id: number;
  name: string;
  title: string;
  description: string;
  banner_url: string | null;
  button_label: string;
  publish_channel_id: string | null;
  review_channel_id: string | null;
  reviewer_role_ids: string;
  accepted_role_id: string | null;
  max_applications: number | null;
  reapply_days: number;
  opens_at: number | null;
  closes_at: number | null;
  status: 'draft' | 'open' | 'closed';
  message_id: string | null;
  published_state: string | null;
  dm_on_decision: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface Question {
  id: number;
  form_id: number;
  position: number;
  label: string;
  description: string | null;
  type: QuestionType;
  required: number;
  choices: string;
  placeholder: string | null;
  min_value: number | null;
  max_value: number | null;
}

export interface AnswerSnapshot {
  qid: number;
  label: string;
  type: QuestionType;
  value: string | string[];
}

export interface Application {
  id: number;
  form_id: number;
  user_id: string;
  user_tag: string | null;
  status: ApplicationStatus;
  answers: string;
  roblox_username: string | null;
  roblox_id: string | null;
  review_channel_id: string | null;
  review_message_id: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: number | null;
  created_at: number;
}

export interface AppEvent {
  id: number;
  application_id: number;
  actor_id: string | null;
  action: string;
  details: string | null;
  created_at: number;
}

export interface AppNote {
  id: number;
  application_id: number;
  author_id: string;
  content: string;
  created_at: number;
}

export const reviewerRoles = (f: Form) => parseJson<string[]>(f.reviewer_role_ids, []);
export const choicesOf = (q: Question) => parseJson<string[]>(q.choices, []);
export const answersOf = (a: Application) => parseJson<AnswerSnapshot[]>(a.answers, []);

export type FormPatch = Partial<Omit<Form, 'id' | 'created_at' | 'reviewer_role_ids'>> & { reviewer_role_ids?: string[] };

const FORM_COLUMNS = new Set([
  'name', 'title', 'description', 'banner_url', 'button_label', 'publish_channel_id', 'review_channel_id', 'reviewer_role_ids',
  'accepted_role_id', 'max_applications', 'reapply_days', 'opens_at', 'closes_at', 'status', 'message_id', 'published_state', 'dm_on_decision', 'created_by',
]);

export const forms = {
  list(): Form[] {
    return db().prepare('SELECT * FROM forms ORDER BY created_at DESC').all() as Form[];
  },
  get(id: number): Form | undefined {
    return db().prepare('SELECT * FROM forms WHERE id = ?').get(id) as Form | undefined;
  },
  byName(name: string): Form | undefined {
    return db().prepare('SELECT * FROM forms WHERE name = ?').get(name) as Form | undefined;
  },
  search(q: string): Form[] {
    return db().prepare("SELECT * FROM forms WHERE name LIKE ? OR title LIKE ? ORDER BY created_at DESC LIMIT 25").all(`%${q}%`, `%${q}%`) as Form[];
  },
  create(f: { name: string; title: string; description: string; button_label: string; banner_url: string | null; review_channel_id: string | null; accepted_role_id: string | null; created_by: string }): number {
    const t = Date.now();
    return Number(
      db()
        .prepare(
          `INSERT INTO forms (name, title, description, button_label, banner_url, review_channel_id, accepted_role_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(f.name, f.title, f.description, f.button_label, f.banner_url, f.review_channel_id, f.accepted_role_id, f.created_by, t, t).lastInsertRowid,
    );
  },
  update(id: number, patch: FormPatch): void {
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && FORM_COLUMNS.has(k));
    if (!entries.length) return;
    const cols = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([k, v]) => (k === 'reviewer_role_ids' ? JSON.stringify(v) : (v as unknown)));
    db().prepare(`UPDATE forms SET ${cols}, updated_at = ? WHERE id = ?`).run(...(values as never[]), Date.now(), id);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM forms WHERE id = ?').run(id);
  },
};

export const questions = {
  list(formId: number): Question[] {
    return db().prepare('SELECT * FROM form_questions WHERE form_id = ? ORDER BY position, id').all(formId) as Question[];
  },
  get(id: number): Question | undefined {
    return db().prepare('SELECT * FROM form_questions WHERE id = ?').get(id) as Question | undefined;
  },
  count(formId: number): number {
    return (db().prepare('SELECT COUNT(*) n FROM form_questions WHERE form_id = ?').get(formId) as { n: number }).n;
  },
  create(formId: number, q: QuestionInput): number {
    const pos = (db().prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM form_questions WHERE form_id = ?').get(formId) as { p: number }).p;
    return Number(
      db()
        .prepare(
          'INSERT INTO form_questions (form_id, position, label, description, type, required, choices, placeholder, min_value, max_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(formId, pos, q.label, q.description || null, q.type, q.required ? 1 : 0, JSON.stringify(q.choices ?? []), q.placeholder || null, q.min_value ?? null, q.max_value ?? null)
        .lastInsertRowid,
    );
  },
  update(id: number, q: QuestionInput): void {
    db()
      .prepare('UPDATE form_questions SET label = ?, description = ?, type = ?, required = ?, choices = ?, placeholder = ?, min_value = ?, max_value = ? WHERE id = ?')
      .run(q.label, q.description || null, q.type, q.required ? 1 : 0, JSON.stringify(q.choices ?? []), q.placeholder || null, q.min_value ?? null, q.max_value ?? null, id);
  },
  remove(id: number): void {
    const q = questions.get(id);
    if (!q) return;
    db().transaction(() => {
      db().prepare('DELETE FROM form_questions WHERE id = ?').run(id);
      questions.renumber(q.form_id);
    })();
  },
  move(id: number, delta: -1 | 1): void {
    const q = questions.get(id);
    if (!q) return;
    const list = questions.list(q.form_id);
    const idx = list.findIndex((x) => x.id === id);
    const target = idx + delta;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    const stmt = db().prepare('UPDATE form_questions SET position = ? WHERE id = ?');
    db().transaction(() => list.forEach((x, i) => stmt.run(i + 1, x.id)))();
  },
  renumber(formId: number): void {
    const stmt = db().prepare('UPDATE form_questions SET position = ? WHERE id = ?');
    questions.list(formId).forEach((x, i) => stmt.run(i + 1, x.id));
  },
};

export interface QuestionInput {
  label: string;
  description?: string | null;
  type: QuestionType;
  required: boolean;
  choices?: string[];
  placeholder?: string | null;
  min_value?: number | null;
  max_value?: number | null;
}

export const applications = {
  get(id: number): Application | undefined {
    return db().prepare('SELECT * FROM applications WHERE id = ?').get(id) as Application | undefined;
  },
  countForForm(formId: number): number {
    return (db().prepare('SELECT COUNT(*) n FROM applications WHERE form_id = ?').get(formId) as { n: number }).n;
  },
  active(formId: number, userId: string): Application | undefined {
    return db().prepare("SELECT * FROM applications WHERE form_id = ? AND user_id = ? AND status IN ('pending','on_hold')").get(formId, userId) as Application | undefined;
  },
  lastForUser(formId: number, userId: string): Application | undefined {
    return db().prepare('SELECT * FROM applications WHERE form_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(formId, userId) as Application | undefined;
  },
  create(a: { formId: number; userId: string; userTag: string; answers: AnswerSnapshot[]; roblox: string | null; robloxId: string | null }): number {
    return Number(
      db()
        .prepare('INSERT INTO applications (form_id, user_id, user_tag, answers, roblox_username, roblox_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(a.formId, a.userId, a.userTag, JSON.stringify(a.answers), a.roblox, a.robloxId, Date.now()).lastInsertRowid,
    );
  },
  setReviewMessage(id: number, channelId: string, messageId: string): void {
    db().prepare('UPDATE applications SET review_channel_id = ?, review_message_id = ? WHERE id = ?').run(channelId, messageId, id);
  },
  /** Transition atomique : ne réussit que depuis un état encore modifiable. */
  decide(id: number, status: ApplicationStatus, actorId: string, reason: string | null): boolean {
    const from = status === 'on_hold' ? "('pending')" : "('pending','on_hold')";
    return (
      db()
        .prepare(`UPDATE applications SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ? AND status IN ${from}`)
        .run(status, actorId, reason, Date.now(), id).changes === 1
    );
  },
  list(opts: { formId?: number; status?: string; limit?: number; offset?: number } = {}): { rows: Application[]; total: number } {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (opts.formId) {
      cond.push('form_id = ?');
      params.push(opts.formId);
    }
    if (opts.status) {
      cond.push('status = ?');
      params.push(opts.status);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = db()
      .prepare(`SELECT * FROM applications ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...(params as never[]), opts.limit ?? 50, opts.offset ?? 0) as Application[];
    const total = (db().prepare(`SELECT COUNT(*) n FROM applications ${where}`).get(...(params as never[])) as { n: number }).n;
    return { rows, total };
  },
  stats(formId?: number) {
    const where = formId ? 'WHERE form_id = ?' : '';
    const params = formId ? [formId] : [];
    const rows = db().prepare(`SELECT status, COUNT(*) n FROM applications ${where} GROUP BY status`).all(...params) as { status: ApplicationStatus; n: number }[];
    const by: Record<ApplicationStatus, number> = { pending: 0, on_hold: 0, accepted: 0, refused: 0 };
    for (const r of rows) by[r.status] = r.n;
    const avg = db()
      .prepare(`SELECT AVG(decided_at - created_at) a FROM applications ${where ? where + ' AND' : 'WHERE'} status IN ('accepted','refused') AND decided_at IS NOT NULL`)
      .get(...params) as { a: number | null };
    const total = by.pending + by.on_hold + by.accepted + by.refused;
    return { ...by, total, avgDecisionMs: avg.a ?? null };
  },
  addEvent(appId: number, actorId: string | null, action: string, details: string | null = null): void {
    db().prepare('INSERT INTO application_events (application_id, actor_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)').run(appId, actorId, action, details, Date.now());
  },
  events(appId: number): AppEvent[] {
    return db().prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id').all(appId) as AppEvent[];
  },
  addNote(appId: number, authorId: string, content: string): void {
    db().prepare('INSERT INTO application_notes (application_id, author_id, content, created_at) VALUES (?, ?, ?, ?)').run(appId, authorId, content, Date.now());
  },
  notes(appId: number): AppNote[] {
    return db().prepare('SELECT * FROM application_notes WHERE application_id = ? ORDER BY id').all(appId) as AppNote[];
  },
};

export const drafts = {
  get(userId: string, formId: number): Record<string, string | string[]> {
    const row = db().prepare('SELECT answers, updated_at FROM application_drafts WHERE user_id = ? AND form_id = ?').get(userId, formId) as
      | { answers: string; updated_at: number }
      | undefined;
    // Brouillon expiré au bout d'une heure.
    if (!row || row.updated_at < Date.now() - 3600_000) return {};
    return parseJson(row.answers, {});
  },
  save(userId: string, formId: number, answers: Record<string, string | string[]>): void {
    db()
      .prepare(
        'INSERT INTO application_drafts (user_id, form_id, answers, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, form_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at',
      )
      .run(userId, formId, JSON.stringify(answers), Date.now());
  },
  clear(userId: string, formId: number): void {
    db().prepare('DELETE FROM application_drafts WHERE user_id = ? AND form_id = ?').run(userId, formId);
  },
};
