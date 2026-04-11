# Enriched Capture + World Model
**Date:** 2026-04-11  
**Status:** Design approved, pending implementation plan

---

## Philosophical Foundation

Theo OS is a cognitive mirror. It gives a human a view of their own mind from the outside — a perspective that has never been available before. The system builds a model of the user's world from its own observational perspective, not from the user's self-report alone.

This comes with a fundamental responsibility: **accuracy over confidence**. A productivity tool getting something wrong costs a missed task. A cognitive mirror getting something wrong distorts how a person sees themselves. The system must hold inferences lightly, signal uncertainty, and treat every interaction as evidence rather than conclusion.

The LLM is not the expert on the human experience. The user is the expert on their own life. The LLM is the observer — the one who can see the shape of the forest while the user is inside it. It should offer observations ("you mention feeling overwhelmed on Sunday nights") and ask about interpretations ("does that connect to Mondays?"), never reverse those roles.

Learning is bidirectional. The system learns from the user through observation and interaction. The user learns from the system through enrichment, pattern surfacing, and the mirror effect of seeing their own cognitive model made visible. Every interaction is an opportunity for both.

The system should be autonomous in its learning — always expanding its model, never assuming completeness, never claiming expertise in the human condition. There is no terminal state of understanding a person.

The visual metaphor that captures this: **the knowledge graph is a forest**. High-weight nodes are tall trees. Dense connection clusters form canopies. Undergrowth is present but doesn't dominate. You cannot see the shape of a forest from inside it — but the system can, and it shows you.

---

## Core Principles

1. **Observation over assumption** — learn from behavior and language, never project
2. **Epistemic humility** — every inference is a hypothesis with a confidence level, not a fact
3. **Bidirectional learning** — the system teaches the user; the user teaches the system
4. **Importance is earned** — weight is derived from observable signals, never assigned arbitrarily
5. **Connections over isolation** — nothing in the world model exists alone; everything is placed in context of what is already known
6. **Accuracy and safety** — inferences that could distort self-perception must be surfaced carefully and confirmed before being treated as true
7. **Autonomy** — the system grows its understanding continuously without requiring manual programming

---

## The World Model

The system maintains a weighted graph of everything it knows about the user's world. This is not a flat database — it is a model where nodes carry weight and edges carry meaning.

### Importance Signals (what determines weight)

Drawn from what we know about the brain's salience system:

- **Frequency** — how often something is mentioned across captures, journal, chat
- **Emotional intensity** — strength of language used (scored 0-1 by Claude on each capture)
- **Social density** — how many high-weight people are connected to this node
- **Recency** — recent mentions carry more weight, decay over time (Ebbinghaus)
- **Unresolved tension** — open tasks, unfulfilled goals, and recurring themes stay salient
- **Self-relevance** — captures that are directly about the user's identity or values

### Spreading Activation

When a node is mentioned, connected nodes receive a small weight boost. This mirrors the brain's associative recall — thinking about The Odyssey activates Naana, activates Christopher Nolan, activates the goal of seeing it before summer. The system should use this to surface related items during enrichment and review.

### Aliases and Contextual Binding

People (and concepts) have multiple surface representations. "Naana", "my girlfriend", "her", "babe" may all refer to the same high-weight person node. The system learns aliases through:
- Explicit confirmation ("Is this the same Naana?")
- Context inference (same conversation, pronoun reference)
- Asking once and storing permanently — never asking again for the same binding

`people` table gains an `aliases` JSON column. Alias resolution happens before routing.

---

## Enriched Capture Pipeline

The capture flow becomes a staged pipeline. Each stage is a discrete API call with its own failure boundary.

```
idle → routing → [clarifying?] → [dedup check] → enriching → preview → saving → done
```

### Stage 1 — Route + Confidence (`POST /api/theo-os/capture`)

Modified from current. Claude now returns:
```json
{
  "needs_clarification": false,
  "question": null,
  "type": "collection",
  "data": { "type": "movie", "title": "The Odyssey" },
  "mentioned_people": [{ "name": "Naana", "resolved_id": 3 }],
  "emotional_score": 0.4,
  "confidence": 0.92
}
```

If `needs_clarification: true`, returns a targeted question and answer chips. Question fires only when the answer meaningfully changes what gets created — type ambiguity or enrichment disambiguation. Not for missing fields.

Alias resolution runs before Claude sees the text — names are looked up against `people.aliases` and substituted with canonical names + IDs.

### Stage 2 — Deduplication Check (`POST /api/theo-os/capture/dedup`)

Before enriching, fuzzy-match the capture against existing records of the same type. If a match is found above a confidence threshold, the preview offers: "Link to existing record?" or "Create new." This is pattern completion — the system recognizing it has seen this before.

### Stage 3 — Enrich (`POST /api/theo-os/capture/enrich`)

Fires for collections and goals. Uses Tavily to search the real world, feeds results into Claude with the user's memory context to generate a personalized digest. Returns:
```json
{
  "enriched": {
    "title": "The Odyssey",
    "notes": "Christopher Nolan's 2026 epic — his first mythological film...",
    "release_date": "2026-07-17",
    "source": "imdb.com"
  },
  "people": [{ "id": 3, "name": "Naana" }]
}
```

The digest is personalized to what the system already knows about the user — not a Wikipedia summary, but a synthesized version relevant to their interests and context.

### Stage 4 — Preview (frontend)

A filled card with all enriched fields editable. Person mentions appear as linked chips. User approves or edits, then saves. This is the mirror moment for enrichment — the system shows the user something about the world they may not have known.

### Stage 5 — Save + Learn (`POST /api/theo-os/capture/save`)

- Saves the record to the appropriate table
- Creates connection rows for all linked people (using existing `connections` table)
- Updates `weight` on the saved record and all connected nodes (spreading activation)
- Fires background memory extraction — Claude identifies any new fact or preference signal from the interaction and writes it to `memories`
- Save does not wait on memory extraction

---

## Schema Changes

### `people` table
```sql
ALTER TABLE people ADD COLUMN aliases TEXT DEFAULT '[]';  -- JSON array of strings
ALTER TABLE people ADD COLUMN weight REAL DEFAULT 1.0;
```

### All major entity tables (tasks, goals, collections, knowledge_notes, people)
```sql
ALTER TABLE tasks ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE goals ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE collections ADD COLUMN weight REAL DEFAULT 1.0;
-- knowledge_notes already has decay_score, extend with weight
ALTER TABLE knowledge_notes ADD COLUMN weight REAL DEFAULT 1.0;
```

### `memories` table
```sql
ALTER TABLE memories ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN emotional_score REAL DEFAULT 0.0;
```

---

## Knowledge Graph Visual Model

The graph renders the world model visually. Node size and luminosity are proportional to weight. Edge thickness reflects connection strength. Dense clusters form canopies — these are the areas of the user's life with the most activity and interconnection.

The forest metaphor governs all visual decisions:
- High-weight nodes: larger, brighter, more prominent
- Low-weight nodes: smaller, dimmer, present but not dominant
- Dense clusters: organic grouping, not forced layout
- Isolated nodes: clearly peripheral, prompts to connect them
- Weight decay visible over time — nodes that haven't been touched grow dimmer

This is the view of the forest from above. The user cannot see this shape from inside their own life — the system shows it to them.

---

## Error Handling

Each stage fails independently. If enrichment fails, the preview shows un-enriched data and the user can still save. If dedup check fails, capture proceeds as new. If memory extraction fails silently, the record is still saved. No stage failure should block the user from capturing.

---

## What This Is Not

This system does not claim to understand the user. It observes, infers, and asks. It surfaces patterns and offers interpretations as hypotheses. The user is always the authority on their own experience. The system's model is always provisional — a best current understanding, not a verdict.

The goal is not to replace human self-knowledge but to augment it. To show the shape of the forest to someone who has only ever been inside it.
