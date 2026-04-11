# Phase 2a: Memory System Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a living memory substrate that makes every part of Theo OS smarter over time — aligned with Polarity's mission of restoring human cognitive capacity.

**Core principle:** The brain doesn't ask permission to form memories. Neither should this system. Memory is extracted automatically from every interaction, consolidated weekly, and used to adapt every agent's behavior — not just the chat.

---

## Why This Matters

The current system treats each interaction as stateless. The Secretary forgets. The briefing doesn't know Theo is in a high-stress period. The weekly review asks the same questions regardless of what patterns have emerged. This is not a cognitive tool — it's a lookup table.

Phase 2a makes the OS learn. Memory changes how the system *acts*, not just what it knows.

---

## Memory Architecture

### Three Memory Types

Modeled on how the brain encodes different kinds of information:

**1. Facts** (semantic/declarative memory)
Things that are true about Theo's life. High initial confidence, slow decay.
- "Applying to residency programs, decision by June 2026"
- "Co-founder of Polarity Lab"
- "MD '26 at Alpert Medical School, Brown University"

**2. Patterns** (procedural/behavioral memory)
Observed tendencies inferred from behavior over time. Confidence builds through repetition, weakens when contradicted.
- "Avoids financial tasks under stress"
- "Front-loads creative work; productivity declines after 3pm"
- "Captures ideas but rarely converts them to action within 48h"

**3. Preferences** (working memory consolidations)
How Theo likes to operate. High weight, rarely decays — but can be explicitly overridden.
- "Wants direct pushback, not validation"
- "Prefers concise responses over thorough explanations"
- "Treats 'someday' as a real commitment, not a parking lot"

### Schema Addition

```sql
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('fact', 'pattern', 'preference')),
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.7,       -- 0.0 to 1.0
  source TEXT,                        -- 'chat', 'journal', 'consolidation', 'manual'
  area TEXT,                          -- life area if applicable
  reinforcement_count INTEGER DEFAULT 1,
  last_reinforced TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
```

---

## Memory Formation

### Passive extraction (after every chat)
The existing `saveMemory()` fire-and-forget is extended. After each conversation, Claude extracts:
- Any new facts stated explicitly
- Any patterns observable from the exchange
- Any preferences revealed

Each is stored as a candidate memory with initial confidence 0.6. If an identical or similar memory already exists, its confidence is boosted (+0.1, max 1.0) instead of creating a duplicate.

### Weekly consolidation (new cron: Sundays, same run as insights)
The consolidation job:
1. Pulls all memories with confidence < 0.4 — flags them as weak
2. Pulls recent chat sessions and journal entries — cross-references against existing memories
3. Decays all memories not reinforced in 14+ days: confidence -= 0.05 (floor 0.1)
4. Identifies contradictions — memories where new evidence conflicts with stored content — and revises them

This mirrors sleep-based memory consolidation: noise fades, signal strengthens.

---

## How Memory Changes Agent Behavior

This is the key requirement: memory must *change behavior*, not just be stored.

### Secretary Chat
High-confidence memories (>0.6) injected into system prompt in three typed sections:

```
What I know about Theo:
[facts]

Patterns I've observed:
[patterns]

How he likes to work:
[preferences]
```

The Secretary uses these actively — it adjusts tone under stress, references known context, doesn't re-ask things already known.

### Morning Briefing
- If patterns show low energy in the morning: briefing is shorter, fewer items
- If a known high-stress period is active (inferred from tasks/journal): tone adjusts
- Known cognitive load patterns influence task prioritization order

### Weekly Review
- Questions adapt based on neglected areas from memory
- If a pattern like "avoids finances" is high-confidence, the review probes that area specifically
- Doesn't ask questions whose answers are already known with high confidence

### Quick Capture (Claude routing)
- Known preferences improve routing accuracy
- "Theo usually means task when he captures something starting with 'I need to'"
- Area inference uses known life context

### Dashboard
- Life health cards weight their urgency based on known patterns
- If health area is neglected and a pattern confirms this tendency, the card pulses more urgently

---

## The Theo Model Page

A read/write UI over the three memory types. This is essentially free once the memory system exists.

**Layout:**
- Three columns: Facts | Patterns | Preferences
- Each memory is a card showing: content, confidence bar, source, last reinforced date
- Confidence displayed as a fill bar (low = faint, high = bright teal)
- Actions: Edit text, Delete, Boost confidence (manual reinforcement), Suppress (sets confidence to 0.1)

**Design principle:** Full transparency. Theo can see exactly what the system believes about him, correct it, and delete it. The model is his — not the system's.

---

## API Endpoints

```
GET  /api/theo-os/memories           — list all, filterable by type/area/min_confidence
POST /api/theo-os/memories           — manually add a memory
PATCH /api/theo-os/memories/[id]     — edit content or adjust confidence
DELETE /api/theo-os/memories/[id]    — delete
```

---

## Cron Changes

The existing weekly insights cron (`0 10 * * 7`) is extended to also run `consolidateMemories()`. No new cron needed.

---

## What Does NOT Change

- `chat_memory` table remains for session summaries (used as episodic context)
- The new `memories` table is for durable, typed, confidence-weighted knowledge
- Both are injected into the Secretary's system prompt — episodic for recent context, semantic for durable knowledge

---

## Success Criteria

1. After 3 conversations, the Secretary stops asking things it already knows
2. The morning briefing tone measurably adapts when task/journal patterns indicate stress
3. The Theo Model page shows at least 5 accurate memories after one week of use
4. Weekly consolidation demonstrably decays unused memories and strengthens reinforced ones

---

*Design approved: 2026-04-11*
