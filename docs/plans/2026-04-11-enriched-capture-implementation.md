# Enriched Capture + World Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Quick Capture into a staged enrichment pipeline that routes, deduplicates, enriches with real-world data, previews, saves, and learns — grounded in a weighted world model of the user.

**Architecture:** Five discrete API endpoints (route, dedup, enrich, save) plus a frontend state machine in capture.html. Weight is added to all major entity tables and updated via spreading activation on every save. Alias resolution runs before every routing call using a people aliases lookup.

**Tech Stack:** Cloudflare Pages Functions, D1 SQLite, KV, Anthropic claude-haiku-4-5 (routing/dedup), claude-sonnet-4-6 (enrichment/memory extraction), Tavily search API, vanilla JS state machine frontend.

**Deploy command:** `CLOUDFLARE_API_TOKEN=cfut_0aGGCrkIY2PvElvuhgpxStSPxSaGlahzm4dzex0s78d2ec70 npx wrangler pages deploy . --project-name theo-os`

---

### Task 1: Schema Migrations — Weight + Aliases

Add `weight` to all major entity tables and `aliases` to people. Weight starts at 1.0 for all records, grows through spreading activation.

**Files:**
- Reference: `wrangler.toml` (D1 binding is `THEO_OS_DB`, database `theo_os_db`)

**Step 1: Run migrations via Cloudflare D1 dashboard console**

Go to Cloudflare Dashboard → D1 → `theo_os_db` → Console. Run each block separately:

```sql
ALTER TABLE tasks ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE goals ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE collections ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE people ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE people ADD COLUMN aliases TEXT DEFAULT '[]';
ALTER TABLE memories ADD COLUMN weight REAL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN emotional_score REAL DEFAULT 0.0;
ALTER TABLE knowledge_notes ADD COLUMN weight REAL DEFAULT 1.0;
```

**Step 2: Verify**

In D1 console:
```sql
SELECT name, sql FROM sqlite_master WHERE type='table' AND name='people';
```
Expected: `aliases TEXT DEFAULT '[]'` and `weight REAL DEFAULT 1.0` visible in schema.

```sql
SELECT weight, aliases FROM people LIMIT 1;
```
Expected: returns `1.0` and `[]` (or empty if no rows).

---

### Task 2: Alias Resolution Utility in `_utils.js`

Before any capture routing, resolve known aliases to canonical people names + IDs so the AI sees "Naana (id:3)" instead of an unknown name.

**Files:**
- Modify: `functions/api/theo-os/_utils.js`

**Step 1: Read the file first**

Read `functions/api/theo-os/_utils.js` to understand existing exports and structure before editing.

**Step 2: Add `resolveAliases` function**

Add at the end of `_utils.js`, before the final exports:

```js
// Resolve known person aliases in capture text before routing
// Returns { resolvedText, mentionedPeople: [{id, name}] }
export async function resolveAliases(text, env) {
  try {
    const { results: people } = await env.THEO_OS_DB.prepare(
      'SELECT id, name, aliases FROM people'
    ).all();

    const mentioned = [];
    let resolved = text;

    for (const person of people) {
      // Always check canonical name
      const namesToCheck = [person.name];
      
      // Parse aliases JSON array
      try {
        const aliases = JSON.parse(person.aliases || '[]');
        namesToCheck.push(...aliases);
      } catch { /* ignore malformed aliases */ }

      for (const alias of namesToCheck) {
        if (!alias) continue;
        const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (regex.test(resolved)) {
          // Replace with canonical name annotated with ID for AI context
          resolved = resolved.replace(regex, `${person.name}[person:${person.id}]`);
          if (!mentioned.find(m => m.id === person.id)) {
            mentioned.push({ id: person.id, name: person.name });
          }
          break; // Found for this person, move on
        }
      }
    }

    return { resolvedText: resolved, mentionedPeople: mentioned };
  } catch {
    return { resolvedText: text, mentionedPeople: [] };
  }
}
```

**Step 3: Commit**

```bash
git add functions/api/theo-os/_utils.js
git commit -m "feat: add resolveAliases utility for people name/alias detection in captures"
```

---

### Task 3: Modified Capture Route Endpoint

Replace the existing single-step capture with a routing-only step that returns confidence, optional clarification question, detected people, and emotional score. Does NOT save anything.

**Files:**
- Modify: `functions/api/theo-os/capture.js`
- Read first to understand current structure

**Step 1: Read the current file**

Read `functions/api/theo-os/capture.js` in full before editing.

**Step 2: Replace the routing system prompt and response handling**

The new `capture.js` only ROUTES — it does not insert into the DB. Replace the entire file content:

```js
import { json, err, requireAdmin, loadMemoryContext, resolveAliases } from './_utils.js';

const ROUTE_SYSTEM = `You are the routing intelligence for Theo OS, a personal life OS.
Parse a natural-language capture and route it. Respond with JSON ONLY (no markdown):

{
  "confidence": 0.0-1.0,
  "needs_clarification": true|false,
  "question": "short targeted question if needs_clarification is true, else null",
  "answer_chips": ["Option A", "Option B"] or null,
  "type": "task" | "goal" | "person" | "collection" | "journal",
  "data": { ...type-specific fields },
  "emotional_score": 0.0-1.0
}

Field specs by type:
- task: { title, area (work/finances/health/relationships/growth/creative/exploration/life), due_date (YYYY-MM-DD or null), notes: null }
- goal: { title, area, description: null, target_date: null }
- person: { name, relationship: null, notes: null, next_touchpoint: null }
- collection: { type (restaurant/travel/movie/book/idea/other), title, notes: null, source: null }
- journal: { content, tags: null }

Confidence rules:
- 0.9+: clearly one type, all key fields obvious
- 0.7-0.89: likely correct but one field ambiguous
- below 0.7: set needs_clarification=true, provide question + 2 answer_chips

Clarification fires ONLY for type ambiguity or enrichment target ambiguity (e.g. "The Odyssey" — film or book?).
Never ask about missing optional fields. Make your best guess on those.

Emotional score: 0=neutral log entry, 1=high emotional intensity (love, fear, loss, joy, urgency).

People: text may contain [person:ID] annotations — use these to identify mentioned people.
Return the canonical names only in data fields.`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { text, clarification } = body;
  if (!text?.trim()) return err('Text required');

  // Resolve aliases before routing
  const { resolvedText, mentionedPeople } = await resolveAliases(text.trim(), env);

  const memory = await loadMemoryContext(env);
  const fullText = clarification
    ? `Original: ${resolvedText}\nClarification: ${clarification}`
    : resolvedText;

  const system = `${ROUTE_SYSTEM}

Known context about Theo:
- Facts: ${memory.facts}
- Patterns: ${memory.patterns}`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: fullText }]
    })
  });

  if (!aiRes.ok) return err('Routing failed', 502);

  const aiData = await aiRes.json();
  let routed;
  try {
    let raw = aiData.content[0].text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const match = raw.match(/\{[\s\S]*\}/);
    routed = JSON.parse(match ? match[0] : raw);
  } catch {
    return err('Failed to parse routing response', 502);
  }

  return json({
    ...routed,
    mentioned_people: mentionedPeople,
    original_text: text.trim(),
    resolved_text: resolvedText
  });
}
```

**Step 3: Commit**

```bash
git add functions/api/theo-os/capture.js
git commit -m "feat: capture route-only endpoint with confidence, clarification, alias resolution"
```

---

### Task 4: Deduplication Endpoint

Fuzzy-match a new capture against existing records of the same type. If a likely match exists, return it so the frontend can offer "link to existing" instead of creating a duplicate.

**Files:**
- Create: `functions/api/theo-os/capture/dedup.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, title } = body;
  if (!type || !title) return err('type and title required');

  // Map capture type to DB table
  const tableMap = {
    task: { table: 'tasks', field: 'title' },
    goal: { table: 'goals', field: 'title' },
    collection: { table: 'collections', field: 'title' },
    person: { table: 'people', field: 'name' },
  };

  const mapping = tableMap[type];
  if (!mapping) return json({ match: null });

  // Fetch recent records of this type for fuzzy matching
  const { results } = await env.THEO_OS_DB.prepare(
    `SELECT id, ${mapping.field} as label, weight FROM ${mapping.table} ORDER BY weight DESC, id DESC LIMIT 50`
  ).all();

  // Simple fuzzy match: normalize both strings, check if significant words overlap
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = s => new Set(normalize(s).split(/\s+/).filter(w => w.length > 3));

  const titleWords = words(title);
  let bestMatch = null;
  let bestScore = 0;

  for (const record of results) {
    const recordWords = words(record.label);
    const intersection = [...titleWords].filter(w => recordWords.has(w));
    const union = new Set([...titleWords, ...recordWords]);
    const score = intersection.length / union.size; // Jaccard similarity

    if (score > bestScore) {
      bestScore = score;
      bestMatch = record;
    }
  }

  // Only surface match if similarity is meaningful (>40%)
  if (bestScore < 0.4 || !bestMatch) return json({ match: null });

  return json({
    match: {
      id: bestMatch.id,
      label: bestMatch.label,
      type,
      score: Math.round(bestScore * 100)
    }
  });
}
```

**Step 2: Commit**

```bash
git add functions/api/theo-os/capture/dedup.js
git commit -m "feat: capture dedup endpoint — Jaccard similarity match against existing records"
```

---

### Task 5: Enrichment Endpoint

For collections and goals: search Tavily, feed results + user memory into Claude, return a personalized digest and enriched fields.

**Files:**
- Create: `functions/api/theo-os/capture/enrich.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin, loadMemoryContext } from '../_utils.js';

const ENRICH_SYSTEM = `You are enriching a capture for Theo OS. Given search results about an item,
produce a personalized digest that's relevant to what you know about the user.

Respond with JSON ONLY (no markdown):
{
  "notes": "2-3 sentence digest, personalized to user context, written for them not about them",
  "release_date": "YYYY-MM-DD or null",
  "source": "domain of most useful source or null",
  "extra_fields": {} 
}

Rules:
- notes should feel like a friend who did the research telling you what matters
- if user memory mentions relevant preferences, tailor the digest to those
- release_date only for movies/events, null otherwise
- keep notes under 200 chars for readability`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, data, mentioned_people } = body;

  if (!type || !data?.title) return err('type and data.title required');

  // Only enrich collections and goals
  if (!['collection', 'goal'].includes(type)) {
    return json({ enriched: data, people: mentioned_people || [] });
  }

  // Tavily search
  let searchResults = '';
  try {
    const tavRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: `${data.title} ${data.type || ''}`.trim(),
        max_results: 4,
        search_depth: 'basic'
      })
    });
    if (tavRes.ok) {
      const tavData = await tavRes.json();
      searchResults = tavData.results
        ?.slice(0, 4)
        .map(r => `${r.title}: ${r.content?.slice(0, 200)}`)
        .join('\n') || '';
    }
  } catch { /* enrichment degrades gracefully */ }

  const memory = await loadMemoryContext(env);

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: `${ENRICH_SYSTEM}\n\nUser context:\n- Facts: ${memory.facts}\n- Patterns: ${memory.patterns}`,
      messages: [{
        role: 'user',
        content: `Enrich this ${type}: "${data.title}"\n\nSearch results:\n${searchResults || 'No results found.'}`
      }]
    })
  });

  let enriched = { ...data };
  if (aiRes.ok) {
    try {
      const aiData = await aiRes.json();
      let raw = aiData.content[0].text.trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      enriched = { ...data, ...parsed };
    } catch { /* return un-enriched data on parse failure */ }
  }

  // Resolve people IDs to full records
  let people = [];
  if (mentioned_people?.length) {
    const ids = mentioned_people.map(p => p.id).join(',');
    const { results } = await env.THEO_OS_DB.prepare(
      `SELECT id, name, relationship FROM people WHERE id IN (${ids})`
    ).all();
    people = results;
  }

  return json({ enriched, people });
}
```

**Step 2: Commit**

```bash
git add functions/api/theo-os/capture/enrich.js
git commit -m "feat: capture enrich endpoint — Tavily search + personalized Claude digest"
```

---

### Task 6: Save + Learn Endpoint

Save the final (possibly edited) record, create connections to linked people, update weights via spreading activation, fire background memory extraction.

**Files:**
- Create: `functions/api/theo-os/capture/save.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../_utils.js';

// Spreading activation: boost weight on connected nodes
async function spreadActivation(env, fromType, fromId, peopleIds) {
  const boost = 0.15;
  // Boost mentioned people
  for (const pid of peopleIds) {
    await env.THEO_OS_DB.prepare(
      'UPDATE people SET weight = MIN(weight + ?, 10.0) WHERE id = ?'
    ).bind(boost, pid).run().catch(() => null);
  }
  // Boost the saved record itself on next interactions (handled by weight init)
}

// Background memory extraction — fire and forget
async function extractMemory(env, type, data, originalText, peopleNames) {
  try {
    const context = peopleNames.length
      ? `${originalText} (involves: ${peopleNames.join(', ')})`
      : originalText;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: `Extract ONE memorable fact or preference about the user from this capture, if any.
Return JSON only: { "memory": "short fact string under 80 chars", "type": "fact"|"preference"|"pattern" }
Return { "memory": null } if nothing worth remembering.`,
        messages: [{ role: 'user', content: `Capture: "${context}"\nRouted as: ${type}` }]
      })
    });

    if (!res.ok) return;
    const aiData = await res.json();
    let raw = aiData.content[0].text.trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);

    if (parsed.memory) {
      await env.THEO_OS_DB.prepare(
        'INSERT INTO memories (type, content, weight, emotional_score) VALUES (?, ?, 1.0, 0.0)'
      ).bind(parsed.type || 'fact', parsed.memory).run();
    }
  } catch { /* silent — memory extraction never blocks save */ }
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, data, people_ids = [], original_text = '', existing_id = null } = body;

  if (!type || !data) return err('type and data required');

  let saved;

  // If linking to existing record, just return it (dedup path)
  if (existing_id) {
    // Update weight on existing record
    const table = { task: 'tasks', goal: 'goals', collection: 'collections', person: 'people' }[type];
    if (table) {
      await env.THEO_OS_DB.prepare(
        `UPDATE ${table} SET weight = MIN(weight + 0.25, 10.0) WHERE id = ?`
      ).bind(existing_id).run().catch(() => null);
    }
    saved = { id: existing_id, _linked: true };
  } else {
    // Create new record
    if (type === 'task') {
      const { results } = await env.THEO_OS_DB.prepare(
        `INSERT INTO tasks (title, area, due_date, notes, status, weight) VALUES (?, ?, ?, ?, 'inbox', 1.0) RETURNING *`
      ).bind(data.title, data.area || 'life', data.due_date || null, data.notes || null).all();
      saved = results[0];
    } else if (type === 'goal') {
      const { results } = await env.THEO_OS_DB.prepare(
        `INSERT INTO goals (title, area, description, target_date, weight) VALUES (?, ?, ?, ?, 1.0) RETURNING *`
      ).bind(data.title, data.area, data.description || null, data.target_date || null).all();
      saved = results[0];
    } else if (type === 'person') {
      const { results } = await env.THEO_OS_DB.prepare(
        `INSERT INTO people (name, relationship, notes, next_touchpoint, weight, aliases) VALUES (?, ?, ?, ?, 1.0, '[]') RETURNING *`
      ).bind(data.name, data.relationship || null, data.notes || null, data.next_touchpoint || null).all();
      saved = results[0];
    } else if (type === 'collection') {
      const { results } = await env.THEO_OS_DB.prepare(
        `INSERT INTO collections (type, title, notes, source, weight) VALUES (?, ?, ?, ?, 1.0) RETURNING *`
      ).bind(data.type, data.title, data.notes || null, data.source || null).all();
      saved = results[0];
    } else if (type === 'journal') {
      const { results } = await env.THEO_OS_DB.prepare(
        `INSERT INTO journal (content, tags) VALUES (?, ?) RETURNING *`
      ).bind(data.content, data.tags || null).all();
      saved = results[0];
    } else {
      return err(`Unknown type: ${type}`, 400);
    }
  }

  // Create connections to linked people
  const fromType = type === 'collection' ? 'collection' : type;
  for (const pid of people_ids) {
    await env.THEO_OS_DB.prepare(
      `INSERT OR IGNORE INTO connections (from_type, from_id, to_type, to_id, strength) VALUES (?, ?, 'person', ?, 1.0)`
    ).bind(fromType, saved.id, pid).run().catch(() => null);
  }

  // Spreading activation
  await spreadActivation(env, fromType, saved.id, people_ids);

  // Get people names for memory extraction context
  let peopleNames = [];
  if (people_ids.length) {
    const { results } = await env.THEO_OS_DB.prepare(
      `SELECT name FROM people WHERE id IN (${people_ids.join(',')})`
    ).all();
    peopleNames = results.map(r => r.name);
  }

  // Fire background memory extraction (don't await)
  extractMemory(env, type, data, original_text, peopleNames).catch(() => null);

  return json({ type, saved, confirmation: `${type} saved` });
}
```

**Step 2: Commit**

```bash
git add functions/api/theo-os/capture/save.js
git commit -m "feat: capture save endpoint — connections, spreading activation, background memory extraction"
```

---

### Task 7: People Alias Management Endpoint

Allow adding aliases to a person from the admin UI. Simple PUT endpoint.

**Files:**
- Create: `functions/api/theo-os/people/[id]/aliases.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../../../_utils.js';

export async function onRequestPut({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const id = Number(params.id);
  const { aliases } = await request.json().catch(() => ({}));
  if (!Array.isArray(aliases)) return err('aliases must be an array');

  await env.THEO_OS_DB.prepare(
    'UPDATE people SET aliases = ? WHERE id = ?'
  ).bind(JSON.stringify(aliases), id).run();

  return json({ ok: true, aliases });
}

export async function onRequestGet({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const id = Number(params.id);
  const person = await env.THEO_OS_DB.prepare(
    'SELECT id, name, aliases FROM people WHERE id = ?'
  ).bind(id).first();
  if (!person) return err('Not found', 404);
  return json({ id: person.id, name: person.name, aliases: JSON.parse(person.aliases || '[]') });
}
```

**Step 2: Commit**

```bash
git add "functions/api/theo-os/people/[id]/aliases.js"
git commit -m "feat: people aliases GET/PUT endpoint for alias management"
```

---

### Task 8: Frontend — Capture State Machine

Replace capture.html's single-step submit with a multi-stage state machine: route → clarify? → dedup? → enrich → preview → save → done.

**Files:**
- Modify: `admin/capture.html`
- Read the full file first

**Step 1: Read the current capture.html**

Read `admin/capture.html` in full before making any changes.

**Step 2: Replace the script logic and add preview card HTML**

Add these styles to the `<style>` block:

```css
.capture-stage { display: none; }
.capture-stage.active { display: block; }

.clarify-question { font-size: 14px; color: var(--text-secondary); margin: 12px 0 10px; line-height: 1.5; }
.clarify-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.chip { padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border-subtle); background: var(--void-elevated); font-size: 13px; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; }
.chip:hover, .chip.selected { border-color: var(--teal); color: var(--teal); background: var(--teal-subtle); }

.preview-card { background: var(--void-elevated); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 20px; margin-top: 12px; }
.preview-type { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--teal); margin-bottom: 8px; }
.preview-title { font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.preview-notes { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 12px; }
.preview-meta { font-size: 12px; color: var(--text-tertiary); margin-bottom: 12px; }
.preview-people { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.person-chip { display: flex; align-items: center; gap: 5px; padding: 4px 10px; background: var(--teal-subtle); border-radius: 12px; font-size: 12px; color: var(--teal); }

.dedup-banner { background: var(--void-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 14px 16px; margin-top: 12px; font-size: 13px; color: var(--text-secondary); }
.dedup-banner strong { color: var(--text-primary); }
.dedup-actions { display: flex; gap: 8px; margin-top: 10px; }

.stage-hint { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); margin-top: 10px; }
.btn-edit-preview { background: none; border: 1px solid var(--border-subtle); color: var(--text-secondary); padding: 7px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.btn-edit-preview:hover { border-color: var(--border-subtle); color: var(--text-primary); }
```

Add this HTML structure inside the main capture card, replacing the current submit button area:

```html
<!-- Stage: input -->
<div class="capture-stage active" id="stage-input">
  <textarea id="capture-text" rows="3" 
    placeholder="Capture anything — task, goal, idea, person, reminder, movie to watch..."
    style="width:100%;background:transparent;border:none;font-size:16px;color:var(--text-primary);resize:none;outline:none;font-family:var(--font-body);line-height:1.6"></textarea>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
    <span class="stage-hint">↵ to capture · Esc to clear</span>
    <button id="capture-btn" class="add-btn">Capture</button>
  </div>
</div>

<!-- Stage: clarify -->
<div class="capture-stage" id="stage-clarify">
  <div id="clarify-original" style="font-size:14px;color:var(--text-secondary);margin-bottom:12px"></div>
  <div class="clarify-question" id="clarify-question"></div>
  <div class="clarify-chips" id="clarify-chips"></div>
  <div style="display:flex;gap:8px;margin-top:4px">
    <button class="btn-sm btn-ghost" onclick="resetCapture()">Cancel</button>
    <button class="btn-sm btn-primary" id="clarify-submit-btn">Submit</button>
  </div>
</div>

<!-- Stage: dedup -->
<div class="capture-stage" id="stage-dedup">
  <div class="dedup-banner">
    Looks similar to: <strong id="dedup-label"></strong>
    <div class="dedup-actions">
      <button class="btn-sm btn-ghost" id="dedup-link-btn">Link to existing</button>
      <button class="btn-sm btn-primary" id="dedup-new-btn">Create new</button>
    </div>
  </div>
</div>

<!-- Stage: enriching -->
<div class="capture-stage" id="stage-enriching">
  <div style="display:flex;align-items:center;gap:12px;padding:16px 0;color:var(--text-tertiary);font-size:13px">
    <span id="enriching-label">Looking it up...</span>
  </div>
</div>

<!-- Stage: preview -->
<div class="capture-stage" id="stage-preview">
  <div class="preview-card" id="preview-card"></div>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button class="btn-sm btn-ghost" onclick="resetCapture()">Cancel</button>
    <button class="btn-sm btn-edit-preview" id="preview-edit-btn">Edit</button>
    <button class="btn-sm btn-primary" id="preview-save-btn">Save</button>
  </div>
</div>

<!-- Stage: done -->
<div class="capture-stage" id="stage-done">
  <div style="padding:16px 0;font-size:14px;color:var(--teal)" id="done-msg"></div>
</div>
```

**Step 3: Replace the JavaScript logic**

Replace the existing capture script with the state machine:

```js
let captureState = {
  stage: 'input',
  originalText: '',
  routeResult: null,
  enrichResult: null,
  dedupMatch: null,
  selectedChip: null
};

function setStage(name) {
  captureState.stage = name;
  document.querySelectorAll('.capture-stage').forEach(el => el.classList.remove('active'));
  document.getElementById(`stage-${name}`)?.classList.add('active');
}

function resetCapture() {
  captureState = { stage: 'input', originalText: '', routeResult: null, enrichResult: null, dedupMatch: null, selectedChip: null };
  document.getElementById('capture-text').value = '';
  setStage('input');
  document.getElementById('capture-text').focus();
}

// Route
async function doRoute(text, clarification = null) {
  setStage('enriching');
  document.getElementById('enriching-label').textContent = 'Routing...';
  const result = await apiPost('/api/theo-os/capture', { text, clarification });
  if (!result) { showError('Failed to route — try again'); resetCapture(); return; }
  captureState.routeResult = result;

  if (result.needs_clarification) {
    showClarify(text, result.question, result.answer_chips);
    return;
  }

  // Dedup check for collections/tasks/goals
  if (['collection', 'task', 'goal'].includes(result.type) && result.data?.title) {
    const dedup = await apiPost('/api/theo-os/capture/dedup', {
      type: result.type, title: result.data.title
    });
    if (dedup?.match) {
      captureState.dedupMatch = dedup.match;
      showDedup(dedup.match);
      return;
    }
  }

  await doEnrich();
}

// Clarify
function showClarify(originalText, question, chips) {
  document.getElementById('clarify-original').textContent = `"${originalText}"`;
  document.getElementById('clarify-question').textContent = question;
  const chipsEl = document.getElementById('clarify-chips');
  chipsEl.innerHTML = '';
  (chips || []).forEach(chip => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = chip;
    btn.onclick = () => {
      chipsEl.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      btn.classList.add('selected');
      captureState.selectedChip = chip;
    };
    chipsEl.appendChild(btn);
  });
  setStage('clarify');
}

document.getElementById('clarify-submit-btn').onclick = async () => {
  const clarification = captureState.selectedChip || document.getElementById('clarify-question').textContent;
  await doRoute(captureState.originalText, clarification);
};

// Dedup
function showDedup(match) {
  document.getElementById('dedup-label').textContent = match.label;
  setStage('dedup');
}

document.getElementById('dedup-link-btn').onclick = async () => {
  const r = captureState.routeResult;
  await apiPost('/api/theo-os/capture/save', {
    type: r.type, data: r.data,
    people_ids: r.mentioned_people?.map(p => p.id) || [],
    original_text: captureState.originalText,
    existing_id: captureState.dedupMatch.id
  });
  showDone(`Linked to existing ${r.type}`);
};

document.getElementById('dedup-new-btn').onclick = () => doEnrich();

// Enrich
async function doEnrich() {
  const r = captureState.routeResult;
  setStage('enriching');
  const label = r.type === 'collection' ? `Looking up ${r.data?.title || 'item'}...` : 'Preparing...';
  document.getElementById('enriching-label').textContent = label;

  const result = await apiPost('/api/theo-os/capture/enrich', {
    type: r.type,
    data: r.data,
    mentioned_people: r.mentioned_people || []
  });

  captureState.enrichResult = result || { enriched: r.data, people: [] };
  showPreview();
}

// Preview
function showPreview() {
  const r = captureState.routeResult;
  const e = captureState.enrichResult;
  const enriched = e?.enriched || r.data;
  const people = e?.people || [];

  const typeIcon = { task: '✓', goal: '◎', collection: '✦', journal: '◈', person: '◉' };
  const peopleHtml = people.map(p =>
    `<span class="person-chip">◉ ${p.name}</span>`
  ).join('');

  document.getElementById('preview-card').innerHTML = `
    <div class="preview-type">${typeIcon[r.type] || '·'} ${r.type}${enriched.type ? ` · ${enriched.type}` : ''}</div>
    <div class="preview-title">${enriched.title || enriched.name || enriched.content?.slice(0, 60) || ''}</div>
    ${enriched.notes ? `<div class="preview-notes">${enriched.notes}</div>` : ''}
    ${enriched.release_date ? `<div class="preview-meta">📅 ${enriched.release_date}${enriched.source ? ` · ${enriched.source}` : ''}</div>` : ''}
    ${peopleHtml ? `<div class="preview-people">${peopleHtml}</div>` : ''}
  `;
  setStage('preview');
}

document.getElementById('preview-save-btn').onclick = async () => {
  const r = captureState.routeResult;
  const e = captureState.enrichResult;
  const result = await apiPost('/api/theo-os/capture/save', {
    type: r.type,
    data: e?.enriched || r.data,
    people_ids: (e?.people || r.mentioned_people || []).map(p => p.id).filter(Boolean),
    original_text: captureState.originalText
  });
  if (!result) { showError('Failed to save — try again'); return; }
  showDone(result.confirmation || `${r.type} saved`);
  loadRecent();
};

// Done
function showDone(msg) {
  document.getElementById('done-msg').textContent = `✓ ${msg}`;
  setStage('done');
  setTimeout(resetCapture, 2000);
}

function showError(msg) {
  // Reuse existing error hint element or alert
  alert(msg);
}

// Entry point
document.getElementById('capture-btn').onclick = async () => {
  const text = document.getElementById('capture-text').value.trim();
  if (!text) return;
  captureState.originalText = text;
  await doRoute(text);
};

document.getElementById('capture-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('capture-btn').click();
  }
  if (e.key === 'Escape') resetCapture();
});
```

**Step 4: Remove old capture logic**

Delete any old submit handler, `apiPost` calls in the old script, and the old result display code. The new state machine replaces all of it.

**Step 5: Bump CSS cache-buster**

Change `admin.css?v=5` → `admin.css?v=6` in capture.html only (only this file changed).

**Step 6: Commit**

```bash
git add admin/capture.html
git commit -m "feat: capture state machine — route, clarify, dedup, enrich, preview, save"
```

---

### Task 9: Deploy + Smoke Test

**Step 1: Deploy**

```bash
CLOUDFLARE_API_TOKEN=cfut_0aGGCrkIY2PvElvuhgpxStSPxSaGlahzm4dzex0s78d2ec70 npx wrangler pages deploy . --project-name theo-os
```

**Step 2: Test — basic task capture**

Open capture.html. Type: "submit the chemistry assignment tomorrow"
Expected flow: route (task) → no dedup → enrich skipped → preview shows task card → save → done.

**Step 3: Test — collection with enrichment**

Type: "want to read Atomic Habits"
Expected flow: route (collection/book) → dedup check → enrich (Tavily search fires) → preview shows notes + author info → save → done.

**Step 4: Test — clarification**

Type: "call my dad more"
Expected: clarify stage appears with question chips (task vs goal). Select one, submit → continues pipeline.

**Step 5: Test — person alias**

First add an alias: in People admin, add alias "my girlfriend" to an existing person.
Then capture: "dinner with my girlfriend friday"
Expected: "my girlfriend" resolves to the person's canonical name + ID in routing response.

**Step 6: Test — dedup**

Capture "Atomic Habits" again after step 3.
Expected: dedup stage appears with "Link to existing" option.

**Step 7: Verify connections in D1**

In Cloudflare D1 console:
```sql
SELECT * FROM connections ORDER BY id DESC LIMIT 5;
SELECT * FROM memories ORDER BY id DESC LIMIT 5;
```
Expected: new connection rows from person-linked captures, new memory rows from background extraction.

---

### Task 10: Knowledge Graph Weight Visualization

Update graph.html to size and brighten nodes based on weight. The personal universe visual — high-weight nodes are stars, low-weight are dim peripheral objects.

**Files:**
- Modify: `admin/graph.html`
- Read the full file first to understand current Cytoscape config

**Step 1: Read graph.html**

Read `admin/graph.html` in full, particularly the Cytoscape stylesheet and layout config.

**Step 2: Update node fetch to include weight**

In the graph data fetch, each node should include its `weight` field. Update any SQL queries or API responses that feed the graph to include `weight`.

**Step 3: Update Cytoscape stylesheet**

Replace static node sizing with weight-based sizing and luminosity:

```js
{
  selector: 'node',
  style: {
    'width': 'mapData(weight, 1, 10, 18, 60)',
    'height': 'mapData(weight, 1, 10, 18, 60)',
    'background-color': 'mapData(weight, 1, 10, #1a1a2e, #4ECDC4)',
    'border-width': 'mapData(weight, 1, 10, 1, 3)',
    'border-color': 'mapData(weight, 1, 10, rgba(78,205,196,0.2), rgba(78,205,196,0.9))',
    'label': 'data(label)',
    'color': '#fff',
    'font-size': 'mapData(weight, 1, 10, 9, 13)',
    'text-valign': 'bottom',
    'text-margin-y': '4px',
    'text-outline-width': 2,
    'text-outline-color': '#000'
  }
},
{
  selector: 'edge',
  style: {
    'width': 'mapData(strength, 0, 5, 1, 4)',
    'line-color': 'rgba(78,205,196,0.25)',
    'opacity': 0.6
  }
}
```

**Step 4: Bump cache-buster, commit, deploy**

```bash
git add admin/graph.html
git commit -m "feat: knowledge graph weight-based node sizing and luminosity — star system visual"
git push origin main
```

Then deploy:
```bash
CLOUDFLARE_API_TOKEN=cfut_0aGGCrkIY2PvElvuhgpxStSPxSaGlahzm4dzex0s78d2ec70 npx wrangler pages deploy . --project-name theo-os
```

---

## Completion Checklist

- [ ] Schema migrations run in D1 console (Task 1)
- [ ] `resolveAliases` utility working (Task 2)
- [ ] Capture route returns confidence + people (Task 3)
- [ ] Dedup endpoint matching existing records (Task 4)
- [ ] Enrich endpoint returning personalized digest (Task 5)
- [ ] Save endpoint creating connections + spreading activation (Task 6)
- [ ] Aliases endpoint working (Task 7)
- [ ] Frontend state machine all 6 stages working (Task 8)
- [ ] Full smoke test passed on real device (Task 9)
- [ ] Graph nodes sized by weight (Task 10)
