-- Core life OS
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  area TEXT,
  status TEXT DEFAULT 'inbox',
  due_date TEXT,
  notes TEXT,
  goal_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  target_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relationship TEXT,
  notes TEXT,
  last_contact TEXT,
  next_touchpoint TEXT,
  touchpoint_interval_days INTEGER DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  source TEXT,
  status TEXT DEFAULT 'want',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS life_vision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL UNIQUE,
  vision TEXT,
  values TEXT,
  current_phase TEXT,
  success_definition TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  subject TEXT,
  from_address TEXT,
  from_name TEXT,
  snippet TEXT,
  draft TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insights_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT,
  insight TEXT NOT NULL,
  type TEXT,
  surfaced_at TEXT DEFAULT (datetime('now')),
  dismissed INTEGER DEFAULT 0
);

-- Phase 2 tables: created now so connections accumulate from day one
CREATE TABLE IF NOT EXISTS knowledge_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  area TEXT,
  depth TEXT DEFAULT 'aware',
  last_reviewed TEXT DEFAULT (datetime('now')),
  decay_score REAL DEFAULT 1.0,
  next_review TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  summary TEXT NOT NULL,
  knowledge_updates TEXT,
  pattern_observations TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,
  to_id INTEGER NOT NULL,
  to_type TEXT NOT NULL,
  label TEXT,
  inferred INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
