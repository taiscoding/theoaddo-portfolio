# Phase 2b: Knowledge System Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a cognitive restoration engine — a knowledge system that diagnoses gaps, actively strengthens memory and learning, and creates lasting cognitive change both inside and outside the OS.

**Core principle:** The OS is both the diagnostic instrument and the therapeutic environment. It measures where cognition has weakened and applies evidence-based interventions to restore and advance it. Nothing falls through the cracks. Memory and knowledge feel stronger and more interconnected over time. The rate of learning improves. The tool produces lasting change when Theo is not using it.

This is aligned with Polarity's mission: restoring what has been lost from the human condition.

---

## Why This Matters

Memory and knowledge decay by default. Most tools make this worse — they offload cognition rather than strengthen it. This system does the opposite. It tracks what Theo knows, identifies where depth has faded, surfaces knowledge at the moment of maximum retrievability, and delivers personalized learning interventions that produce real cognitive change.

The combination of spaced repetition (timing), active recall (testing effect), elaborative encoding (connections), and personalized resource digestion (tailored to how Theo actually thinks) is the most evidence-based approach to durable learning available.

---

## Architecture

### Three layers

**1. Knowledge store** — the `knowledge_notes` table, extended with SM-2 spaced repetition fields. Each note has a title, content, area, depth (aware/familiar/fluent), decay score, next review date, and ease factor.

**2. Assessment engine** — passive and active depth probing woven into every chat exchange. The Secretary notices knowledge signals naturally and asks deliberate test questions when a note is due. Haiku scores recall quality 1-5 in the background. Score drives the next interval and can advance or regress depth level.

**3. Knowledge Review mode** — a voluntary, dedicated review session. Surfaces gaps and weak notes. For each: generates a Socratic prompt, searches the web for the best available resource, fetches and digests the content tailored to Theo's cognitive patterns (from memory system), and presents it with the original link. Engaging with the prompt scores the exchange and updates SM-2 state.

---

## Schema Changes

Two new columns on `knowledge_notes`:

```sql
ALTER TABLE knowledge_notes ADD COLUMN ease_factor REAL DEFAULT 2.5;
ALTER TABLE knowledge_notes ADD COLUMN last_score INTEGER DEFAULT 0;
```

`ease_factor` governs how fast the review interval grows. Starts at 2.5 (SM-2 default). Strong scores push it toward 3.5. Weak scores pull it toward 1.3. This encodes how well Theo retains a given topic — not just that he reviewed it.

`last_score` is the most recent 1-5 recall quality score. Used to decide whether to probe again soon and whether to adjust depth.

---

## SM-2 Interval Logic

After every scored assessment:

```
if score >= 4:
  new_ease = ease_factor + 0.1  (capped at 3.5)
  new_interval = previous_interval * new_ease
  depth advances if score = 5 and current depth < fluent

if score == 3:
  new_ease = ease_factor (unchanged)
  new_interval = previous_interval * 1.2
  depth holds

if score <= 2:
  new_ease = max(1.3, ease_factor - 0.2)
  new_interval = 1 day (relearn)
  depth regresses one level if score = 1
```

Base intervals by depth:
- `aware`: next_review = today + 3 days on first review
- `familiar`: next_review = today + 7 days on first review
- `fluent`: next_review = today + 21 days on first review

These compound over time. A well-maintained `fluent` note can reach 90+ day intervals.

---

## Decay Score

`decay_score` is not the same as interval. It is a real-time freshness signal (1.0 = fully fresh, 0.0 = fully faded) that decays exponentially between reviews, following the Ebbinghaus forgetting curve:

```
decay_score = e^(-k * days_since_last_review)
```

Where `k` is a depth-dependent decay constant:
- `aware`: k = 0.14 (half-life ~5 days)
- `familiar`: k = 0.05 (half-life ~14 days)
- `fluent`: k = 0.02 (half-life ~35 days)

This means deeper knowledge decays slower — which matches empirical memory research. The weekly cron recalculates decay for all notes and identifies which are below 0.5 (due for surfacing).

---

## Depth Assessment in Chat

### Passive extraction
After every exchange, the existing `saveMemory()` fire-and-forget is extended to also extract knowledge signals. Haiku looks for:
- Topics Theo mentions with apparent familiarity
- Claims Theo makes about understanding something
- Corrections or gaps Theo shows in his reasoning

If a matching `knowledge_note` exists, its `last_reviewed` is updated and a soft score (3) is applied. If no note exists for the topic and the signal is strong enough, a new note is created at `aware` depth.

### Active probing
When a knowledge note is due (`next_review <= today`) AND a related topic comes up naturally in conversation, the Secretary asks a deliberate depth-check question. Not "do you know X" — a question that requires applying, explaining, or connecting the concept. After Theo responds, Haiku scores the exchange 1-5 and updates SM-2 state.

The Secretary never announces it is testing. It just asks good questions.

### Scoring rubric (run by Haiku post-exchange)

| Score | Meaning |
|-------|---------|
| 1 | Blank or wrong — couldn't recall |
| 2 | Vague — recognized the topic but couldn't explain |
| 3 | Partial — got the gist, missed key details |
| 4 | Solid — accurate and reasonably complete |
| 5 | Deep — explained it, connected it, applied it |

Score is never shown to Theo. It runs in the background.

---

## Knowledge Review Mode

A dedicated page (`/admin/learn.html`) that Theo enters voluntarily. This is the primary therapeutic environment.

### Page layout
- Header: "Knowledge Review" with count of notes due and weak
- List of notes sorted by urgency (overdue first, then by lowest decay_score)
- Each note shows: title, area, depth badge, decay bar, days overdue

### Per-note review session
When Theo clicks a note, the system:

1. **Generates a Socratic prompt** — not "what is X" but a question that requires active engagement: applying the concept, explaining it to a hypothetical audience, connecting it to something Theo already knows (using his memory context)

2. **Fetches live resources** — calls Brave Search API for the topic, returns top 3 results with titles and URLs

3. **Digests the best resource** — fetches the page content, strips HTML, passes to Claude with Theo's cognitive profile (patterns + preferences from memory system) and asks it to reframe the material in a way that matches how Theo learns. Not a generic summary — a personalized re-presentation of the ideas.

4. **Presents**:
   - The Socratic prompt at the top (engage with this)
   - The tailored digest below
   - "Original source: [hyperlinked title]" at the bottom

When Theo types a response to the Socratic prompt, the exchange is scored by Haiku and SM-2 state is updated. The review session is complete.

---

## How Knowledge Changes Agent Behavior

Like memories, knowledge notes with low decay score are surfaced everywhere:

### Morning briefing
If any notes have `decay_score < 0.4` or `next_review <= today`, the briefing includes a line:
"3 knowledge areas due for review — [topic1], [topic2], [topic3]"

If decay is very low (<0.2), the tone acknowledges cognitive drift: the briefing treats this the way it would treat an overdue goal.

### Weekly review
A dedicated step: "Knowledge check" — shows which areas have faded most since last week. Asks Theo one depth question per area, scores it, updates state.

### Chat (Secretary)
- Low-decay notes are injected into the system prompt so the Secretary knows what Theo is currently weak on
- When relevant topics arise, Secretary probes actively if note is due
- When Theo demonstrates strong recall of something due, Secretary updates the note positively

---

## API Endpoints

```
GET  /api/theo-os/knowledge              — list all notes (filter: area, depth, max_decay)
POST /api/theo-os/knowledge              — manually add a note
PATCH /api/theo-os/knowledge/[id]        — edit title, content, area, depth
DELETE /api/theo-os/knowledge/[id]       — delete

POST /api/theo-os/knowledge/[id]/review  — start a review session
                                           returns: { prompt, digest, resources: [{title, url}] }
POST /api/theo-os/knowledge/[id]/score   — submit recall response and score it
                                           body: { response: string }
                                           returns: { score, new_depth, new_interval, next_review }
```

The review endpoint calls Brave Search and fetches + digests the top resource. It is the core of the therapeutic environment.

---

## Cron Changes

The existing weekly insights cron (`0 10 * * 7`) is extended to also run `consolidateKnowledge()`:

1. Recalculate `decay_score` for all notes using Ebbinghaus formula
2. Set `next_review` for notes that don't have one yet
3. For notes with `decay_score < 0.2`: insert a briefing hint into KV for tomorrow's briefing

---

## New Environment Variable Required

```
BRAVE_SEARCH_API_KEY — Brave Search API key for live resource fetching
```

Free tier: 2000 queries/month. Sufficient for personal use.

---

## The Interconnection Principle

When a knowledge note is created or reviewed, Claude populates the `connections` table automatically:
- Connects the note to relevant goals, journal entries, or other knowledge notes
- Edge label: "relates to", "supports", "builds on", "contradicts"

This makes the knowledge graph (Phase 2c) meaningful from day one of Phase 2b. Notes aren't isolated — they exist in a web that mirrors associative memory.

---

## Success Criteria

1. After two weeks of use, Theo can open `/admin/learn.html` and see an honest map of where his knowledge has faded — not a guess, an evidence-based decay curve
2. A review session on a weak topic produces a personalized digest that Theo actually reads (not a generic Wikipedia summary)
3. The Secretary stops re-explaining things Theo demonstrably knows (high-confidence, low-decay notes are excluded from basic explanations)
4. Theo notices his retention of topics he's reviewed in the OS is meaningfully better than topics he has not

---

*Design approved: 2026-04-11*
