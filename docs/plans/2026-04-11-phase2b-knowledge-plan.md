# Phase 2b: Knowledge System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a cognitive restoration engine — passive knowledge extraction from chat, SM-2 spaced repetition with Ebbinghaus decay, active depth probing, a voluntary review mode with live web resources digested to Theo's cognitive profile, and full admin UI for managing knowledge notes.

**Architecture:** The `knowledge_notes` D1 table (already exists) is extended with SM-2 fields. Passive extraction runs in `saveMemory()` after every chat. Active probing is added to `buildSystemPrompt()`. A dedicated review API calls Brave Search, fetches the resource, and digests it via Claude using Theo's memory context. Two admin pages: `/admin/knowledge.html` (manage) and `/admin/learn.html` (review/therapeutic mode). Cron adds Ebbinghaus decay recalculation weekly.

**Tech Stack:** Cloudflare Pages Functions (ES modules), D1 SQLite, KV, Anthropic API (claude-haiku-4-5-20251001 for extraction/scoring, claude-sonnet-4-6 for review), Brave Search API, vanilla JS admin pages.

---

## Task 1: Schema migration — add SM-2 fields to knowledge_notes

**Files:**
- Modify: `schema.sql`

**Step 1: Add columns to schema.sql**

In `schema.sql`, find the `knowledge_notes` table definition and add two columns after `next_review TEXT`:

```sql
CREATE TABLE IF NOT EXISTS knowledge_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  area TEXT,
  depth TEXT DEFAULT 'aware',
  last_reviewed TEXT DEFAULT (datetime('now')),
  decay_score REAL DEFAULT 1.0,
  next_review TEXT,
  ease_factor REAL DEFAULT 2.5,
  last_score INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Step 2: Run migration on D1 remote**

```bash
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler d1 execute theo_os_db --remote --command \
"ALTER TABLE knowledge_notes ADD COLUMN ease_factor REAL DEFAULT 2.5; ALTER TABLE knowledge_notes ADD COLUMN last_score INTEGER DEFAULT 0;"
```

Expected: `✅ Successfully executed`

**Step 3: Verify**

```bash
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler d1 execute theo_os_db --remote --command \
"SELECT name FROM pragma_table_info('knowledge_notes') WHERE name IN ('ease_factor','last_score');"
```

Expected: 2 rows.

**Step 4: Commit**

```bash
git add schema.sql
git commit -m "feat: add SM-2 fields to knowledge_notes"
```

---

## Task 2: Knowledge CRUD API

**Files:**
- Create: `functions/api/theo-os/knowledge/index.js`
- Create: `functions/api/theo-os/knowledge/[id].js`

**Step 1: Create `functions/api/theo-os/knowledge/index.js`**

```js
import { json, err, requireAdmin } from '../_utils.js';

const VALID_DEPTHS = ['aware', 'familiar', 'fluent'];
const VALID_AREAS = ['work', 'finances', 'health', 'relationships', 'growth', 'creative', 'exploration', 'life'];

// GET /api/theo-os/knowledge?area=work&depth=aware&max_decay=0.5
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const area = url.searchParams.get('area');
  const depth = url.searchParams.get('depth');
  const maxDecay = parseFloat(url.searchParams.get('max_decay') || '1');
  const due = url.searchParams.get('due'); // 'true' = only notes due for review

  const today = new Date().toISOString().split('T')[0];

  let query = 'SELECT * FROM knowledge_notes WHERE decay_score <= ?';
  const binds = [isNaN(maxDecay) ? 1 : maxDecay];
  if (area) { query += ' AND area = ?'; binds.push(area); }
  if (depth) { query += ' AND depth = ?'; binds.push(depth); }
  if (due === 'true') { query += ' AND (next_review IS NULL OR next_review <= ?)'; binds.push(today); }
  query += ' ORDER BY decay_score ASC, next_review ASC';

  const { results } = await env.THEO_OS_DB.prepare(query).bind(...binds).all();
  return json({ notes: results }, 200, request);
}

// POST /api/theo-os/knowledge
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { title, content, area, depth } = body;
  if (!title || !title.trim()) return err('title is required');
  const d = VALID_DEPTHS.includes(depth) ? depth : 'aware';

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO knowledge_notes (title, content, area, depth, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    RETURNING *
  `).bind(title.trim(), content?.trim() || null, area || null, d).all();

  return json({ note: results[0] }, 201, request);
}
```

**Step 2: Create `functions/api/theo-os/knowledge/[id].js`**

```js
import { json, err, requireAdmin } from '../_utils.js';

// PATCH /api/theo-os/knowledge/[id]
export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const sets = [];
  const binds = [];

  if (body.title !== undefined) { sets.push('title = ?'); binds.push(String(body.title).trim()); }
  if (body.content !== undefined) { sets.push('content = ?'); binds.push(body.content || null); }
  if (body.area !== undefined) { sets.push('area = ?'); binds.push(body.area || null); }
  if (body.depth !== undefined && ['aware','familiar','fluent'].includes(body.depth)) {
    sets.push('depth = ?'); binds.push(body.depth);
  }
  if (sets.length === 0) return err('No fields to update');

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const { results } = await env.THEO_OS_DB.prepare(
    `UPDATE knowledge_notes SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...binds).all();

  if (!results[0]) return err('Not found', 404);
  return json({ note: results[0] }, 200, request);
}

// DELETE /api/theo-os/knowledge/[id]
export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  await env.THEO_OS_DB.prepare('DELETE FROM knowledge_notes WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, request);
}
```

**Step 3: Deploy and test**

```bash
cd /Users/theodoreaddo/theoaddo.com && \
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler pages deploy . --project-name theo-os --commit-dirty=true --branch=main
```

Then test:
```bash
TOKEN=$(curl -s -X POST https://theo-os.pages.dev/api/theo-os/auth/login \
  -H "Content-Type: application/json" -d '{"password":"8140"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl -s -X POST https://theo-os.pages.dev/api/theo-os/knowledge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Basal ganglia and habit formation","area":"health","depth":"aware","content":"The basal ganglia encode habitual behaviors through dopaminergic reward loops."}' | python3 -m json.tool

curl -s "https://theo-os.pages.dev/api/theo-os/knowledge" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: note created and returned in list.

**Step 4: Commit**

```bash
git add functions/api/theo-os/knowledge/
git commit -m "feat: knowledge notes CRUD API"
```

---

## Task 3: Knowledge Review API — search, fetch, digest, score

**Files:**
- Create: `functions/api/theo-os/knowledge/[id]/review.js`
- Create: `functions/api/theo-os/knowledge/[id]/score.js`

**Step 1: Create `functions/api/theo-os/knowledge/[id]/review.js`**

This is the core of the therapeutic environment. It generates a Socratic prompt, searches for the best resource, fetches and digests it tailored to Theo's cognitive profile.

```js
import { json, err, requireAdmin, loadMemoryContext } from '../../_utils.js';

// POST /api/theo-os/knowledge/[id]/review
export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  const note = await env.THEO_OS_DB.prepare(
    'SELECT * FROM knowledge_notes WHERE id = ?'
  ).bind(id).first();
  if (!note) return err('Not found', 404);

  const memory = await loadMemoryContext(env);

  // Step 1: Generate Socratic prompt
  const promptRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Generate one Socratic question to test deep understanding of: "${note.title}"
Current depth: ${note.depth}. Area: ${note.area || 'general'}.
What Theo knows: ${memory.facts}
His learning patterns: ${memory.patterns}

Rules:
- Do NOT ask "what is X" — ask something that requires applying, explaining to someone else, or connecting to something else
- Match the question to current depth: aware=recall+explain, familiar=apply+connect, fluent=critique+extend
- One question only, no preamble

Return just the question.`
      }]
    })
  });

  let socraticPrompt = `How would you explain ${note.title} to someone encountering it for the first time?`;
  if (promptRes.ok) {
    const pd = await promptRes.json();
    socraticPrompt = pd.content?.[0]?.text?.trim() || socraticPrompt;
  }

  // Step 2: Search for best resource
  let resources = [];
  let digest = null;

  if (env.BRAVE_SEARCH_API_KEY) {
    const query = `${note.title} ${note.area || ''} learn explained`.trim();
    const searchRes = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
      { headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY, 'Accept': 'application/json' } }
    ).catch(() => null);

    if (searchRes?.ok) {
      const searchData = await searchRes.json();
      resources = (searchData.web?.results || []).slice(0, 3).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description || ''
      }));
    }

    // Step 3: Fetch and digest top resource
    if (resources.length > 0) {
      const pageRes = await fetch(resources[0].url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheoOS/1.0)' }
      }).catch(() => null);

      if (pageRes?.ok) {
        const html = await pageRes.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 5000);

        if (text.length > 200) {
          const digestRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 600,
              messages: [{
                role: 'user',
                content: `You are helping Theo learn "${note.title}". He is a medical student at Brown with the following cognitive profile:
- What he knows: ${memory.facts}
- How he learns: ${memory.patterns}
- What works for him: ${memory.preferences}

Digest this resource and re-present the core ideas in a way that matches how he thinks. Use analogies he would find resonant. Connect to what he already knows. Make it engaging, not encyclopedic.

Resource content:
${text}

Write 3-5 short paragraphs. Be direct. No filler. End with one concrete takeaway.`
              }]
            })
          });

          if (digestRes.ok) {
            const dd = await digestRes.json();
            digest = dd.content?.[0]?.text?.trim() || null;
          }
        }
      }
    }
  }

  return json({
    note: { id: note.id, title: note.title, depth: note.depth, decay_score: note.decay_score },
    prompt: socraticPrompt,
    digest,
    resources
  }, 200, request);
}
```

**Step 2: Create `functions/api/theo-os/knowledge/[id]/score.js`**

This endpoint receives Theo's response to the Socratic prompt, scores it with Haiku, and applies SM-2 to update the note.

```js
import { json, err, requireAdmin } from '../../_utils.js';

const DEPTH_ORDER = ['aware', 'familiar', 'fluent'];

function applySpacedRepetition(note, score) {
  let { ease_factor, depth, next_review, last_reviewed } = note;
  ease_factor = parseFloat(ease_factor) || 2.5;

  // Calculate previous interval in days
  const BASE_INTERVALS = { aware: 3, familiar: 7, fluent: 21 };
  let prevInterval = BASE_INTERVALS[depth] || 3;
  if (next_review && last_reviewed) {
    const diff = (new Date(next_review) - new Date(last_reviewed.replace(' ', 'T') + 'Z')) / 86400000;
    if (diff > 0) prevInterval = Math.round(diff);
  }

  let newInterval, newEase, newDepth = depth;
  const depthIdx = DEPTH_ORDER.indexOf(depth);

  if (score >= 4) {
    newEase = Math.min(3.5, ease_factor + 0.1);
    newInterval = Math.round(prevInterval * newEase);
    if (score === 5 && depthIdx < 2) newDepth = DEPTH_ORDER[depthIdx + 1]; // advance depth
  } else if (score === 3) {
    newEase = ease_factor;
    newInterval = Math.max(1, Math.round(prevInterval * 1.2));
  } else {
    newEase = Math.max(1.3, ease_factor - 0.2);
    newInterval = 1;
    if (score === 1 && depthIdx > 0) newDepth = DEPTH_ORDER[depthIdx - 1]; // regress depth
  }

  const nextReviewDate = new Date(Date.now() + newInterval * 86400000).toISOString().split('T')[0];
  return { newInterval, newEase, newDepth, nextReviewDate };
}

// POST /api/theo-os/knowledge/[id]/score
export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { response, prompt } = body;
  if (!response || !response.trim()) return err('response is required');

  const note = await env.THEO_OS_DB.prepare('SELECT * FROM knowledge_notes WHERE id = ?').bind(id).first();
  if (!note) return err('Not found', 404);

  // Score the response with Haiku
  let score = 3; // default to partial if scoring fails
  const scoreRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Score this recall response on a 1-5 scale. Return only a JSON object: {"score": N}

Topic: ${note.title}
Question: ${prompt || '(not provided)'}
Response: ${response.trim().slice(0, 500)}

Scoring:
1 = blank, wrong, or "I don't know"
2 = recognized topic but couldn't explain
3 = got the gist, missed key details
4 = accurate and reasonably complete
5 = accurate, connected to other concepts, applied it or extended it`
      }]
    })
  }).catch(() => null);

  if (scoreRes?.ok) {
    const sd = await scoreRes.json();
    const raw = sd.content?.[0]?.text;
    try {
      const parsed = JSON.parse(raw?.match(/\{[\s\S]*\}/)?.[0] || raw);
      const s = parseInt(parsed.score);
      if (s >= 1 && s <= 5) score = s;
    } catch (_) {}
  }

  const { newInterval, newEase, newDepth, nextReviewDate } = applySpacedRepetition(note, score);

  // Recalculate decay score (reset to 1.0 on review)
  await env.THEO_OS_DB.prepare(`
    UPDATE knowledge_notes
    SET last_score = ?, ease_factor = ?, depth = ?, next_review = ?,
        last_reviewed = datetime('now'), decay_score = 1.0,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(score, newEase, newDepth, nextReviewDate, id).run();

  const updated = await env.THEO_OS_DB.prepare('SELECT * FROM knowledge_notes WHERE id = ?').bind(id).first();

  return json({
    score,
    new_depth: newDepth,
    next_review: nextReviewDate,
    interval_days: newInterval,
    note: updated
  }, 200, request);
}
```

**Step 3: Deploy and test**

Deploy, then test the review endpoint:
```bash
# Get a note ID first
NOTE_ID=$(curl -s "https://theo-os.pages.dev/api/theo-os/knowledge" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['notes'][0]['id'])")

# NOTE: This requires BRAVE_SEARCH_API_KEY to be set — skip for now, just confirm the endpoint works
curl -s -X POST "https://theo-os.pages.dev/api/theo-os/knowledge/${NOTE_ID}/review" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

Expected: `{ prompt: "...", digest: null (until BRAVE key set), resources: [] }`

Test scoring:
```bash
curl -s -X POST "https://theo-os.pages.dev/api/theo-os/knowledge/${NOTE_ID}/score" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"response":"The basal ganglia encode habitual behaviors through dopaminergic feedback loops in the striatum, forming a stimulus-response chain that becomes automatic over time.","prompt":"How does the brain encode a habit?"}' | python3 -m json.tool
```

Expected: `{ score: 4-5, new_depth: "familiar", next_review: "...", interval_days: N }`

**Step 4: Commit**

```bash
git add functions/api/theo-os/knowledge/
git commit -m "feat: knowledge review and SM-2 scoring API"
```

---

## Task 4: Set BRAVE_SEARCH_API_KEY secret

**Step 1: Get a Brave Search API key**

Go to https://brave.com/search/api/ and sign up for the free tier (2000 queries/month). Copy the API key.

**Step 2: Set the secret on Cloudflare Pages**

```bash
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler pages secret put BRAVE_SEARCH_API_KEY --project-name theo-os
```

Paste the key when prompted.

**Step 3: Verify the review endpoint now returns resources**

```bash
curl -s -X POST "https://theo-os.pages.dev/api/theo-os/knowledge/${NOTE_ID}/review" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

Expected: `resources` array has 3 entries with title and url; `digest` is a non-null string.

**No commit needed for this task** (secret is stored in Cloudflare, not the repo).

---

## Task 5: Passive knowledge extraction in saveMemory

**Files:**
- Modify: `functions/api/theo-os/chat/message.js`

**Step 1: Read the current saveMemory function**

Read the file. Find the `saveMemory` function. After the memories upsert loop (the section that handles `parsed.memories`), add knowledge extraction.

**Step 2: Add knowledge extraction to saveMemory**

After the memories upsert loop, before the closing `} catch (_) {}`, add:

```js
    // Extract knowledge signals
    if (parsed.knowledge && Array.isArray(parsed.knowledge)) {
      for (const kn of parsed.knowledge.slice(0, 2)) {
        if (!kn.title) continue;
        // Check for existing note
        const existing = await env.THEO_OS_DB.prepare(
          `SELECT id, last_reviewed FROM knowledge_notes WHERE title LIKE ? LIMIT 1`
        ).bind(`%${kn.title.slice(0, 30)}%`).first();

        if (existing) {
          // Soft update: mark as recently seen (score 3 = partial engagement)
          await env.THEO_OS_DB.prepare(`
            UPDATE knowledge_notes
            SET last_reviewed = datetime('now'), last_score = 3,
                decay_score = MIN(1.0, decay_score + 0.2), updated_at = datetime('now')
            WHERE id = ?
          `).bind(existing.id).run();
        } else if (kn.create) {
          // Create new note at 'aware' depth
          await env.THEO_OS_DB.prepare(`
            INSERT INTO knowledge_notes (title, content, area, depth, updated_at)
            VALUES (?, ?, ?, 'aware', datetime('now'))
          `).bind(kn.title.trim(), kn.content?.trim() || null, kn.area || null).run();
        }
      }
    }
```

**Step 3: Update the Haiku extraction prompt to include knowledge field**

In the same `saveMemory` function, find the Haiku prompt string and update it to include a `knowledge` field:

Replace the content string with:

```js
          content: `Analyze this exchange and extract memory and knowledge signals. Return JSON only, no markdown.

{
  "summary": "1-2 sentences about what this exchange reveals about how Theo thinks",
  "memories": [
    {
      "type": "fact|pattern|preference",
      "content": "specific, concrete memory string under 100 chars",
      "confidence": 0.6-0.9,
      "area": "work|finances|health|relationships|growth|creative|exploration|life|null"
    }
  ],
  "knowledge": [
    {
      "title": "specific topic name (e.g. 'Ebbinghaus forgetting curve')",
      "area": "work|health|growth|null",
      "content": "one sentence summary of what was discussed",
      "create": true
    }
  ]
}

Rules for memories:
- fact: something explicitly stated as true about Theo's life/situation
- pattern: a behavioral tendency observable from this exchange
- preference: how Theo likes to work or be spoken to
- Extract 0-3 memories only. confidence 0.6 = first time seen, 0.9 = very explicit.

Rules for knowledge:
- Only extract if a specific learnable topic was meaningfully discussed
- set create=true only if this is a genuinely new topic worth tracking
- set create=false if just mentioning a topic in passing
- Extract 0-2 knowledge signals only

Exchange:
User: ${userMessage}
Assistant: ${assistantMessage}`
```

**Step 4: Commit**

```bash
git add functions/api/theo-os/chat/message.js
git commit -m "feat: passive knowledge extraction from chat"
```

---

## Task 6: Active knowledge probing in buildSystemPrompt + system prompt injection

**Files:**
- Modify: `functions/api/theo-os/chat/message.js`

**Step 1: Read the buildSystemPrompt function**

Read message.js. Find `buildSystemPrompt`. It currently loads memories, insights, and chat_memory. We add two things: (1) inject due knowledge notes into the system prompt so the Secretary knows what to probe; (2) add a probing instruction when notes are due.

**Step 2: Add knowledge loading block**

After the memories loading block (the try/catch that builds `memory_facts`, `memory_patterns`, `memory_preferences`), add:

```js
  // Load knowledge notes due for review (overdue or low decay)
  let knowledge_due = '';
  let knowledge_strong = '';
  try {
    const today = new Date().toISOString().split('T')[0];
    const { results: dueNotes } = await env.THEO_OS_DB.prepare(
      `SELECT title, depth, area FROM knowledge_notes
       WHERE next_review IS NULL OR next_review <= ? OR decay_score < 0.4
       ORDER BY decay_score ASC LIMIT 5`
    ).bind(today).all();
    const { results: strongNotes } = await env.THEO_OS_DB.prepare(
      `SELECT title FROM knowledge_notes WHERE decay_score >= 0.7 AND depth = 'fluent' LIMIT 10`
    ).bind().all();
    knowledge_due = dueNotes.map(n => `- ${n.title} [${n.depth}, ${n.area || 'general'}]`).join('\n');
    knowledge_strong = strongNotes.map(n => n.title).join(', ');
  } catch (_) {}
```

**Step 3: Add knowledge sections to the system prompt return string**

In the `return \`...\`` at the end of `buildSystemPrompt`, add two new sections after "How he likes to work":

```js
Knowledge due for review (probe naturally when topics arise):
${knowledge_due || 'None due.'}

Topics Theo knows well (don't over-explain these):
${knowledge_strong || 'None tracked yet.'}
```

The full updated return should include these sections before "Life context:".

**Step 4: Add active probing instruction to the Rules section**

In the same return string, in the Rules list, add:

```
- When a topic from "Knowledge due for review" comes up naturally, ask a probing question that requires explanation or application — never "do you know X", always a question that reveals depth.
```

**Step 5: Commit (no deploy — deploy alongside Task 7)**

```bash
git add functions/api/theo-os/chat/message.js
git commit -m "feat: active knowledge probing in Secretary system prompt"
```

---

## Task 7: Knowledge-aware briefing + weekly review + deploy

**Files:**
- Modify: `functions/api/theo-os/briefing.js`
- Modify: `functions/api/theo-os/review/start.js`

**Step 1: Update briefing.js to surface due knowledge notes**

In `briefing.js`, after the existing DB queries (overdue tasks, due today, upcoming goals, overdue people), add:

```js
  const dueKnowledge = await env.THEO_OS_DB.prepare(
    `SELECT title, depth, area FROM knowledge_notes
     WHERE (next_review IS NULL OR next_review <= ?) AND decay_score < 0.5
     ORDER BY decay_score ASC LIMIT 3`
  ).bind(today).all().catch(() => ({ results: [] }));
```

In the briefing prompt string, add a knowledge section to the context:

```js
- Knowledge due for review: ${dueKnowledge.results.length > 0 ? dueKnowledge.results.map(n => n.title).join(', ') : 'none'}
```

Add to the prompt instructions: "If there are knowledge items due, mention them briefly. Frame as cognitive maintenance, not a task."

**Step 2: Update review/start.js to include a knowledge check step**

Read `functions/api/theo-os/review/start.js`. Find where the system prompt is built. Add to it:

```js
const dueKnowledge = await env.THEO_OS_DB.prepare(
  `SELECT title, depth, area FROM knowledge_notes
   WHERE (next_review IS NULL OR next_review <= ?) AND decay_score < 0.5
   ORDER BY decay_score ASC LIMIT 3`
).bind(today).all().catch(() => ({ results: [] }));

const knowledgeDue = dueKnowledge.results.map(n => `${n.title} [${n.depth}]`).join(', ') || 'none';
```

Add to the system prompt string:

```
Knowledge areas with faded retention: ${knowledgeDue}
Include a brief knowledge check in the review if any are listed. Ask one application question per area.
```

**Step 3: Deploy**

```bash
cd /Users/theodoreaddo/theoaddo.com && \
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler pages deploy . --project-name theo-os --commit-dirty=true --branch=main
```

**Step 4: Commit**

```bash
git add functions/api/theo-os/briefing.js functions/api/theo-os/review/start.js
git commit -m "feat: knowledge-aware briefing and weekly review"
```

---

## Task 8: Cron — Ebbinghaus decay recalculation

**Files:**
- Modify: `cron-worker.js`

**Step 1: Read cron-worker.js**

Read the file. Find `consolidateMemories` and the `scheduled` handler.

**Step 2: Add consolidateKnowledge function**

Add this function after `consolidateMemories`:

```js
async function consolidateKnowledge(env) {
  // Fetch all active knowledge notes
  const { results: notes } = await env.THEO_OS_DB.prepare(
    `SELECT id, depth, last_reviewed FROM knowledge_notes`
  ).all();

  const DECAY_CONSTANTS = { aware: 0.14, familiar: 0.05, fluent: 0.02 };
  const now = Date.now();

  for (const note of notes) {
    const k = DECAY_CONSTANTS[note.depth] || 0.14;
    const lastMs = note.last_reviewed
      ? new Date(note.last_reviewed.replace(' ', 'T') + 'Z').getTime()
      : now - 7 * 86400000; // default: 7 days ago if never reviewed
    const daysSince = Math.max(0, (now - lastMs) / 86400000);
    const decayScore = Math.round(Math.exp(-k * daysSince) * 100) / 100;

    await env.THEO_OS_DB.prepare(
      `UPDATE knowledge_notes SET decay_score = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(decayScore, note.id).run();
  }

  // Set next_review for notes that don't have one (newly created)
  await env.THEO_OS_DB.prepare(`
    UPDATE knowledge_notes
    SET next_review = date('now', '+3 days'), updated_at = datetime('now')
    WHERE next_review IS NULL
  `).run();
}
```

**Step 3: Call it in the scheduled handler**

Find the Sunday cron block and add `consolidateKnowledge`:

```js
  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 * * *') ctx.waitUntil(runMorningBriefing(env));
    else if (event.cron === '0 10 * * 7') {
      ctx.waitUntil(runWeeklyInsights(env));
      ctx.waitUntil(consolidateMemories(env));
      ctx.waitUntil(consolidateKnowledge(env));
    }
  }
```

**Step 4: Redeploy cron worker**

```bash
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler deploy cron-worker.js --config wrangler-cron.toml
```

Expected: `Deployed theo-os-cron triggers`

**Step 5: Commit**

```bash
git add cron-worker.js
git commit -m "feat: Ebbinghaus decay recalculation in weekly cron"
```

---

## Task 9: /admin/knowledge.html — Knowledge management page

**Files:**
- Create: `admin/knowledge.html`

**Step 1: Read admin/model.html for the exact head/nav pattern**

Read `/Users/theodoreaddo/theoaddo.com/admin/model.html` lines 1-55 to confirm the exact head structure (Google fonts link, theme detection script, admin.css link) and nav HTML pattern (sidebar-logo, sidebar-label, sidebar-link classes).

**Step 2: Create admin/knowledge.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Theo OS — Knowledge</title>
  <link rel="icon" href="/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/css/admin.css">
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('theo_os_theme') || 'dark')</script>
  <style>
    .kn-table { width: 100%; border-collapse: collapse; }
    .kn-table th { font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); padding: 6px 12px; text-align: left; border-bottom: 1px solid var(--border-ghost); }
    .kn-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-ghost); font-size: 13px; vertical-align: middle; }
    .kn-table tr:hover td { background: var(--void-elevated); }
    .depth-badge { display: inline-block; font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 10px; }
    .depth-aware { background: rgba(255,107,107,0.15); color: var(--coral); }
    .depth-familiar { background: rgba(245,200,66,0.15); color: #f5c842; }
    .depth-fluent { background: rgba(0,212,180,0.15); color: var(--teal); }
    .decay-bar { width: 80px; height: 4px; background: var(--border-ghost); border-radius: 2px; display: inline-block; vertical-align: middle; }
    .decay-fill { height: 100%; border-radius: 2px; background: var(--teal); }
    .decay-fill.mid { background: #f5c842; }
    .decay-fill.low { background: var(--coral); }
    .add-form { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
    .add-form input, .add-form select { background: var(--void-elevated); border: 1px solid var(--border-ghost); border-radius: 6px; padding: 7px 10px; font-size: 12px; color: var(--text-primary); font-family: var(--font-body); }
    .add-form input:focus, .add-form select:focus { outline: none; border-color: var(--teal); }
    .add-form input[name="title"] { flex: 1; min-width: 200px; }
    .btn-add { background: none; border: 1px solid var(--teal); border-radius: 6px; padding: 7px 16px; font-size: 11px; font-family: var(--font-mono); color: var(--teal); cursor: pointer; white-space: nowrap; }
    .btn-add:hover { background: var(--teal-subtle); }
    .kn-action { background: none; border: none; font-size: 11px; font-family: var(--font-mono); cursor: pointer; padding: 2px 6px; color: var(--text-tertiary); }
    .kn-action:hover { color: var(--teal); }
    .kn-action.danger:hover { color: var(--coral); }
    .review-now { color: var(--teal); border: 1px solid var(--border-ghost); border-radius: 4px; padding: 2px 8px; font-size: 10px; font-family: var(--font-mono); background: none; cursor: pointer; }
    .review-now:hover { background: var(--teal-subtle); }
  </style>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar">
    <div class="sidebar-header"><span class="sidebar-logo">THEO OS</span></div>
    <div class="nav-section">
      <div class="nav-label">OVERVIEW</div>
      <a href="/admin/dashboard.html" class="nav-item">Dashboard</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">INTELLIGENCE</div>
      <a href="/admin/chat.html" class="nav-item">Chat</a>
      <a href="/admin/model.html" class="nav-item">The Theo Model</a>
      <a href="/admin/knowledge.html" class="nav-item active">Knowledge</a>
      <a href="/admin/learn.html" class="nav-item">Learn</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">LIFE</div>
      <a href="/admin/tasks.html" class="nav-item">Tasks</a>
      <a href="/admin/goals.html" class="nav-item">Goals</a>
      <a href="/admin/people.html" class="nav-item">People</a>
      <a href="/admin/journal.html" class="nav-item">Journal</a>
      <a href="/admin/collections.html" class="nav-item">Collections</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">TOOLS</div>
      <a href="/admin/email.html" class="nav-item">Email</a>
      <a href="/admin/vision.html" class="nav-item">Vision</a>
      <a href="/admin/review.html" class="nav-item">Review</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">ACCOUNT</div>
      <button class="nav-item" id="theme-toggle" style="background:none;border:none;cursor:pointer;text-align:left;width:100%;padding:6px 12px;font:inherit">☀ Light</button>
      <a href="#" class="nav-item" id="logout-btn">Sign out</a>
    </div>
  </nav>
  <main class="main-content">
    <div class="page-header">
      <h1 class="page-title">Knowledge</h1>
      <p class="page-subtitle">What you know, how well you know it, and when it needs reinforcement.</p>
    </div>
    <div class="add-form">
      <input name="title" placeholder="Add topic (e.g. Basal ganglia and habit formation)" autocomplete="off">
      <select name="area">
        <option value="">Area</option>
        <option value="work">Work</option>
        <option value="health">Health</option>
        <option value="growth">Growth</option>
        <option value="relationships">Relationships</option>
        <option value="finances">Finances</option>
        <option value="creative">Creative</option>
        <option value="exploration">Exploration</option>
        <option value="life">Life</option>
      </select>
      <select name="depth">
        <option value="aware">Aware</option>
        <option value="familiar">Familiar</option>
        <option value="fluent">Fluent</option>
      </select>
      <button class="btn-add" id="add-btn">+ Add</button>
    </div>
    <table class="kn-table">
      <thead>
        <tr>
          <th>Topic</th>
          <th>Area</th>
          <th>Depth</th>
          <th>Retention</th>
          <th>Next Review</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="kn-tbody"></tbody>
    </table>
  </main>
</div>

<script src="/admin/js/auth.js"></script>
<script>
  requireAuth();

  document.getElementById('logout-btn').addEventListener('click', e => {
    e.preventDefault(); clearToken(); window.location.href = '/admin/index.html';
  });

  const themeToggle = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('theo_os_theme') || 'dark';
  if (saved === 'light') { document.documentElement.setAttribute('data-theme', 'light'); themeToggle.textContent = '☽ Dark'; }
  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theo_os_theme', next);
    themeToggle.textContent = next === 'light' ? '☽ Dark' : '☀ Light';
  });

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function decayColor(d) {
    if (d >= 0.7) return '';
    if (d >= 0.4) return 'mid';
    return 'low';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async function load() {
    const data = await apiGet('/api/theo-os/knowledge');
    const notes = data?.notes || [];
    const tbody = document.getElementById('kn-tbody');
    tbody.innerHTML = notes.map(n => `
      <tr data-id="${n.id}">
        <td>${esc(n.title)}</td>
        <td style="color:var(--text-secondary)">${esc(n.area || '—')}</td>
        <td><span class="depth-badge depth-${n.depth}">${n.depth}</span></td>
        <td>
          <span class="decay-bar"><span class="decay-fill ${decayColor(n.decay_score)}" style="width:${Math.round(n.decay_score*100)}%"></span></span>
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary);margin-left:6px">${Math.round(n.decay_score*100)}%</span>
        </td>
        <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">${fmtDate(n.next_review)}</td>
        <td style="display:flex;gap:6px;align-items:center">
          <button class="review-now" onclick="goReview(${n.id})">Review</button>
          <button class="kn-action danger" onclick="del(${n.id})">Delete</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="color:var(--text-tertiary);text-align:center;padding:32px">No knowledge notes yet.</td></tr>';
  }

  function goReview(id) {
    window.location.href = `/admin/learn.html?id=${id}`;
  }

  async function del(id) {
    if (!confirm('Delete this knowledge note?')) return;
    await apiFetch(`/api/theo-os/knowledge/${id}`, { method: 'DELETE' });
    load();
  }

  document.getElementById('add-btn').addEventListener('click', async () => {
    const title = document.querySelector('input[name="title"]').value.trim();
    const area = document.querySelector('select[name="area"]').value;
    const depth = document.querySelector('select[name="depth"]').value;
    if (!title) return;
    await apiPost('/api/theo-os/knowledge', { title, area, depth });
    document.querySelector('input[name="title"]').value = '';
    load();
  });

  load();
</script>
</body>
</html>
```

**Step 3: Commit**

```bash
git add admin/knowledge.html
git commit -m "feat: knowledge management admin page"
```

---

## Task 10: /admin/learn.html — The therapeutic review environment

**Files:**
- Create: `admin/learn.html`

**Step 1: Create admin/learn.html**

This is the primary review experience. When opened without a `?id=` param, shows all due/weak notes. When opened with `?id=N`, immediately starts a review session for that note.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Theo OS — Learn</title>
  <link rel="icon" href="/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/css/admin.css">
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('theo_os_theme') || 'dark')</script>
  <style>
    .learn-split { display: grid; grid-template-columns: 280px 1fr; gap: 32px; }
    .learn-list { }
    .learn-item { padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border-ghost); margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
    .learn-item:hover, .learn-item.active { border-color: var(--teal); }
    .learn-item-title { font-size: 13px; color: var(--text-primary); margin-bottom: 4px; }
    .learn-item-meta { display: flex; gap: 8px; align-items: center; }
    .depth-badge { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 6px; border-radius: 8px; }
    .depth-aware { background: rgba(255,107,107,0.15); color: var(--coral); }
    .depth-familiar { background: rgba(245,200,66,0.15); color: #f5c842; }
    .depth-fluent { background: rgba(0,212,180,0.15); color: var(--teal); }
    .decay-mini { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); }
    .session-panel { }
    .session-loading { color: var(--text-tertiary); font-size: 13px; padding: 32px 0; }
    .session-prompt { font-size: 18px; font-weight: 500; color: var(--text-primary); line-height: 1.5; margin-bottom: 24px; padding: 20px 24px; background: var(--void-elevated); border-radius: 10px; border-left: 3px solid var(--teal); }
    .session-digest { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 20px; white-space: pre-wrap; }
    .session-source { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); margin-bottom: 24px; }
    .session-source a { color: var(--teal); text-decoration: none; }
    .session-source a:hover { text-decoration: underline; }
    .session-resources { margin-bottom: 24px; }
    .resource-link { display: block; padding: 8px 12px; background: var(--void-elevated); border: 1px solid var(--border-ghost); border-radius: 6px; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); text-decoration: none; }
    .resource-link:hover { border-color: var(--teal); color: var(--text-primary); }
    .resource-link span { font-family: var(--font-mono); font-size: 9px; color: var(--text-tertiary); display: block; margin-top: 2px; }
    .response-area { width: 100%; min-height: 120px; background: var(--void-elevated); border: 1px solid var(--border-ghost); border-radius: 8px; padding: 12px 14px; font-size: 13px; font-family: var(--font-body); color: var(--text-primary); resize: vertical; box-sizing: border-box; }
    .response-area:focus { outline: none; border-color: var(--teal); }
    .submit-row { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
    .btn-submit { background: var(--teal); border: none; border-radius: 6px; padding: 9px 20px; font-size: 12px; font-family: var(--font-mono); color: #000; cursor: pointer; font-weight: 600; }
    .btn-submit:hover { opacity: 0.9; }
    .btn-skip { background: none; border: 1px solid var(--border-ghost); border-radius: 6px; padding: 9px 16px; font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); cursor: pointer; }
    .score-result { padding: 16px; background: var(--void-elevated); border-radius: 8px; border: 1px solid var(--border-ghost); }
    .score-num { font-family: var(--font-mono); font-size: 32px; font-weight: 600; color: var(--teal); }
    .score-meta { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    @media (max-width: 800px) { .learn-split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar">
    <div class="sidebar-header"><span class="sidebar-logo">THEO OS</span></div>
    <div class="nav-section">
      <div class="nav-label">OVERVIEW</div>
      <a href="/admin/dashboard.html" class="nav-item">Dashboard</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">INTELLIGENCE</div>
      <a href="/admin/chat.html" class="nav-item">Chat</a>
      <a href="/admin/model.html" class="nav-item">The Theo Model</a>
      <a href="/admin/knowledge.html" class="nav-item">Knowledge</a>
      <a href="/admin/learn.html" class="nav-item active">Learn</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">LIFE</div>
      <a href="/admin/tasks.html" class="nav-item">Tasks</a>
      <a href="/admin/goals.html" class="nav-item">Goals</a>
      <a href="/admin/people.html" class="nav-item">People</a>
      <a href="/admin/journal.html" class="nav-item">Journal</a>
      <a href="/admin/collections.html" class="nav-item">Collections</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">TOOLS</div>
      <a href="/admin/email.html" class="nav-item">Email</a>
      <a href="/admin/vision.html" class="nav-item">Vision</a>
      <a href="/admin/review.html" class="nav-item">Review</a>
    </div>
    <div class="nav-section">
      <div class="nav-label">ACCOUNT</div>
      <button class="nav-item" id="theme-toggle" style="background:none;border:none;cursor:pointer;text-align:left;width:100%;padding:6px 12px;font:inherit">☀ Light</button>
      <a href="#" class="nav-item" id="logout-btn">Sign out</a>
    </div>
  </nav>
  <main class="main-content">
    <div class="page-header">
      <h1 class="page-title">Learn</h1>
      <p class="page-subtitle" id="learn-subtitle">Select a topic to review.</p>
    </div>
    <div class="learn-split">
      <div class="learn-list" id="learn-list"></div>
      <div class="session-panel" id="session-panel">
        <p style="color:var(--text-tertiary);font-size:13px">Select a topic from the list to begin a review session.</p>
      </div>
    </div>
  </main>
</div>

<script src="/admin/js/auth.js"></script>
<script>
  requireAuth();

  document.getElementById('logout-btn').addEventListener('click', e => {
    e.preventDefault(); clearToken(); window.location.href = '/admin/index.html';
  });

  const themeToggle = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('theo_os_theme') || 'dark';
  if (saved === 'light') { document.documentElement.setAttribute('data-theme', 'light'); themeToggle.textContent = '☽ Dark'; }
  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theo_os_theme', next);
    themeToggle.textContent = next === 'light' ? '☽ Dark' : '☀ Light';
  });

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  let allNotes = [];
  let activeId = null;
  let activePrompt = null;

  async function load() {
    const data = await apiGet('/api/theo-os/knowledge');
    allNotes = (data?.notes || []).sort((a, b) => a.decay_score - b.decay_score);

    const list = document.getElementById('learn-list');
    list.innerHTML = allNotes.map(n => `
      <div class="learn-item ${n.id === activeId ? 'active' : ''}" data-id="${n.id}">
        <div class="learn-item-title">${esc(n.title)}</div>
        <div class="learn-item-meta">
          <span class="depth-badge depth-${n.depth}">${n.depth}</span>
          <span class="decay-mini">${Math.round(n.decay_score * 100)}% retention</span>
        </div>
      </div>
    `).join('') || '<p style="color:var(--text-tertiary);font-size:13px">No knowledge notes yet. Add topics in the Knowledge page.</p>';

    list.querySelectorAll('.learn-item').forEach(item => {
      item.addEventListener('click', () => startSession(Number(item.dataset.id)));
    });

    // Auto-start if ?id= param present
    const params = new URLSearchParams(location.search);
    const idParam = parseInt(params.get('id'));
    if (idParam && !activeId) startSession(idParam);
  }

  async function startSession(id) {
    activeId = id;
    const panel = document.getElementById('session-panel');
    panel.innerHTML = '<p class="session-loading">Loading review session...</p>';

    // Highlight active item
    document.querySelectorAll('.learn-item').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });

    const data = await apiFetch(`/api/theo-os/knowledge/${id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    }).then(r => r.json()).catch(() => null);

    if (!data) {
      panel.innerHTML = '<p style="color:var(--coral)">Failed to load review session.</p>';
      return;
    }

    activePrompt = data.prompt;
    const note = data.note;

    document.getElementById('learn-subtitle').textContent = `Reviewing: ${note?.title || ''}`;

    const resourcesHtml = (data.resources || []).map(r => `
      <a class="resource-link" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${esc(r.title)}
        <span>${esc(r.url)}</span>
      </a>
    `).join('');

    panel.innerHTML = `
      <div class="session-prompt">${esc(data.prompt)}</div>
      ${data.digest ? `<div class="session-digest">${esc(data.digest)}</div>` : ''}
      ${resourcesHtml ? `<div class="session-resources">${resourcesHtml}</div>` : ''}
      <textarea class="response-area" id="response-input" placeholder="Write your response here..."></textarea>
      <div class="submit-row">
        <button class="btn-submit" id="submit-btn">Submit response</button>
        <button class="btn-skip" id="skip-btn">Skip for now</button>
      </div>
      <div id="score-display"></div>
    `;

    document.getElementById('submit-btn').addEventListener('click', () => submitResponse(id));
    document.getElementById('skip-btn').addEventListener('click', () => {
      document.getElementById('session-panel').innerHTML = '<p style="color:var(--text-tertiary);font-size:13px">Select a topic from the list to begin a review session.</p>';
      document.getElementById('learn-subtitle').textContent = 'Select a topic to review.';
      activeId = null;
    });
  }

  async function submitResponse(id) {
    const response = document.getElementById('response-input')?.value?.trim();
    if (!response) return;

    document.getElementById('submit-btn').disabled = true;
    document.getElementById('submit-btn').textContent = 'Scoring...';

    const result = await apiFetch(`/api/theo-os/knowledge/${id}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, prompt: activePrompt })
    }).then(r => r.json()).catch(() => null);

    if (!result) {
      document.getElementById('score-display').innerHTML = '<p style="color:var(--coral)">Scoring failed.</p>';
      return;
    }

    const depthChanged = result.note?.depth !== allNotes.find(n => n.id === id)?.depth;
    const scoreColors = { 1: 'var(--coral)', 2: 'var(--coral)', 3: '#f5c842', 4: 'var(--teal)', 5: 'var(--teal)' };

    document.getElementById('score-display').innerHTML = `
      <div class="score-result" style="margin-top:16px">
        <div class="score-num" style="color:${scoreColors[result.score] || 'var(--teal)'}">
          ${result.score}/5
        </div>
        <div class="score-meta">
          ${depthChanged ? `Depth updated to <strong>${result.new_depth}</strong>. ` : ''}
          Next review: ${result.next_review} (${result.interval_days} days)
        </div>
      </div>
    `;

    document.getElementById('response-input').disabled = true;
    document.getElementById('submit-btn').style.display = 'none';
    document.getElementById('skip-btn').textContent = 'Next topic';

    // Reload list to reflect updated decay/depth
    activeId = null;
    load();
  }

  load();
</script>
</body>
</html>
```

**Step 3: Commit**

```bash
git add admin/learn.html
git commit -m "feat: Learn page — therapeutic knowledge review environment"
```

---

## Task 11: Add Knowledge and Learn nav links to all admin pages + final deploy

**Files:**
- Modify: `admin/dashboard.html`, `admin/tasks.html`, `admin/goals.html`, `admin/people.html`, `admin/journal.html`, `admin/collections.html`, `admin/email.html`, `admin/vision.html`, `admin/chat.html`, `admin/review.html`, `admin/model.html`

**Step 1: Add nav links to all 11 pages**

In each file, find the INTELLIGENCE nav section (where Chat and The Theo Model links live) and add after The Theo Model:

```html
<a href="/admin/knowledge.html" class="nav-item">Knowledge</a>
<a href="/admin/learn.html" class="nav-item">Learn</a>
```

Use a script to do this efficiently:
```bash
cd /Users/theodoreaddo/theoaddo.com && python3 -c "
import os, re
files = ['admin/dashboard.html','admin/tasks.html','admin/goals.html','admin/people.html',
         'admin/journal.html','admin/collections.html','admin/email.html','admin/vision.html',
         'admin/chat.html','admin/review.html','admin/model.html']
insert = '\n      <a href=\"/admin/knowledge.html\" class=\"nav-item\">Knowledge</a>\n      <a href=\"/admin/learn.html\" class=\"nav-item\">Learn</a>'
for f in files:
    txt = open(f).read()
    if 'knowledge.html' not in txt:
        txt = txt.replace('The Theo Model</a>', 'The Theo Model</a>' + insert, 1)
        open(f, 'w').write(txt)
        print(f'Updated {f}')
    else:
        print(f'Skipped {f} (already has link)')
"
```

**Step 2: Deploy everything**

```bash
cd /Users/theodoreaddo/theoaddo.com && \
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 \
npx wrangler pages deploy . --project-name theo-os --commit-dirty=true --branch=main
```

**Step 3: End-to-end test**

```bash
TOKEN=$(curl -s -X POST https://theo-os.pages.dev/api/theo-os/auth/login \
  -H "Content-Type: application/json" -d '{"password":"8140"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 1. List knowledge notes
curl -s "https://theo-os.pages.dev/api/theo-os/knowledge" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 2. Start a review session
NOTE_ID=1
curl -s -X POST "https://theo-os.pages.dev/api/theo-os/knowledge/${NOTE_ID}/review" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool

# 3. Submit a score
curl -s -X POST "https://theo-os.pages.dev/api/theo-os/knowledge/${NOTE_ID}/score" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"response":"The basal ganglia encode habitual behaviors through dopaminergic reward loops in the striatum.","prompt":"How does the brain form habits?"}' | python3 -m json.tool
```

Expected: review returns prompt + digest + resources; score returns a 1-5 score with updated next_review.

**Step 4: Final commit**

```bash
git add admin/ && git commit -m "feat: Phase 2b complete — knowledge system, SM-2 spaced repetition, Learn page

- SM-2 spaced repetition with Ebbinghaus decay
- Passive knowledge extraction from every chat exchange
- Active depth probing in Secretary system prompt
- Knowledge Review API: Brave Search + resource digest personalized to Theo's cognitive profile
- /admin/knowledge.html: manage knowledge notes
- /admin/learn.html: therapeutic review environment with Socratic prompts
- Knowledge surfaces in briefing, weekly review, and chat
- Weekly cron recalculates decay for all notes"
```
