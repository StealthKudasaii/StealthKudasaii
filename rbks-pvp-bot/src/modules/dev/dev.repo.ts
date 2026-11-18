import { db, parseJson } from '../../db';
import type { RoadmapStatus, TaskPriority, TaskStatus, VersionStatus } from '../../config/constants';

export interface Version {
  id: number;
  version: string;
  name: string;
  description: string;
  features: string;
  status: VersionStatus;
  target_date: number | null;
  progress: number | null;
  message_id: string | null;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  category: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  due_date: number | null;
  message_id: string | null;
  channel_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface RoadmapCategory {
  id: number;
  name: string;
  emoji: string | null;
  position: number;
  message_id: string | null;
}

export interface RoadmapItem {
  id: number;
  category_id: number;
  title: string;
  description: string;
  status: RoadmapStatus;
  progress: number;
  target_date: number | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export const featuresOf = (v: Version) => parseJson<string[]>(v.features, []);

function patchSql(table: string, allowed: Set<string>, id: number, patch: Record<string, unknown>, touch = true) {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && allowed.has(k));
  if (!entries.length) return;
  const cols = entries.map(([k]) => `${k} = ?`).join(', ');
  db()
    .prepare(`UPDATE ${table} SET ${cols}${touch ? ', updated_at = ?' : ''} WHERE id = ?`)
    .run(...(entries.map(([, v]) => v) as never[]), ...(touch ? [Date.now()] : []), id);
}

const VERSION_COLS = new Set(['version', 'name', 'description', 'features', 'status', 'target_date', 'progress', 'message_id', 'channel_id']);
export const versions = {
  list(): Version[] {
    return db().prepare('SELECT * FROM versions ORDER BY id').all() as Version[];
  },
  get(id: number): Version | undefined {
    return db().prepare('SELECT * FROM versions WHERE id = ?').get(id) as Version | undefined;
  },
  byVersion(v: string): Version | undefined {
    return db().prepare('SELECT * FROM versions WHERE version = ?').get(v) as Version | undefined;
  },
  search(q: string): Version[] {
    return db().prepare('SELECT * FROM versions WHERE version LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 25').all(`%${q}%`, `%${q}%`) as Version[];
  },
  create(v: { version: string; name: string; description: string; features: string[]; status: VersionStatus; target_date: number | null; progress: number | null }): number {
    const t = Date.now();
    return Number(
      db()
        .prepare('INSERT INTO versions (version, name, description, features, status, target_date, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v.version, v.name, v.description, JSON.stringify(v.features), v.status, v.target_date, v.progress, t, t).lastInsertRowid,
    );
  },
  update(id: number, patch: Partial<Omit<Version, 'features'>> & { features?: string[] }): void {
    patchSql('versions', VERSION_COLS, id, { ...patch, features: patch.features ? JSON.stringify(patch.features) : undefined });
  },
  remove(id: number): void {
    db().prepare('DELETE FROM versions WHERE id = ?').run(id);
  },
};

const TASK_COLS = new Set(['title', 'description', 'category', 'status', 'priority', 'assignee_id', 'due_date', 'message_id', 'channel_id', 'completed_at']);
export const tasks = {
  list(status?: string): Task[] {
    return (status
      ? db().prepare("SELECT * FROM tasks WHERE status = ? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id").all(status)
      : db().prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'testing' THEN 1 WHEN 'todo' THEN 2 WHEN 'postponed' THEN 3 ELSE 4 END, id DESC").all()) as Task[];
  },
  get(id: number): Task | undefined {
    return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  },
  search(q: string): Task[] {
    const asId = Number(q.replace('#', ''));
    return db()
      .prepare('SELECT * FROM tasks WHERE title LIKE ? OR id = ? ORDER BY (status = \'done\'), id DESC LIMIT 25')
      .all(`%${q}%`, Number.isFinite(asId) ? asId : -1) as Task[];
  },
  categories(): string[] {
    return (db().prepare('SELECT DISTINCT category FROM tasks ORDER BY category').all() as { category: string }[]).map((r) => r.category);
  },
  create(t: { title: string; description: string; category: string; priority: TaskPriority; assignee_id: string | null; due_date: number | null; created_by: string }): number {
    const now = Date.now();
    return Number(
      db()
        .prepare('INSERT INTO tasks (title, description, category, priority, assignee_id, due_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(t.title, t.description, t.category, t.priority, t.assignee_id, t.due_date, t.created_by, now, now).lastInsertRowid,
    );
  },
  update(id: number, patch: Partial<Task>): void {
    patchSql('tasks', TASK_COLS, id, patch as Record<string, unknown>);
  },
  remove(id: number): void {
    db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },
  counts(): Record<string, number> {
    const rows = db().prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  },
};

const ITEM_COLS = new Set(['category_id', 'title', 'description', 'status', 'progress', 'target_date', 'position']);
export const roadmap = {
  categories(): RoadmapCategory[] {
    return db().prepare('SELECT * FROM roadmap_categories ORDER BY position, id').all() as RoadmapCategory[];
  },
  category(id: number): RoadmapCategory | undefined {
    return db().prepare('SELECT * FROM roadmap_categories WHERE id = ?').get(id) as RoadmapCategory | undefined;
  },
  categoryByName(name: string): RoadmapCategory | undefined {
    return db().prepare('SELECT * FROM roadmap_categories WHERE name = ?').get(name) as RoadmapCategory | undefined;
  },
  createCategory(name: string, emoji: string | null): number {
    const pos = (db().prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM roadmap_categories').get() as { p: number }).p;
    return Number(db().prepare('INSERT INTO roadmap_categories (name, emoji, position) VALUES (?, ?, ?)').run(name, emoji, pos).lastInsertRowid);
  },
  updateCategory(id: number, c: { name: string; emoji: string | null; position: number }): void {
    db().prepare('UPDATE roadmap_categories SET name = ?, emoji = ?, position = ? WHERE id = ?').run(c.name, c.emoji, c.position, id);
  },
  setCategoryMessage(id: number, messageId: string | null): void {
    db().prepare('UPDATE roadmap_categories SET message_id = ? WHERE id = ?').run(messageId, id);
  },
  removeCategory(id: number): void {
    db().prepare('DELETE FROM roadmap_categories WHERE id = ?').run(id);
  },
  items(categoryId?: number): RoadmapItem[] {
    return (categoryId
      ? db().prepare('SELECT * FROM roadmap_items WHERE category_id = ? ORDER BY position, id').all(categoryId)
      : db().prepare('SELECT * FROM roadmap_items ORDER BY category_id, position, id').all()) as RoadmapItem[];
  },
  item(id: number): RoadmapItem | undefined {
    return db().prepare('SELECT * FROM roadmap_items WHERE id = ?').get(id) as RoadmapItem | undefined;
  },
  searchItems(q: string): (RoadmapItem & { category_name: string })[] {
    return db()
      .prepare('SELECT i.*, c.name category_name FROM roadmap_items i JOIN roadmap_categories c ON c.id = i.category_id WHERE i.title LIKE ? ORDER BY c.position, i.position LIMIT 25')
      .all(`%${q}%`) as (RoadmapItem & { category_name: string })[];
  },
  createItem(it: { category_id: number; title: string; description: string; status: RoadmapStatus; progress: number; target_date: number | null }): number {
    const now = Date.now();
    const pos = (db().prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM roadmap_items WHERE category_id = ?').get(it.category_id) as { p: number }).p;
    return Number(
      db()
        .prepare('INSERT INTO roadmap_items (category_id, title, description, status, progress, target_date, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(it.category_id, it.title, it.description, it.status, it.progress, it.target_date, pos, now, now).lastInsertRowid,
    );
  },
  updateItem(id: number, patch: Partial<RoadmapItem>): void {
    patchSql('roadmap_items', ITEM_COLS, id, patch as Record<string, unknown>);
  },
  removeItem(id: number): void {
    db().prepare('DELETE FROM roadmap_items WHERE id = ?').run(id);
  },
};
