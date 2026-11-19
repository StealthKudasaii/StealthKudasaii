/**
 * Migrations SQL versionnées. Ne jamais modifier une migration déjà livrée :
 * ajouter une nouvelle entrée à la fin du tableau.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE managed_resources (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('role','category','channel')),
  discord_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE feature_roles (
  feature TEXT PRIMARY KEY,
  role_ids TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  target TEXT,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_type ON audit_logs(type, created_at DESC);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ───────────── Tickets ─────────────
CREATE TABLE ticket_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE,
  user_id TEXT NOT NULL,
  reason_id INTEGER,
  reason_label TEXT NOT NULL,
  subject TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','closed')),
  claimed_by TEXT,
  closed_by TEXT,
  close_reason TEXT,
  transcript_file TEXT,
  message_count INTEGER,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX idx_tickets_user ON tickets(user_id, status);
CREATE INDEX idx_tickets_status ON tickets(status);

CREATE TABLE ticket_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ───────────── Formulaires / candidatures ─────────────
CREATE TABLE forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  banner_url TEXT,
  button_label TEXT NOT NULL DEFAULT 'Postuler',
  publish_channel_id TEXT,
  review_channel_id TEXT,
  reviewer_role_ids TEXT NOT NULL DEFAULT '[]',
  accepted_role_id TEXT,
  max_applications INTEGER,
  reapply_days INTEGER NOT NULL DEFAULT 7,
  opens_at INTEGER,
  closes_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  message_id TEXT,
  published_state TEXT,
  dm_on_decision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE form_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('short','long','single','multi','number','roblox')),
  required INTEGER NOT NULL DEFAULT 1,
  choices TEXT NOT NULL DEFAULT '[]',
  placeholder TEXT,
  min_value REAL,
  max_value REAL
);
CREATE INDEX idx_questions_form ON form_questions(form_id, position);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_tag TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','on_hold','accepted','refused')),
  answers TEXT NOT NULL,
  roblox_username TEXT,
  roblox_id TEXT,
  review_channel_id TEXT,
  review_message_id TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_applications_form ON applications(form_id, status);
CREATE INDEX idx_applications_user ON applications(user_id);
-- Une seule candidature active par membre et par formulaire (anti-doublon au niveau base).
CREATE UNIQUE INDEX idx_applications_active ON applications(form_id, user_id) WHERE status IN ('pending','on_hold');

CREATE TABLE application_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE application_drafts (
  user_id TEXT NOT NULL,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  answers TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, form_id)
);

-- ───────────── Développement ─────────────
CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned',
  target_date INTEGER,
  progress INTEGER,
  message_id TEXT,
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Général',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id TEXT,
  due_date INTEGER,
  message_id TEXT,
  channel_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE roadmap_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  emoji TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  message_id TEXT
);

CREATE TABLE roadmap_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES roadmap_categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'upcoming',
  progress INTEGER NOT NULL DEFAULT 0,
  target_date INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ───────────── Communauté ─────────────
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  staff_response TEXT,
  responder_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE suggestion_votes (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  assignee_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bugs_status ON bugs(status);

CREATE TABLE bug_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  content TEXT,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('patchnote','announcement','update','spoil')),
  version TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '',
  fixes TEXT NOT NULL DEFAULT '',
  balance TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  publish_date INTEGER,
  ping INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  message_id TEXT,
  author_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE test_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  duration_minutes INTEGER,
  slots INTEGER NOT NULL,
  role_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE test_session_participants (
  session_id INTEGER NOT NULL REFERENCES test_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered','waitlist')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 1,
  live_results INTEGER NOT NULL DEFAULT 1,
  ends_at INTEGER,
  channel_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, option_index)
);

-- ───────────── Panel web ─────────────
CREATE TABLE web_sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX idx_web_sessions_expires ON web_sessions(expires);
`,
  },
  {
    id: 2,
    name: 'massdm_invites',
    sql: `
-- Envois groupés de messages privés (avec clés d'accès facultatives)
CREATE TABLE dm_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  role_id TEXT NOT NULL,
  with_keys INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','done')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE dm_recipients (
  campaign_id INTEGER NOT NULL REFERENCES dm_campaigns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_tag TEXT,
  access_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, user_id)
);
-- Une clé ne peut exister qu'une seule fois, tous lots confondus.
CREATE UNIQUE INDEX idx_dm_recipients_key ON dm_recipients(access_key) WHERE access_key IS NOT NULL;

-- Arrivées des membres et invitation utilisée
CREATE TABLE member_joins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  inviter_id TEXT,
  invite_code TEXT,
  source TEXT NOT NULL DEFAULT 'unknown' CHECK (source IN ('invite','vanity','unknown')),
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX idx_member_joins_user ON member_joins(user_id, joined_at DESC);
CREATE INDEX idx_member_joins_inviter ON member_joins(inviter_id);
`,
  },
];
