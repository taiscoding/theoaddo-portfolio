# Temporal View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a past/now/future temporal page that acts as a cognitive offloading tool — a trusted place the brain can hand time to.

**Architecture:** Three Cloudflare Pages Functions serve the three zones. The Now zone uses a KV-cached Claude Haiku digest invalidated on every user write. The page lives at `/admin/time.html` and is visited intentionally, not always visible. A single dot in the sidebar nav signals urgency without surfacing content.

**Tech Stack:** Cloudflare Pages Functions (ES modules), D1 SQLite, KV, Claude Haiku (claude-haiku-4-5-20251001), vanilla JS, same CSS patterns as existing admin pages.

**Design doc:** `docs/plans/2026-04-11-temporal-design.md`

---

### Task 1: Past endpoint

**Files:**
- Create: `functions/api/theo-os/time/past.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get('days') || '30', 10);
  const area = url.searchParams.get('area') || null;
  const person_id = url.searchParams.get('person_id') || null;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    // Journal entries
    const journalQuery = area
      ? `SELECT 'journal' as source_type, id, content as title, NULL as notes, created_at, NULL as area, weight
         FROM journal WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50`
      : `SELECT 'journal' as source_type, id, content as title, NULL as notes, created_at, NULL as area, weight
         FROM journal WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50`;

    const { results: journalEntries } = await env.THEO_OS_DB.prepare(journalQuery)
      .bind(cutoff).all();

    // Completed tasks
    const { results: completedTasks } = await env.THEO_OS_DB.prepare(
      `SELECT 'task' as source_type, id, title, notes, updated_at as created_at, area, weight
       FROM tasks WHERE status = 'done' AND updated_at >= ?
       ${area ? 'AND area = ?' : ''}
       ORDER BY updated_at DESC LIMIT 50`
    ).bind(...(area ? [cutoff, area] : [cutoff])).all();

    // Connection touchpoints (people mentioned in connections recently)
    let touchpoints = [];
    if (person_id) {
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT 'person' as source_type, p.id, p.name as title, p.notes, p.updated_at as created_at, NULL as area, p.weight
         FROM people p
         JOIN connections c ON (c.to_type = 'person' AND c.to_id = p.id)
         WHERE p.id = ? AND p.updated_at >= ?
         ORDER BY p.updated_at DESC LIMIT 20`
      ).bind(person_id, cutoff).all();
      touchpoints = results;
    }

    // Merge and sort by created_at descending
    const all = [...journalEntries, ...completedTasks, ...touchpoints]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return json({ episodes: all, days, area, person_id });
  } catch (e) {
    return err(`Failed to fetch past: ${e.message}`, 500);
  }
}
```

**Step 2: Verify the route works**

Deploy (see Task 7) then:
```
curl -H "Authorization: Bearer <token>" https://theo-os.pages.dev/api/theo-os/time/past
```
Expected: `{ episodes: [...], days: 30, area: null, person_id: null }`

**Step 3: Commit**

```bash
git add functions/api/theo-os/time/past.js
git commit -m "feat: add past zone API endpoint"
```

---

### Task 2: Future endpoint

**Files:**
- Create: `functions/api/theo-os/time/future.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin } from '../_utils.js';

// Group tasks and goals into paths by area, rank by aggregate weight
function buildPaths(tasks, goals) {
  const areas = {};

  for (const goal of goals) {
    const a = goal.area || 'life';
    if (!areas[a]) areas[a] = { area: a, goal: null, tasks: [], weight: 0, people: [] };
    areas[a].goal = goal;
    areas[a].weight += goal.weight || 1;
  }

  for (const task of tasks) {
    const a = task.area || 'life';
    if (!areas[a]) areas[a] = { area: a, goal: null, tasks: [], weight: 0, people: [] };
    areas[a].tasks.push(task);
    areas[a].weight += task.weight || 1;
  }

  return Object.values(areas)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5); // top 5 paths only
}

// Label a due date relative to now
function horizonLabel(dateStr) {
  if (!dateStr) return 'someday';
  const due = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.ceil((due - now) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays <= 7) return `in ${diffDays} days`;
  if (diffDays <= 14) return 'this week';
  if (diffDays <= 31) return 'this month';
  if (diffDays <= 365) return 'this year';
  return 'someday';
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  try {
    // Open tasks with due dates or high weight
    const { results: tasks } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area, due_date, weight, notes
       FROM tasks WHERE status != 'done'
       ORDER BY weight DESC, due_date ASC NULLS LAST LIMIT 60`
    ).all();

    // Active goals
    const { results: goals } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area, target_date, weight, description
       FROM goals ORDER BY weight DESC LIMIT 20`
    ).all();

    // Annotate horizon labels
    const annotatedTasks = tasks.map(t => ({ ...t, horizon: horizonLabel(t.due_date) }));
    const annotatedGoals = goals.map(g => ({ ...g, horizon: horizonLabel(g.target_date) }));

    const paths = buildPaths(annotatedTasks, annotatedGoals);

    // Check for anything due in 48 hours (for nav dot)
    const soon = annotatedTasks.some(t =>
      t.due_date && new Date(t.due_date) - new Date() < 48 * 3600000 && new Date(t.due_date) > new Date()
    );

    return json({ paths, nav_dot: soon ? 'amber' : 'green' });
  } catch (e) {
    return err(`Failed to fetch future: ${e.message}`, 500);
  }
}
```

**Step 2: Verify the route works**

```
curl -H "Authorization: Bearer <token>" https://theo-os.pages.dev/api/theo-os/time/future
```
Expected: `{ paths: [...], nav_dot: "green" | "amber" }`

**Step 3: Commit**

```bash
git add functions/api/theo-os/time/future.js
git commit -m "feat: add future zone API endpoint with path grouping"
```

---

### Task 3: Now endpoint (Haiku digest + KV cache)

**Files:**
- Create: `functions/api/theo-os/time/now.js`

**Step 1: Create the file**

```js
import { json, err, requireAdmin, loadMemoryContext } from '../_utils.js';

const KV_KEY = 'time:now:digest';
const KV_TTL = 4 * 3600; // 4 hours max, but invalidated on write

const NOW_SYSTEM = `You are generating a short "now" digest for Theo OS.
Given open tasks, upcoming goals, and overdue touchpoints, write 3-5 sentences 
that feel like a trusted friend catching you up on what actually matters right now.
Not a list — a paragraph. Calm, honest, direct. No alarm language.
Return plain text only, no JSON, no markdown.`;

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  // Check cache first
  if (!force) {
    try {
      const cached = await env.THEO_OS_KV.get(KV_KEY, { type: 'json' });
      if (cached) return json(cached);
    } catch { /* cache miss is fine */ }
  }

  // Build context from DB
  let taskLines = '', goalLines = '', peopleLines = '';
  try {
    const { results: tasks } = await env.THEO_OS_DB.prepare(
      `SELECT title, due_date, area FROM tasks WHERE status != 'done'
       ORDER BY weight DESC, due_date ASC NULLS LAST LIMIT 10`
    ).all();
    taskLines = tasks.map(t => `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n');

    const { results: goals } = await env.THEO_OS_DB.prepare(
      `SELECT title, target_date FROM goals ORDER BY weight DESC LIMIT 5`
    ).all();
    goalLines = goals.map(g => `- ${g.title}${g.target_date ? ` (target ${g.target_date})` : ''}`).join('\n');

    const { results: people } = await env.THEO_OS_DB.prepare(
      `SELECT name, next_touchpoint FROM people
       WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= date('now', '+7 days')
       ORDER BY next_touchpoint ASC LIMIT 5`
    ).all();
    peopleLines = people.map(p => `- ${p.name} (touchpoint ${p.next_touchpoint})`).join('\n');
  } catch { /* degrade to empty context */ }

  const memory = await loadMemoryContext(env);

  let digest = 'Nothing urgent right now. You\'re on top of it.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `${NOW_SYSTEM}\n\nUser context:\nFacts: ${memory.facts}\nPatterns: ${memory.patterns}`,
        messages: [{
          role: 'user',
          content: `Open tasks:\n${taskLines || 'none'}\n\nGoals:\n${goalLines || 'none'}\n\nUpcoming touchpoints:\n${peopleLines || 'none'}`
        }]
      })
    });
    if (res.ok) {
      const data = await res.json();
      digest = data.content?.[0]?.text?.trim() || digest;
    }
  } catch { /* degrade to default message */ }

  const result = { digest, generated_at: new Date().toISOString() };

  // Cache it
  try {
    await env.THEO_OS_KV.put(KV_KEY, JSON.stringify(result), { expirationTtl: KV_TTL });
  } catch { /* non-fatal */ }

  return json(result);
}
```

**Step 2: Verify**

```
curl -H "Authorization: Bearer <token>" https://theo-os.pages.dev/api/theo-os/time/now
```
Expected: `{ digest: "...", generated_at: "..." }`
Call again — should return same `generated_at` (cached).
Call with `?force=1` — should return fresh `generated_at`.

**Step 3: Commit**

```bash
git add functions/api/theo-os/time/now.js
git commit -m "feat: add now zone endpoint with KV cache and Haiku digest"
```

---

### Task 4: KV cache invalidation on write

Any user write action should invalidate the Now digest so the next visit gets a fresh one.

**Files:**
- Modify: `functions/api/theo-os/capture/save.js`
- Modify: `functions/api/theo-os/tasks/index.js` (if PATCH/PUT exists — check first)
- Modify: `functions/api/theo-os/journal/index.js` (if POST exists — check first)

**Step 1: Add invalidation helper to save.js**

At the top of `onRequestPost` in `save.js`, after the save succeeds and before `return json(...)`, add:

```js
// Invalidate Now digest cache so next visit reflects this capture
env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
```

This is fire-and-forget. It never blocks the save response.

**Step 2: Check if tasks and journal have write endpoints**

```bash
ls functions/api/theo-os/tasks/
ls functions/api/theo-os/journal/
```

Add the same one-liner to any POST/PATCH/PUT handler in those directories. Place it after the DB write, before the return, fire-and-forget.

Pattern to add everywhere a user write succeeds:
```js
env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
```

**Step 3: Verify invalidation works**

1. Call `/api/theo-os/time/now` — note `generated_at`
2. Submit a capture
3. Call `/api/theo-os/time/now` again — `generated_at` should be newer

**Step 4: Commit**

```bash
git add functions/api/theo-os/capture/save.js
# add any other modified files
git commit -m "feat: invalidate now digest cache on user writes"
```

---

### Task 5: Build /admin/time.html

**Files:**
- Create: `admin/time.html`

**Step 1: Create the page**

Model the structure exactly on `admin/chat.html` — same sidebar nav, same CSS imports, same auth guard pattern. The key differences are the three zones rendered inside the main content area.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Time — Theo OS</title>
  <link rel="stylesheet" href="/admin/css/admin.css">
  <style>
    .time-page { max-width: 780px; margin: 0 auto; padding: 32px 24px; }

    /* Zone cards */
    .zone { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .zone-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .zone-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .zone-refresh { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 14px; padding: 2px 6px; border-radius: 4px; }
    .zone-refresh:hover { color: var(--text); background: var(--border); }
    .zone-meta { font-size: 11px; color: var(--muted); margin-left: auto; }

    /* Now zone */
    .now-digest { font-size: 15px; line-height: 1.7; color: var(--text); }
    .now-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .now-chip { font-size: 12px; padding: 4px 10px; border-radius: 20px; background: var(--border); color: var(--text); cursor: pointer; border: none; }
    .now-chip:hover { background: var(--accent); color: white; }

    /* Past zone */
    .episode { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .episode:last-child { border-bottom: none; }
    .episode-meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
    .episode-title { font-size: 14px; color: var(--text); white-space: pre-wrap; }
    .episode-type { background: var(--border); border-radius: 4px; padding: 1px 6px; font-size: 10px; }
    .past-filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .filter-btn { font-size: 11px; padding: 4px 10px; border-radius: 16px; border: 1px solid var(--border); background: none; cursor: pointer; color: var(--muted); }
    .filter-btn.active { background: var(--text); color: var(--bg); border-color: var(--text); }

    /* Future zone */
    .path { padding: 14px 0; border-bottom: 1px solid var(--border); }
    .path:last-child { border-bottom: none; }
    .path-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
    .path-area { font-size: 13px; font-weight: 600; color: var(--text); text-transform: capitalize; }
    .path-goal { font-size: 12px; color: var(--muted); }
    .path-tasks { list-style: none; padding: 0; margin: 0; }
    .path-task { font-size: 13px; color: var(--text); padding: 3px 0; display: flex; align-items: center; gap: 8px; }
    .horizon { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: var(--border); color: var(--muted); white-space: nowrap; }
    .horizon.overdue { background: #fef2f2; color: #dc2626; }
    .horizon.today, .horizon.tomorrow { background: #fef9c3; color: #854d0e; }
    .path.possible { opacity: 0.45; }

    /* Spinner */
    .spinner { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-row { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; padding: 12px 0; }
    .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
  </style>
</head>
<body>
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
    <a href="/admin/time.html" class="sidebar-link active">Time <span id="nav-dot" style="display:none;width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block;margin-left:4px;vertical-align:middle;"></span></a>

    <div class="sidebar-label">Inbox</div>
    <a href="/admin/email.html" class="sidebar-link">Email Triage</a>

    <div class="sidebar-label">Intelligence</div>
    <a href="/admin/chat.html" class="sidebar-link">Chat</a>
    <a href="/admin/model.html" class="sidebar-link">The Theo Model</a>
    <a href="/admin/knowledge.html" class="sidebar-link">Knowledge</a>
    <a href="/admin/learn.html" class="sidebar-link">Learn</a>
    <a href="/admin/graph.html" class="sidebar-link">Knowledge Graph</a>

    <div class="sidebar-label" style="margin-top:24px">Account</div>
    <a href="#" class="sidebar-link" id="logout-btn">Sign out</a>
  </nav>

  <main class="main-content">
    <div class="time-page">
      <h1 class="page-title">Time</h1>

      <!-- NOW ZONE -->
      <div class="zone" id="now-zone">
        <div class="zone-header">
          <span class="zone-label">Now</span>
          <span class="zone-meta" id="now-meta"></span>
          <button class="zone-refresh" id="now-refresh" title="Refresh digest">↻</button>
        </div>
        <div id="now-body">
          <div class="loading-row"><div class="spinner"></div> Generating digest...</div>
        </div>
      </div>

      <!-- FUTURE ZONE -->
      <div class="zone" id="future-zone">
        <div class="zone-header">
          <span class="zone-label">Future</span>
        </div>
        <div id="future-body">
          <div class="loading-row"><div class="spinner"></div> Loading paths...</div>
        </div>
      </div>

      <!-- PAST ZONE -->
      <div class="zone" id="past-zone">
        <div class="zone-header">
          <span class="zone-label">Past</span>
        </div>
        <div class="past-filters">
          <button class="filter-btn active" data-days="30">30 days</button>
          <button class="filter-btn" data-days="90">3 months</button>
          <button class="filter-btn" data-days="365">1 year</button>
          <button class="filter-btn active" data-area="">All areas</button>
          <button class="filter-btn" data-area="work">Work</button>
          <button class="filter-btn" data-area="life">Life</button>
          <button class="filter-btn" data-area="health">Health</button>
        </div>
        <div id="past-body">
          <div class="loading-row"><div class="spinner"></div> Loading episodes...</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    const TOKEN_KEY = 'theo_admin_token';
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) location.replace('/admin/index.html');

    function apiGet(path) {
      return fetch(path, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    }

    // ── NOW ZONE ──────────────────────────────────────────────────
    async function loadNow(force = false) {
      document.getElementById('now-body').innerHTML = '<div class="loading-row"><div class="spinner"></div> Generating digest...</div>';
      try {
        const data = await apiGet(`/api/theo-os/time/now${force ? '?force=1' : ''}`);
        const ago = data.generated_at ? relativeTime(data.generated_at) : '';
        document.getElementById('now-meta').textContent = ago ? `Updated ${ago}` : '';
        document.getElementById('now-body').innerHTML = `<p class="now-digest">${escHtml(data.digest || '')}</p>`;
      } catch {
        document.getElementById('now-body').innerHTML = '<p class="empty">Could not load digest.</p>';
      }
    }

    document.getElementById('now-refresh').addEventListener('click', () => loadNow(true));

    // ── FUTURE ZONE ───────────────────────────────────────────────
    async function loadFuture() {
      try {
        const data = await apiGet('/api/theo-os/time/future');
        const navDot = document.getElementById('nav-dot');
        if (data.nav_dot === 'amber') navDot.style.display = 'inline-block';

        if (!data.paths?.length) {
          document.getElementById('future-body').innerHTML = '<p class="empty">No active paths yet.</p>';
          return;
        }

        const html = data.paths.map((path, i) => {
          const isProbable = i < 3; // top 3 paths are probable
          const goalHtml = path.goal ? `<span class="path-goal">${escHtml(path.goal.title)}</span>` : '';
          const tasksHtml = (path.tasks || []).slice(0, 3).map(t => `
            <li class="path-task">
              ${escHtml(t.title)}
              <span class="horizon ${t.horizon}">${t.horizon}</span>
            </li>`).join('');
          return `
            <div class="path ${isProbable ? 'probable' : 'possible'}">
              <div class="path-header">
                <span class="path-area">${escHtml(path.area)}</span>
                ${goalHtml}
              </div>
              <ul class="path-tasks">${tasksHtml || '<li class="path-task empty">No tasks yet</li>'}</ul>
            </div>`;
        }).join('');

        document.getElementById('future-body').innerHTML = html;
      } catch {
        document.getElementById('future-body').innerHTML = '<p class="empty">Could not load future paths.</p>';
      }
    }

    // ── PAST ZONE ─────────────────────────────────────────────────
    let currentDays = 30;
    let currentArea = '';

    async function loadPast() {
      document.getElementById('past-body').innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading episodes...</div>';
      try {
        const params = new URLSearchParams({ days: currentDays });
        if (currentArea) params.set('area', currentArea);
        const data = await apiGet(`/api/theo-os/time/past?${params}`);

        if (!data.episodes?.length) {
          document.getElementById('past-body').innerHTML = '<p class="empty">No episodes in this period.</p>';
          return;
        }

        const html = data.episodes.map(ep => {
          const snippet = (ep.title || '').slice(0, 120);
          const dateStr = ep.created_at ? new Date(ep.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
          const rel = ep.created_at ? relativeTime(ep.created_at) : '';
          return `
            <div class="episode">
              <div class="episode-meta">
                <span class="episode-type">${ep.source_type}</span>
                <span>${dateStr}</span>
                <span>${rel}</span>
              </div>
              <div class="episode-title">${escHtml(snippet)}</div>
            </div>`;
        }).join('');

        document.getElementById('past-body').innerHTML = html;
      } catch {
        document.getElementById('past-body').innerHTML = '<p class="empty">Could not load past episodes.</p>';
      }
    }

    // Filter buttons
    document.querySelectorAll('.filter-btn[data-days]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn[data-days]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = parseInt(btn.dataset.days, 10);
        loadPast();
      });
    });

    document.querySelectorAll('.filter-btn[data-area]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn[data-area]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentArea = btn.dataset.area;
        loadPast();
      });
    });

    // ── UTILS ─────────────────────────────────────────────────────
    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function relativeTime(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const min = Math.floor(diff / 60000);
      if (min < 1) return 'just now';
      if (min < 60) return `${min} min ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h ago`;
      const d = Math.floor(hr / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    }

    // Logout
    document.getElementById('logout-btn').addEventListener('click', e => {
      e.preventDefault();
      localStorage.removeItem(TOKEN_KEY);
      location.replace('/admin/index.html');
    });

    // Init
    loadNow();
    loadFuture();
    loadPast();
  </script>
</body>
</html>
```

**Step 2: Verify page loads**

After deploy, navigate to `/admin/time.html`. All three zones should render with their spinners, then populate. If any zone shows "Could not load", check the Network tab for the failing API call.

**Step 3: Commit**

```bash
git add admin/time.html
git commit -m "feat: add temporal view page with past/now/future zones"
```

---

### Task 6: Add Time link to all sidebar navs

The "Time" link currently only exists in `time.html`. Every other admin page sidebar needs it too so navigation is consistent.

**Files to modify:** All `.html` files in `admin/` except `time.html` itself. Check each one has the sidebar nav block.

**Step 1: Find the right insertion point**

In each file, find the Mind section of the sidebar:
```html
<a href="/admin/review.html" class="sidebar-link">Weekly Review</a>
```

After that line, add:
```html
<a href="/admin/time.html" class="sidebar-link">Time</a>
```

**Step 2: Files to update**

Run this to find all sidebar nav files:
```bash
grep -l "Weekly Review" admin/*.html
```

Update each one. Do not add `class="active"` — that only goes on the current page's own link.

**Step 3: Commit**

```bash
git add admin/*.html
git commit -m "feat: add Time link to all sidebar navs"
```

---

### Task 7: Deploy

```bash
CLOUDFLARE_API_TOKEN=cfut_grg8xie050kbnIi1G0poG9QftDyBvmjRw3EMNCBh6fe0a6d2 \
  npx wrangler pages deploy . --project-name theo-os
```

**Verify:**
1. Navigate to `/admin/time.html` — all three zones load
2. Now zone: call with `?force=1` in the URL after signing in to force a fresh digest
3. Future zone: check paths render; if no tasks with due dates exist, paths will still show by area
4. Past zone: journal entries and completed tasks should appear; filters change the content
5. Nav dot: visible (amber) only if a task due date falls within 48 hours

**Commit if any last-minute fixes were needed:**

```bash
git add -A
git commit -m "fix: post-deploy corrections to temporal view"
```

---

## Rollback

All new endpoints are additive — no schema changes, no modifications to existing endpoints except adding one fire-and-forget KV delete to `save.js`. Rollback means reverting `save.js` and removing the three new files in `functions/api/theo-os/time/`. The page `admin/time.html` can be removed without breaking anything else.
