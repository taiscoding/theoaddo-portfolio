# Theo OS — Design Document

Date: 2026-04-11

## Summary

A private, login-gated admin portal at `theoaddo.com/admin`. A personal chief of staff and digital exocortex. You dump everything into it as it comes to you. Claude processes, organizes, and surfaces back what matters when it matters. Over time it builds a model of how you think, where you're drifting from your stated direction, and what you're forgetting. The goal is to hold the full picture of your life so your mind doesn't have to, and to reflect you back to yourself with clarity.

Inspired by MIT Media Lab's MindMapper research: adaptive AI that models behavioral patterns, surfaces cognitive drift, and functions as a genuine thinking partner — not a sycophantic assistant.

---

## Problem

Life comes at you in fragments. An email to reply to. A restaurant someone mentioned. A financial goal you keep pushing. A person you meant to call three weeks ago. A concept from a lecture that's already fading. None of it is connected. None of it has a home. The overhead of managing it all competes with the actual work of doing it.

The result is chronic overwhelm — not from lacking capability but from lacking an external system that can hold context, track direction, and surface the right thing at the right time.

---

## Architecture

### Stack

- **Frontend**: `/admin/` directory in `theoaddo.com`, plain HTML/CSS/JS matching site aesthetic. No framework.
- **Backend**: Cloudflare Pages Functions (`functions/api/theo-os/`), Workers runtime, JS — same pattern as Polarity Lab OS
- **Database**: Cloudflare D1 (`theo_os_db`), SQLite-compatible, schema designed to support Phase 2 knowledge graph from day one
- **Cache**: Cloudflare KV (`THEO_OS_KV`) for morning briefing
- **AI**: Claude API (`claude-sonnet-4-6`) for all generation, assessment, and chat
- **Graph**: Cytoscape.js for force-directed knowledge graph visualization
- **Integrations**: Gmail API + Google Calendar API via Google OAuth 2.0
- **Auth**: JWT-based login, single admin user, bcrypt password hash

### Hosting

Cloudflare Pages on personal Cloudflare account (not Shadrack's). Frontend at `theoaddo.com/admin`. API routes at `theoaddo.com/api/theo-os/*`, protected by JWT middleware.

### Cron

Cloudflare Cron Trigger at 6:00 AM daily: pulls Gmail + GCal, generates morning briefing, stores in KV.

---

## Database Schema

```sql
-- Core life OS tables
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  area TEXT,           -- work, health, finances, relationships, growth, creative, exploration, life
  status TEXT DEFAULT 'inbox',  -- inbox, today, this_week, later, someday, done
  due_date TEXT,
  notes TEXT,
  goal_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',  -- active, paused, achieved, abandoned
  target_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending, done
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relationship TEXT,  -- friend, family, colleague, mentor, etc.
  notes TEXT,
  last_contact TEXT,
  next_touchpoint TEXT,
  touchpoint_interval_days INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,  -- restaurant, travel, movie, book, idea, other
  title TEXT NOT NULL,
  notes TEXT,
  source TEXT,         -- who recommended it
  status TEXT DEFAULT 'want',  -- want, done
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE life_vision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL UNIQUE,
  vision TEXT,         -- where you want to be
  values TEXT,         -- what matters to you here
  current_phase TEXT,  -- what this period of life looks like
  success_definition TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT,           -- comma-separated
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  subject TEXT,
  from_address TEXT,
  from_name TEXT,
  snippet TEXT,
  draft TEXT,
  status TEXT DEFAULT 'pending',  -- pending, approved, sent, dismissed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE insights_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT,
  insight TEXT NOT NULL,
  type TEXT,           -- drift, decay, pattern, relationship
  surfaced_at TEXT DEFAULT (datetime('now')),
  dismissed INTEGER DEFAULT 0
);

-- Phase 2: Knowledge layer (tables created in Phase 1, used in Phase 2)
CREATE TABLE knowledge_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  area TEXT,
  depth TEXT DEFAULT 'aware',  -- aware, familiar, fluent (inferred, not self-reported)
  last_reviewed TEXT DEFAULT (datetime('now')),
  decay_score REAL DEFAULT 1.0,  -- 1.0 = fresh, 0.0 = fully faded
  next_review TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE chat_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  summary TEXT NOT NULL,        -- what the session revealed about Theo's thinking
  knowledge_updates TEXT,       -- JSON: depth observations per topic
  pattern_observations TEXT,    -- reasoning patterns noticed
  created_at TEXT DEFAULT (datetime('now'))
);

-- Graph layer: connections between any two entities
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  from_type TEXT NOT NULL,  -- task, goal, person, knowledge_note, journal, collection
  to_id INTEGER NOT NULL,
  to_type TEXT NOT NULL,
  label TEXT,               -- "advances", "relates to", "inspired by", "involves", etc.
  inferred INTEGER DEFAULT 1,  -- 1 = Claude inferred, 0 = manually added
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Modules

### 1. Dashboard — Life Health

The home screen.

**Morning briefing** — Generated by Cron at 6am, cached in KV. Gmail summary (important unread threads), today's calendar events, overdue tasks, tasks due today. One paragraph of context written by Claude: what the day looks like and what needs you.

**Life area health cards** — Eight cards: Work, Finances, Health, Relationships, Growth, Creative, Exploration, Life. Each shows a simple activity signal (green/yellow/red) based on task and goal activity in the last 14 days for that area. Not a score, just a signal.

**Attention section** — Same pattern as Polarity Lab OS. Urgent items with color-coded dots (coral = urgent, yellow = soon, teal = ok). Overdue tasks, upcoming deadlines, people past their touchpoint date.

**Agent cards** — What's running and what it does. Briefing Agent (6am daily), Email Triage Agent, Weekly Insight Agent (Sundays).

**MindMapper insight** — One behavioral pattern observation per day, drawn from `insights_log`. Examples: "You've added 8 restaurants but visited 0 in 90 days." "Your Health area has had no activity in 2 weeks." "4 people haven't heard from you in over a month."

---

### 2. Quick Capture

Single text field. The primary entry point for everything. No forms. No categories to select. Just type.

Claude reads the input and routes it to the right table with the right metadata. It confirms the routing in plain language and lets you correct before saving.

Examples:
- "call Dr. Ahmed to reschedule" → task, Health, due today
- "try that Ethiopian place Marcus mentioned" → collection, restaurant, source: Marcus
- "goal: save $10k by end of residency year" → goal, Finances
- "watch Nickel Boys" → collection, movie
- "haven't talked to dad in a while" → people touchpoint flag for Dad
- "need to renew car registration in June" → task, Life, due June
- "the basal ganglia is involved in habit formation through dopaminergic reward loops" → knowledge note (Phase 2)
- "I keep avoiding the financial stuff because it feels like admitting something" → journal + insight flag

The capture field is accessible from every page via a keyboard shortcut (Cmd+K) so it never requires navigation.

---

### 3. Goals & Direction

Goals organized by life area. Each goal has sub-milestones with due dates. Status: active, paused, achieved, abandoned.

Tasks can link to goals (set in capture or manually). The secretary chat can answer "am I on track for X?" by reading goal progress, linked task completion rate, and time remaining.

Claude surfaces "what you should be doing today to move toward your goals" in the morning briefing when relevant.

---

### 4. Life Vision

One page, structured fields, seeded once and updated occasionally.

Eight sections, one per life area. Each section has: where you want to be, what you value here, what this current phase looks like, what success means to you. Free text, personal.

This is the north star for everything else. Without it, the insights layer can only describe behavior. With it, it can connect behavior to intention: "you said health matters to you this year, but the area has been inactive for 14 days."

The chat reads from this table to contextualize almost every response.

---

### 5. Tasks

Simple board view: Inbox / Today / This Week / Later / Someday. Area tags. Due dates. Notes. Linked goal.

Tasks are primarily created through Quick Capture. The board is for review and adjustment, not for adding new things.

---

### 6. People

Explicitly curated. Not a full contact list — only people you want to maintain a real relationship with.

Fields: name, relationship type, last contact date, planned next touchpoint, touchpoint interval (how often you want to be in touch), notes.

Health indicator: green if last contact is within interval, yellow if approaching, red if overdue. Dashboard attention section surfaces red/yellow people.

The chat can draft a "reaching out" message for any person, pulling from their notes for context. Clicking a person shows their history: when you last connected, what you talked about (from journal entries referencing them, if any).

---

### 7. Collections

Five buckets: Restaurants, Travel, Movies & TV, Books, Ideas. Simple list per type. Title, notes, source, status (want/done). Items can be created by Quick Capture and browsed here.

No pipelines. No complexity. Just a clean place for the things that enrich life.

---

### 8. Email Triage

Pulls the 20 most recent unread or important Gmail threads. Claude categorizes urgency and writes a draft reply for each. You see: sender, subject, snippet, urgency level, and the draft.

Actions: Edit and send (Gmail API sends on your behalf), Dismiss, Convert to task, Snooze.

Nothing auto-sends. Ever.

---

### 9. Weekly Review

A structured flow, available any time but prompted every Sunday by the weekly agent.

Five steps run as a guided conversation in the chat:
1. What did you complete this week across each life area?
2. What slipped and why?
3. What does the system notice you've been avoiding?
4. What are the 3 most important things for next week?
5. Any new captures to process?

The review output is stored as a journal entry and used to update `insights_log`.

---

### 10. Journal

Free-form writing space. Longer thoughts, processing things that happened, working through decisions over time.

The Phase 2 knowledge layer draws heavily from journal entries — they reveal how you think, what you believe, what you're uncertain about. Even in Phase 1, journal entries are indexed by tags and referenced by the chat.

---

### 11. Chat — The Secretary and Thinking Partner

The primary interface. Full agentic access to all data in the system.

**As secretary**: query and update the system in natural language. "What should I focus on today?" "Who haven't I talked to in too long?" "Add Dune Messiah to my reading list." "Move the registration task to today."

**As thinking partner**: this is the more important role. The chat is not trying to answer you — it is trying to help you think. It asks before it tells. It surfaces the assumption underneath your question before answering it. It pushes back when your reasoning is soft. It is explicitly not sycophantic: it does not validate ideas to make you feel good, it does not agree to avoid friction, it does not soften challenges that should be direct.

The system prompt is the most carefully designed piece of the whole build. It draws from Polarity Lab's sycophancy research. The chat knows your life vision, your goals, your behavioral patterns, and your current areas of drift. It uses this context to ask better questions, not to give more personalized answers.

**Phase 2 addition — knowledge assessment**: the chat weaves depth-probing questions naturally into conversation. When the moment calls for it, it asks something that reveals how well you actually understand something. It notes the evidence. It does not announce it is assessing you — it just asks good questions and learns.

**Tools available to chat:**
- `get_life_summary` — full picture across all areas
- `get_tasks` — filter by area, status, due date
- `get_goals` — goal and milestone progress
- `get_people` — relationship health, overdue touchpoints
- `get_email_queue` — staged drafts
- `get_vision` — life vision for context
- `get_insights` — behavioral pattern log
- `add_task`, `add_goal`, `add_person`, `add_to_collection`, `add_journal_entry`
- `update_task`, `update_goal`, `update_person`
- `get_knowledge` (Phase 2) — knowledge note depth and decay

**UI**: identical pattern to Polarity Lab OS chat. Tool chips, thinking spinner, markdown rendering, persistent history within session.

**Memory**: after each session, Claude writes a summary to `chat_memory`: what the conversation revealed about your thinking, any knowledge depth observations, any pattern observations. Future sessions load recent memory as context.

---

### 12. The Theo Model (Phase 2)

A dedicated page showing what the system has inferred about you. Sections:

- **Behavioral patterns**: recurring observations from `insights_log`
- **Knowledge map**: your knowledge areas, inferred depth, decay scores
- **Life area activity**: 90-day activity chart per area
- **Chat memory log**: what the system has learned about how you think

You can read, correct, and delete any entry. The model is yours. Transparency is non-negotiable.

---

### 13. Knowledge Graph (Phase 2)

A visual, interactive force-directed graph of everything in the system.

Every entity (goal, task, person, knowledge note, journal entry, idea) is a node. Claude infers connections and writes them to the `connections` table. The graph renders these connections as edges.

**Visual design:**
- Dark background (void palette)
- Nodes glow in area colors: teal (work/growth), coral (health/life), purple (relationships/creative)
- Node size = activity weight
- Node brightness = recency / decay score. Knowledge nodes literally dim as they fade.
- Edges as faint light traces, brighter for stronger connections
- Force-directed layout: connected things cluster together naturally. Cross-cluster connections are visible as long-range traces.

**Interaction:**
- Hover: see node title and type
- Click: open the entity inline
- Drag: reposition nodes
- Filter by area or type
- Zoom and pan

Built with Cytoscape.js. The graph is not a metaphor for your mind. It is a rendering of what is actually in the system and how things are actually connected — which means it shows you something true.

---

## Phased Delivery

### Phase 1 — Life OS

- JWT auth and login screen
- Dashboard (briefing, health cards, attention, agents)
- Quick Capture with Claude routing
- Tasks board
- Goals and milestones
- Life Vision page
- People (relationship CRM)
- Collections (5 buckets)
- Email Triage (Gmail API, staged drafts)
- Weekly Review flow
- Journal
- Secretary chat (full tool access, session memory)
- MindMapper insight layer (weekly background job)
- D1 schema including Phase 2 tables
- `connections` table populated by Claude from day one

### Phase 2 — Knowledge and Graph

- Knowledge notes with spaced repetition and decay scoring
- Depth assessment woven into chat conversation
- Persistent chat memory across sessions
- Socratic system prompt with depth probing
- The Theo Model page
- Knowledge graph visualization (Cytoscape.js)
- Review prompts surfaced based on decay score

---

## Design System

Adapted from Polarity Lab OS admin.css. Same void palette, same typography (Space Grotesk / Inter / JetBrains Mono), same teal/coral/purple accent system. Dark and light theme toggle. The admin feels like it belongs to the same visual world as the personal site.

---

## What This Is Not

- Not a public product. Single user, fully private.
- Not a replacement for Gmail or Google Calendar. An intelligence layer on top of them.
- Not a sycophantic assistant. The chat's job is to help you think clearly, not to make you feel good about your thinking.
- Not a finished model of you. The Theo Model is a working hypothesis the system is always updating, not a label.

---

*Design approved: 2026-04-11*
