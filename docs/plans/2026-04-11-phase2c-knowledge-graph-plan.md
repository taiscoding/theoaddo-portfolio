# Phase 2c: Knowledge Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a force-directed knowledge graph that renders every entity in the OS as a node, infers connections between them using Claude, and visualizes decay, area, and relationships as light/color/size.

**Architecture:** A `GET /api/theo-os/graph` endpoint aggregates all entity types (tasks, goals, knowledge notes, people, journal entries) into Cytoscape.js node/edge format. A `POST /api/theo-os/connections/infer` endpoint calls Haiku to batch-infer connections between entities and writes them to the existing `connections` table. The frontend is a full-screen Cytoscape.js canvas at `/admin/graph.html` with hover tooltips, click-to-open, area filtering, and type filtering.

**Tech Stack:** Cloudflare Pages Functions (ES modules), Cloudflare D1, Cytoscape.js (CDN), Claude Haiku for connection inference, existing admin.css design system.

---

## Context for implementers

**Project:** `theoaddo.com` — Cloudflare Pages + D1 personal life OS.

**File patterns:**
- API handlers live in `functions/api/theo-os/` as named ES module exports (`onRequestGet`, `onRequestPost`, etc.)
- Shared utilities: `functions/api/theo-os/_utils.js` — exports `json()`, `err()`, `requireAdmin()`, `loadMemoryContext()`
- Admin pages: `admin/*.html` — plain HTML/CSS/JS, no framework
- Auth: every API call from the browser includes `Authorization: Bearer <token>` (stored in localStorage as `theo_os_token`). See `admin/js/auth.js` for `apiGet()`, `apiPost()`, `apiFetch()` helpers.
- Design system: `admin/css/admin.css` — void palette, teal (#00d1c1) / coral (#ff5b5b) / purple accent, Space Grotesk + JetBrains Mono fonts

**Database:** `theo_os_db` (Cloudflare D1, SQLite)

Relevant tables:
```
tasks(id, title, area, status, created_at, updated_at)
goals(id, title, area, status, created_at, updated_at)
knowledge_notes(id, title, area, depth, decay_score, created_at, updated_at)
people(id, name, relationship, created_at)
journal(id, content, created_at)
connections(id, from_id, from_type, to_id, to_type, label, inferred, created_at)
```

The `connections` table is currently empty (0 rows) — the inference task populates it.

**Cloudflare D1 query pattern:**
```js
const { results } = await env.THEO_OS_DB.prepare('SELECT * FROM table WHERE id = ?').bind(id).all();
const row = await env.THEO_OS_DB.prepare('SELECT * FROM table WHERE id = ?').bind(id).first();
await env.THEO_OS_DB.prepare('INSERT INTO table (col) VALUES (?)').bind(val).run();
```

**No test runner exists.** Manual verification via browser + `wrangler pages dev` or deployed URL.

---

## Task 1: Graph data API

**Files:**
- Create: `functions/api/theo-os/graph.js`

**What it does:** Aggregates all entity types into Cytoscape.js `{ nodes, edges }` format. Nodes have `id` (e.g. `"goal:1"`), `label`, `type`, `area`, `weight` (size hint), `decay` (opacity hint for knowledge nodes), `url` (for click-to-open). Edges come from the `connections` table.

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from './_utils.js';

// Area → color mapping (matches admin.css palette)
const AREA_COLORS = {
  work:          '#00d1c1',
  growth:        '#00b8a9',
  health:        '#ff5b5b',
  life:          '#ff7b6b',
  relationships: '#9b5de5',
  creative:      '#c77dff',
  finances:      '#f5c842',
  exploration:   '#f8d95a',
};
const DEFAULT_COLOR = '#4a5568';

const DEPTH_WEIGHT = { aware: 0.8, familiar: 1.2, fluent: 1.6 };

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const [tasksRes, goalsRes, knowledgeRes, peopleRes, journalRes, connectionsRes] = await Promise.all([
    env.THEO_OS_DB.prepare(
      `SELECT id, title, area, status FROM tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT 50`
    ).all(),
    env.THEO_OS_DB.prepare(
      `SELECT id, title, area, status FROM goals WHERE status = 'active' ORDER BY updated_at DESC LIMIT 30`
    ).all(),
    env.THEO_OS_DB.prepare(
      `SELECT id, title, area, depth, decay_score FROM knowledge_notes ORDER BY created_at DESC LIMIT 50`
    ).all(),
    env.THEO_OS_DB.prepare(
      `SELECT id, name, relationship FROM people ORDER BY name ASC LIMIT 30`
    ).all(),
    env.THEO_OS_DB.prepare(
      `SELECT id, substr(content, 1, 60) as preview, created_at FROM journal ORDER BY created_at DESC LIMIT 20`
    ).all(),
    env.THEO_OS_DB.prepare(
      `SELECT from_id, from_type, to_id, to_type, label FROM connections LIMIT 500`
    ).all(),
  ]);

  const nodes = [];
  const nodeSet = new Set(); // track which node ids exist

  function addNode(data) {
    nodeSet.add(data.id);
    nodes.push({ data });
  }

  // Tasks
  for (const t of (tasksRes.results || [])) {
    addNode({
      id: `task:${t.id}`,
      label: t.title,
      type: 'task',
      area: t.area || 'general',
      color: AREA_COLORS[t.area] || DEFAULT_COLOR,
      weight: 0.7,
      decay: 1.0,
      url: `/admin/tasks.html`,
    });
  }

  // Goals
  for (const g of (goalsRes.results || [])) {
    addNode({
      id: `goal:${g.id}`,
      label: g.title,
      type: 'goal',
      area: g.area || 'general',
      color: AREA_COLORS[g.area] || DEFAULT_COLOR,
      weight: 1.4,
      decay: 1.0,
      url: `/admin/goals.html`,
    });
  }

  // Knowledge notes
  for (const k of (knowledgeRes.results || [])) {
    addNode({
      id: `knowledge:${k.id}`,
      label: k.title,
      type: 'knowledge',
      area: k.area || 'general',
      color: '#a0aec0',
      weight: DEPTH_WEIGHT[k.depth] || 1.0,
      decay: k.decay_score ?? 1.0,
      url: `/admin/learn.html?id=${k.id}`,
    });
  }

  // People
  for (const p of (peopleRes.results || [])) {
    addNode({
      id: `person:${p.id}`,
      label: p.name,
      type: 'person',
      area: 'relationships',
      color: AREA_COLORS.relationships,
      weight: 1.1,
      decay: 1.0,
      url: `/admin/people.html`,
    });
  }

  // Journal entries
  for (const j of (journalRes.results || [])) {
    const preview = (j.preview || '').replace(/\n/g, ' ').slice(0, 50);
    addNode({
      id: `journal:${j.id}`,
      label: preview || 'Journal entry',
      type: 'journal',
      area: 'life',
      color: '#718096',
      weight: 0.5,
      decay: 1.0,
      url: `/admin/journal.html`,
    });
  }

  // Edges — only include if both endpoints exist in node set
  const edges = [];
  for (const c of (connectionsRes.results || [])) {
    const source = `${c.from_type}:${c.from_id}`;
    const target = `${c.to_type}:${c.to_id}`;
    if (nodeSet.has(source) && nodeSet.has(target)) {
      edges.push({ data: { id: `${source}->${target}`, source, target, label: c.label || '' } });
    }
  }

  return json({ nodes, edges }, 200, request);
}
```

**Step 2: Commit**

```bash
git add functions/api/theo-os/graph.js
git commit -m "feat: graph data API — aggregates all entity types into Cytoscape node/edge format"
```

---

## Task 2: Connection inference API

**Files:**
- Create: `functions/api/theo-os/connections/infer.js`

**What it does:** Calls Haiku with a condensed view of all goals + knowledge notes + tasks. Haiku identifies meaningful connections between them. Results are written to `connections` table (deduplicating by from/to pair).

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  // Load entities to infer connections between
  const [goalsRes, knowledgeRes, tasksRes] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 25`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, title, area, depth FROM knowledge_notes LIMIT 30`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, title, area FROM tasks WHERE status != 'done' LIMIT 30`).all(),
  ]);

  const goals = goalsRes.results || [];
  const knowledge = knowledgeRes.results || [];
  const tasks = tasksRes.results || [];

  if (goals.length + knowledge.length + tasks.length < 2) {
    return json({ created: 0, message: 'Not enough entities to infer connections' }, 200, request);
  }

  const entityList = [
    ...goals.map(g => `goal:${g.id} "${g.title}" [area: ${g.area || 'general'}]`),
    ...knowledge.map(k => `knowledge:${k.id} "${k.title}" [area: ${k.area || 'general'}, depth: ${k.depth}]`),
    ...tasks.map(t => `task:${t.id} "${t.title}" [area: ${t.area || 'general'}]`),
  ].join('\n');

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are analyzing a personal life OS. Identify meaningful connections between the entities below.

Entities (format: type:id "title" [metadata]):
${entityList}

Rules:
- Only connect entities that genuinely relate (a knowledge concept supports a goal, a task advances a goal, a topic relates to another topic)
- Prefer strong, specific relationships over vague ones
- Labels should be short: "supports", "requires", "relates to", "builds on", "part of", "enables"
- Generate 5-15 connections maximum
- Do NOT connect things just because they share an area

Return a JSON array only, no markdown:
[{"from_type":"goal","from_id":1,"to_type":"knowledge","to_id":2,"label":"requires"}]`
      }]
    })
  }).catch(() => null);

  if (!aiRes?.ok) return err('Inference API error', 502);

  const aiData = await aiRes.json().catch(() => null);
  const raw = aiData?.content?.[0]?.text;
  if (!raw) return err('No response from inference', 502);

  let connections;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    connections = match ? JSON.parse(match[0]) : JSON.parse(raw);
  } catch { return err('Failed to parse inference response', 502); }

  if (!Array.isArray(connections)) return err('Invalid inference response', 502);

  // Load existing connections to deduplicate
  const { results: existing } = await env.THEO_OS_DB.prepare(
    `SELECT from_type, from_id, to_type, to_id FROM connections`
  ).all();
  const existingSet = new Set(
    (existing || []).map(c => `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`)
  );

  let created = 0;
  for (const c of connections.slice(0, 15)) {
    if (!c.from_type || !c.from_id || !c.to_type || !c.to_id) continue;
    const key = `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`;
    if (existingSet.has(key)) continue;
    existingSet.add(key);
    await env.THEO_OS_DB.prepare(
      `INSERT INTO connections (from_id, from_type, to_id, to_type, label, inferred, created_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
    ).bind(Number(c.from_id), String(c.from_type), Number(c.to_id), String(c.to_type), c.label || '').run().catch(() => {});
    created++;
  }

  return json({ created, total: connections.length }, 200, request);
}
```

**Step 2: Commit**

```bash
git add functions/api/theo-os/connections/infer.js
git commit -m "feat: connection inference API — Haiku infers entity relationships and writes to connections table"
```

---

## Task 3: Wire inference into score endpoint + cron

**Files:**
- Modify: `functions/api/theo-os/knowledge/[id]/score.js`
- Modify: `cron-worker.js`

**What it does:** After a knowledge review is scored, trigger a lightweight inference pass for that note's connections. Also add connection inference to the weekly cron.

**Step 1: Read score.js to find the end of the handler (before the return statement)**

The file is at `functions/api/theo-os/knowledge/[id]/score.js`. Find the return statement that returns the score result. Add inference logic before it (fire-and-forget via `waitUntil` if available, otherwise just fire):

```js
// After updating SM-2 state, infer connections for this note (fire and forget)
const inferConnections = async () => {
  try {
    // Load goals that might connect to this note
    const { results: goals } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 20`
    ).all();
    const { results: knowledgeNeighbors } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area, depth FROM knowledge_notes WHERE id != ? LIMIT 15`
    ).bind(id).all();

    const thisNote = note; // already loaded above
    const entityList = [
      `knowledge:${thisNote.id} "${thisNote.title}" [area: ${thisNote.area || 'general'}, depth: ${thisNote.depth}]`,
      ...goals.map(g => `goal:${g.id} "${g.title}" [area: ${g.area || 'general'}]`),
      ...knowledgeNeighbors.map(k => `knowledge:${k.id} "${k.title}" [area: ${k.area || 'general'}, depth: ${k.depth}]`),
    ].join('\n');

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Identify connections FROM "knowledge:${thisNote.id}" to other entities below. Max 5 connections. Labels: "supports", "requires", "relates to", "builds on", "enables". Return JSON array only: [{"from_type":"knowledge","from_id":${thisNote.id},"to_type":"goal","to_id":N,"label":"supports"}]\n\n${entityList}` }]
      })
    }).catch(() => null);
    if (!aiRes?.ok) return;
    const data = await aiRes.json().catch(() => null);
    const raw = data?.content?.[0]?.text;
    if (!raw) return;
    let conns;
    try { const m = raw.match(/\[[\s\S]*\]/); conns = m ? JSON.parse(m[0]) : JSON.parse(raw); } catch { return; }
    const { results: existing } = await env.THEO_OS_DB.prepare(`SELECT from_type,from_id,to_type,to_id FROM connections WHERE from_type='knowledge' AND from_id=?`).bind(id).all();
    const existSet = new Set((existing||[]).map(c=>`${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`));
    for (const c of (conns||[]).slice(0,5)) {
      if (!c.from_type||!c.from_id||!c.to_type||!c.to_id) continue;
      const key = `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`;
      if (existSet.has(key)) continue;
      await env.THEO_OS_DB.prepare(`INSERT INTO connections (from_id,from_type,to_id,to_type,label,inferred,created_at) VALUES (?,?,?,?,?,1,datetime('now'))`).bind(Number(c.from_id),String(c.from_type),Number(c.to_id),String(c.to_type),c.label||'').run().catch(()=>{});
    }
  } catch (_) {}
};

// Fire and forget
const inferPromise = inferConnections();
if (context?.waitUntil) context.waitUntil(inferPromise);
```

Note: The score handler signature must be changed from `{ request, env, params }` to `context` with destructuring, so `waitUntil` is accessible. Check the current signature first and adjust.

**Step 2: Add to cron-worker.js**

In `consolidateKnowledge()` at the bottom, add a call to run inference if there are few connections:

```js
// In consolidateKnowledge(), after setting next_review:
try {
  const { results: countRes } = await env.THEO_OS_DB.prepare(`SELECT COUNT(*) as cnt FROM connections`).all();
  const connCount = countRes?.[0]?.cnt || 0;
  // Only infer if connections are sparse relative to knowledge notes
  const { results: noteCountRes } = await env.THEO_OS_DB.prepare(`SELECT COUNT(*) as cnt FROM knowledge_notes`).all();
  const noteCount = noteCountRes?.[0]?.cnt || 0;
  if (noteCount > 1 && connCount < noteCount * 2) {
    // Inline the inference logic (same as infer.js but without HTTP round-trip)
    const [goalsRes, knowledgeRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 20`).all(),
      env.THEO_OS_DB.prepare(`SELECT id, title, area, depth FROM knowledge_notes LIMIT 25`).all(),
    ]);
    // ... (same Haiku call and write logic as infer.js)
    // Copy the entity list construction and Haiku call from Task 2
  }
} catch (_) {}
```

Actually, to avoid copy-pasting the inference logic into three places (infer.js, score.js, cron-worker.js), extract it into a shared helper. **Instead**, keep it simple: the cron just calls the inference via self-fetch if too few connections exist. Or even simpler: just call it inline with the same pattern as infer.js.

**Simplest approach:** In `cron-worker.js`, add a standalone `runConnectionInference(env)` function (copy the core logic from infer.js). Call it from the weekly cron alongside `consolidateKnowledge`.

```js
async function runConnectionInference(env) {
  // Same logic as functions/api/theo-os/connections/infer.js
  // (copy the entity loading, Haiku call, and DB write logic)
  // This avoids an HTTP round-trip in the cron worker
}
```

In the scheduled handler:
```js
else if (event.cron === '0 10 * * 7') {
  ctx.waitUntil(runWeeklyInsights(env));
  ctx.waitUntil(consolidateMemories(env));
  ctx.waitUntil(consolidateKnowledge(env));
  ctx.waitUntil(runConnectionInference(env));
}
```

**Step 3: Commit**

```bash
git add functions/api/theo-os/knowledge/[id]/score.js cron-worker.js
git commit -m "feat: wire connection inference into score endpoint and weekly cron"
```

---

## Task 4: /admin/graph.html — force-directed knowledge graph

**Files:**
- Create: `admin/graph.html`

**What it does:** Full-screen Cytoscape.js canvas. Loads from `/api/theo-os/graph`. Nodes colored by area, sized by weight, opacity by decay. Edges as faint traces. Hover tooltip shows type + label. Click opens entity URL. Type/area filters. "Re-infer connections" button calls the inference API.

**Step 1: Create the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Knowledge Graph — Theo OS</title>
  <link rel="icon" href="/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/css/admin.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('theo_os_theme') || 'dark')</script>
  <style>
    .main { padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .graph-topbar { display: flex; align-items: center; gap: 14px; padding: 12px 24px; border-bottom: 1px solid var(--border-ghost); flex-shrink: 0; flex-wrap: wrap; }
    .graph-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin-right: 8px; }
    .filter-btn { background: none; border: 1px solid var(--border-ghost); border-radius: 16px; padding: 3px 11px; font-size: 10px; font-family: var(--font-mono); color: var(--text-secondary); cursor: pointer; transition: all 0.12s; }
    .filter-btn.active, .filter-btn:hover { border-color: var(--teal); color: var(--teal); }
    .filter-sep { width: 1px; height: 16px; background: var(--border-ghost); }
    .infer-btn { background: none; border: 1px solid var(--border-ghost); border-radius: 6px; padding: 4px 12px; font-size: 10px; font-family: var(--font-mono); color: var(--text-tertiary); cursor: pointer; margin-left: auto; }
    .infer-btn:hover { border-color: var(--teal); color: var(--teal); }
    #cy { flex: 1; background: var(--void-base); }
    .tooltip { position: fixed; background: var(--void-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px 14px; pointer-events: none; font-size: 12px; color: var(--text-primary); max-width: 220px; z-index: 100; display: none; }
    .tooltip-type { font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); margin-bottom: 4px; }
    .tooltip-label { font-weight: 500; line-height: 1.4; margin-bottom: 4px; }
    .tooltip-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); }
    .graph-stats { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); }
    .loading-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); background: var(--void-base); z-index: 50; }
  </style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="sidebar-logo">THEO OS</div>

    <div class="sidebar-label">Overview</div>
    <a href="/admin/dashboard.html" class="sidebar-link">Dashboard</a>
    <a href="/admin/capture.html" class="sidebar-link">Quick Capture</a>

    <div class="sidebar-label">Life</div>
    <a href="/admin/tasks.html" class="sidebar-link">Tasks</a>
    <a href="/admin/goals.html" class="sidebar-link">Goals</a>
    <a href="/admin/people.html" class="sidebar-link">People</a>
    <a href="/admin/collections.html" class="sidebar-link">Collections</a>

    <div class="sidebar-label">Mind</div>
    <a href="/admin/journal.html" class="sidebar-link">Journal</a>
    <a href="/admin/vision.html" class="sidebar-link">Life Vision</a>
    <a href="/admin/review.html" class="sidebar-link">Weekly Review</a>

    <div class="sidebar-label">Inbox</div>
    <a href="/admin/email.html" class="sidebar-link">Email Triage</a>

    <div class="sidebar-label">Intelligence</div>
    <a href="/admin/chat.html" class="sidebar-link">Chat</a>
    <a href="/admin/model.html" class="sidebar-link">The Theo Model</a>
    <a href="/admin/knowledge.html" class="sidebar-link">Knowledge</a>
    <a href="/admin/learn.html" class="sidebar-link">Learn</a>
    <a href="/admin/graph.html" class="sidebar-link active">Knowledge Graph</a>

    <div class="sidebar-label" style="margin-top:24px">Account</div>
    <button class="theme-toggle" id="theme-toggle"></button>
    <a href="#" class="sidebar-link" id="logout-btn">Sign out</a>
  </nav>

  <main class="main" style="position:relative">
    <div class="graph-topbar">
      <span class="graph-title">Knowledge Graph</span>
      <span class="graph-stats" id="graph-stats"></span>
      <div class="filter-sep"></div>

      <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary)">Type:</span>
      <button class="filter-btn active" data-type="all">All</button>
      <button class="filter-btn" data-type="goal">Goals</button>
      <button class="filter-btn" data-type="knowledge">Knowledge</button>
      <button class="filter-btn" data-type="task">Tasks</button>
      <button class="filter-btn" data-type="person">People</button>
      <button class="filter-btn" data-type="journal">Journal</button>

      <div class="filter-sep"></div>
      <button class="infer-btn" id="infer-btn">↺ Re-infer connections</button>
    </div>

    <div id="loading-overlay" class="loading-overlay">Loading graph...</div>
    <div id="cy"></div>
    <div id="tooltip" class="tooltip">
      <div class="tooltip-type" id="tt-type"></div>
      <div class="tooltip-label" id="tt-label"></div>
      <div class="tooltip-meta" id="tt-meta"></div>
    </div>
  </main>
</div>

<script src="/admin/js/auth.js"></script>
<script>
  requireAuth();
  document.getElementById('logout-btn').addEventListener('click', e => {
    e.preventDefault(); clearToken(); window.location.href = '/admin/index.html';
  });

  let cy = null;
  let allElements = [];
  let activeTypeFilter = 'all';

  function buildCytoscape(elements) {
    if (cy) { cy.destroy(); cy = null; }
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const edgeColor = isDark ? '#2d3748' : '#cbd5e0';
    const edgeLabelColor = isDark ? '#4a5568' : '#a0aec0';

    cy = cytoscape({
      container: document.getElementById('cy'),
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'background-opacity': 'data(decay)',
            'width': (ele) => 12 + ele.data('weight') * 14,
            'height': (ele) => 12 + ele.data('weight') * 14,
            'label': 'data(label)',
            'font-size': 9,
            'font-family': 'Space Grotesk, sans-serif',
            'color': isDark ? '#a0aec0' : '#4a5568',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 4,
            'text-max-width': 80,
            'text-wrap': 'ellipsis',
            'border-width': 0,
            'min-zoomed-font-size': 8,
          }
        },
        {
          selector: 'node[type="goal"]',
          style: { 'shape': 'diamond', 'border-width': 1, 'border-color': 'data(color)', 'border-opacity': 0.5 }
        },
        {
          selector: 'node[type="knowledge"]',
          style: { 'shape': 'pentagon' }
        },
        {
          selector: 'node[type="person"]',
          style: { 'shape': 'round-rectangle' }
        },
        {
          selector: 'node[type="journal"]',
          style: { 'shape': 'ellipse', 'background-opacity': 0.4 }
        },
        {
          selector: 'edge',
          style: {
            'width': 1,
            'line-color': edgeColor,
            'target-arrow-shape': 'triangle',
            'target-arrow-color': edgeColor,
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': 8,
            'color': edgeLabelColor,
            'font-family': 'JetBrains Mono, monospace',
            'text-rotation': 'autorotate',
            'text-margin-y': -6,
            'opacity': 0.6,
          }
        },
        {
          selector: 'node:selected, edge:selected',
          style: { 'border-width': 2, 'border-color': '#00d1c1', 'opacity': 1 }
        },
        {
          selector: '.faded',
          style: { 'opacity': 0.1 }
        }
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 800,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 100,
        nodeOverlap: 20,
        fit: true,
        padding: 40,
        randomize: true,
        componentSpacing: 80,
      }
    });

    // Tooltip on mouseover
    const tooltip = document.getElementById('tooltip');
    cy.on('mouseover', 'node', e => {
      const d = e.target.data();
      document.getElementById('tt-type').textContent = d.type;
      document.getElementById('tt-label').textContent = d.label;
      document.getElementById('tt-meta').textContent = [d.area, d.decay < 1 ? `retention: ${(d.decay*100).toFixed(0)}%` : null].filter(Boolean).join(' · ');
      tooltip.style.display = 'block';
    });
    cy.on('mouseout', 'node', () => { tooltip.style.display = 'none'; });
    cy.on('mousemove', e => {
      tooltip.style.left = (e.originalEvent.clientX + 14) + 'px';
      tooltip.style.top = (e.originalEvent.clientY - 10) + 'px';
    });

    // Click to open entity
    cy.on('tap', 'node', e => {
      const url = e.target.data('url');
      if (url) window.open(url, '_blank');
    });

    // Highlight connected on hover
    cy.on('mouseover', 'node', e => {
      cy.elements().addClass('faded');
      e.target.removeClass('faded');
      e.target.connectedEdges().removeClass('faded');
      e.target.connectedEdges().connectedNodes().removeClass('faded');
    });
    cy.on('mouseout', 'node', () => { cy.elements().removeClass('faded'); });
  }

  function applyTypeFilter(type) {
    if (!cy) return;
    activeTypeFilter = type;
    if (type === 'all') {
      cy.elements().show();
    } else {
      cy.nodes().forEach(n => {
        if (n.data('type') === type) n.show(); else n.hide();
      });
      cy.edges().forEach(e => {
        const src = e.source(), tgt = e.target();
        if (src.visible() && tgt.visible()) e.show(); else e.hide();
      });
    }
  }

  async function load() {
    const overlay = document.getElementById('loading-overlay');
    overlay.style.display = 'flex';
    try {
      const data = await apiGet('/api/theo-os/graph');
      allElements = [...(data.nodes || []), ...(data.edges || [])];
      buildCytoscape(allElements);
      document.getElementById('graph-stats').textContent =
        `${data.nodes?.length || 0} nodes · ${data.edges?.length || 0} edges`;
      if (activeTypeFilter !== 'all') applyTypeFilter(activeTypeFilter);
    } catch (e) {
      overlay.innerHTML = `<span style="color:var(--coral)">Failed to load graph</span>`;
      return;
    }
    overlay.style.display = 'none';
  }

  // Type filter buttons
  document.querySelectorAll('.filter-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyTypeFilter(btn.dataset.type);
    });
  });

  // Re-infer connections
  document.getElementById('infer-btn').addEventListener('click', async () => {
    const btn = document.getElementById('infer-btn');
    btn.textContent = 'Inferring...';
    btn.disabled = true;
    try {
      const result = await apiPost('/api/theo-os/connections/infer', {});
      btn.textContent = `✓ ${result.created} new connections`;
      setTimeout(() => { btn.textContent = '↺ Re-infer connections'; btn.disabled = false; }, 3000);
      if (result.created > 0) load();
    } catch {
      btn.textContent = 'Error — try again';
      btn.disabled = false;
    }
  });

  load();
</script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add admin/graph.html
git commit -m "feat: knowledge graph page — Cytoscape.js force-directed visualization with type filters and connection inference"
```

---

## Task 5: Add Graph nav link to all admin pages + deploy

**Files:**
- Modify: all `admin/*.html` except `graph.html` (13 files)

**Step 1: Add nav link via sed**

The Intelligence section in every admin page currently ends with:
```
<a href="/admin/learn.html" class="sidebar-link">Learn</a>
```

Add the graph link after it:
```bash
for f in admin/dashboard.html admin/capture.html admin/tasks.html admin/goals.html admin/people.html admin/collections.html admin/journal.html admin/vision.html admin/review.html admin/email.html admin/chat.html admin/model.html admin/knowledge.html admin/learn.html; do
  sed -i '' 's|<a href="/admin/learn.html" class="sidebar-link">Learn</a>|<a href="/admin/learn.html" class="sidebar-link">Learn</a>\n    <a href="/admin/graph.html" class="sidebar-link">Knowledge Graph</a>|g' "$f"
done
```

**Step 2: Verify**

```bash
grep -c "Knowledge Graph" admin/dashboard.html
# Expected: 1
```

**Step 3: Deploy**

```bash
CLOUDFLARE_API_TOKEN=cfut_f2N2mYAXnjR31oirNuhkREu6Ivv2vR9Sbomq9fKe1a8f48d3 npx wrangler pages deploy . --project-name theo-os --commit-dirty=true
```

**Step 4: Commit**

```bash
git add admin/*.html
git commit -m "feat: add Knowledge Graph nav link to all admin pages + deploy Phase 2c"
```

---

## Verification

After deploy, navigate to `theoaddo.com/admin/graph.html` and:

1. Login and confirm the page loads without console errors
2. Confirm the Cytoscape canvas renders (even if empty — "0 nodes · 0 edges" is fine until data is added)
3. Click "Re-infer connections" — confirm it returns `{ created: N }` without error
4. Add a task and a knowledge note, then re-infer — confirm edges appear in the graph
5. Hover a node — confirm tooltip shows type, label, area
6. Click a node — confirm it opens the entity page in a new tab
7. Toggle type filters — confirm nodes show/hide correctly
