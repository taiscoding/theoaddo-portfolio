# Theo OS Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a private life OS admin portal at `theoaddo.com/admin` — a personal chief of staff that captures everything, surfaces what matters, and helps you stay headed toward where you want to go.

**Architecture:** Cloudflare Pages (static HTML/CSS/JS) + Pages Functions (Workers runtime JS) + D1 (SQLite) + KV (briefing cache). Gmail and Google Calendar via OAuth 2.0. Claude API for all generation and agentic chat. Same pattern as Polarity Lab OS in `polarity-site`.

**Tech Stack:** Cloudflare Pages, Cloudflare Workers (Pages Functions), Cloudflare D1, Cloudflare KV, Claude API (`claude-sonnet-4-6`), Gmail API v1, Google Calendar API v3, Cytoscape.js (Phase 2 only), Vanilla HTML/CSS/JS (no framework), Space Grotesk + Inter + JetBrains Mono fonts.

**Reference codebase:** `/Users/theodoreaddo/polarity-site/` — the Polarity Lab OS is the direct template. Read `functions/api/lab-os/_utils.js`, `public/admin/css/admin.css`, `public/admin/js/auth.js`, and `public/admin/chat.html` before starting any task.

---

## Pre-flight: What You Need to Know

### Cloudflare Pages Functions
Files in `functions/` are automatically deployed as Workers. The file path maps to the route:
- `functions/api/theo-os/tasks/index.js` → `GET/POST /api/theo-os/tasks`
- `functions/api/theo-os/tasks/[id].js` → `GET/PUT/DELETE /api/theo-os/tasks/:id`
- Export named functions `onRequestGet`, `onRequestPost`, `onRequestPut`, `onRequestDelete`
- Or export `onRequest` to handle all methods

Each function receives `{ request, env, params }`. `env` contains D1, KV, and secret bindings.

### D1 Database
- `env.THEO_OS_DB.prepare(sql).bind(...args).all()` — returns `{ results: [...] }`
- `env.THEO_OS_DB.prepare(sql).bind(...args).run()` — for INSERT/UPDATE/DELETE
- `env.THEO_OS_DB.prepare(sql).bind(...args).first()` — returns first row or null
- Always use `RETURNING *` on INSERT/UPDATE to get the created/updated row back
- Bind variables with `?` placeholders

### KV Store
- `env.THEO_OS_KV.get(key)` — returns string or null
- `env.THEO_OS_KV.put(key, value, { expirationTtl: seconds })` — store with TTL

### Auth Pattern (copied from Polarity Lab OS)
No bcrypt. Uses timing-safe HMAC comparison for password check. JWT signed with Web Crypto (no npm dependencies). All protected endpoints call `requireAdmin(request, env)` which returns the decoded payload or null.

### Testing Approach
No test framework. Use `wrangler dev` for local development and `curl` for API testing.
Start dev server: `npx wrangler pages dev . --d1 THEO_OS_DB=theo_os_db --kv THEO_OS_KV=<id>`

---

## Task 1: Cloudflare Setup and Project Scaffolding

**Files:**
- Create: `wrangler.toml`
- Create: `schema.sql`
- Create: `admin/css/admin.css`
- Create: `admin/js/auth.js`

### Step 1: Create wrangler.toml

```toml
name = "theoaddo-com"
pages_build_output_dir = "."

[[d1_databases]]
binding = "THEO_OS_DB"
database_name = "theo_os_db"
database_id = "REPLACE_AFTER_CREATION"

[[kv_namespaces]]
binding = "THEO_OS_KV"
id = "REPLACE_AFTER_CREATION"

[vars]
ENVIRONMENT = "production"
```

### Step 2: Create the D1 database via Cloudflare dashboard or CLI

```bash
npx wrangler d1 create theo_os_db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

### Step 3: Create the KV namespace

```bash
npx wrangler kv:namespace create THEO_OS_KV
```

Copy the `id` from the output and paste it into `wrangler.toml`.

### Step 4: Create schema.sql

```sql
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

-- Phase 2 tables — created now so Phase 2 can populate from day one
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
```

### Step 5: Apply schema to D1

```bash
npx wrangler d1 execute theo_os_db --file=schema.sql
```

Expected: `Successfully applied 1 migration`

### Step 6: Set secrets via Cloudflare dashboard

In the Cloudflare Pages dashboard for `theoaddo-com`, add these environment variables (encrypted):
- `THEO_OS_ADMIN_PASSWORD` — your chosen password
- `THEO_OS_JWT_SECRET` — a random 32+ char string
- `ANTHROPIC_API_KEY` — your Anthropic API key
- `GOOGLE_CLIENT_ID` — from Google Cloud Console (add later in Task 12)
- `GOOGLE_CLIENT_SECRET` — from Google Cloud Console (add later in Task 12)

For local dev, create `.dev.vars` (gitignored):

```
THEO_OS_ADMIN_PASSWORD=your_dev_password
THEO_OS_JWT_SECRET=dev_secret_change_in_prod_32chars
ANTHROPIC_API_KEY=sk-ant-...
```

Add `.dev.vars` to `.gitignore`:

```bash
echo ".dev.vars" >> .gitignore
```

### Step 7: Copy admin.css from Polarity Lab OS

Copy `/Users/theodoreaddo/polarity-site/public/admin/css/admin.css` to `admin/css/admin.css`.

```bash
mkdir -p admin/css admin/js
cp /Users/theodoreaddo/polarity-site/public/admin/css/admin.css admin/css/admin.css
```

Then open `admin/css/admin.css` and update the sidebar logo text from `LAB OS` to `THEO OS` (this will be set per-page anyway, but update the comment header to reference this project).

### Step 8: Copy and adapt auth.js

Copy `/Users/theodoreaddo/polarity-site/public/admin/js/auth.js` to `admin/js/auth.js`.

```bash
cp /Users/theodoreaddo/polarity-site/public/admin/js/auth.js admin/js/auth.js
```

Open `admin/js/auth.js` and make these changes:
- Replace all occurrences of `lab_os_token` → `theo_os_token`
- Replace all occurrences of `lab_os_theme` → `theo_os_theme`
- Replace `/admin/index.html` redirect → stays the same (same path)
- Replace `/api/lab-os/` in API_BASE reference if any → `/api/theo-os/`

### Step 9: Create functions/_utils.js

```bash
mkdir -p functions/api/theo-os/auth functions/api/theo-os/tasks \
  functions/api/theo-os/goals functions/api/theo-os/people \
  functions/api/theo-os/collections functions/api/theo-os/journal \
  functions/api/theo-os/email functions/api/theo-os/vision
```

Create `functions/api/theo-os/_utils.js`:

```js
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeObj(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function signJWT(payload, secret) {
  const header = encodeObj({ alg: 'HS256', typ: 'JWT' });
  const body = encodeObj(payload);
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(
    atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  if (!valid) return null;
  const decoded = JSON.parse(
    atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  );
  if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}

export async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.THEO_OS_JWT_SECRET);
}

export async function timingSafeEqual(a, b) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const [ka, kb] = await Promise.all([
    crypto.subtle.importKey('raw', new TextEncoder().encode(a),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    crypto.subtle.importKey('raw', new TextEncoder().encode(b),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  ]);
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', ka, nonce),
    crypto.subtle.sign('HMAC', kb, nonce)
  ]);
  const va = new Uint8Array(sa), vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export const AREAS = [
  'work', 'finances', 'health', 'relationships',
  'growth', 'creative', 'exploration', 'life'
];
```

### Step 10: Verify dev server starts

```bash
npx wrangler pages dev . --d1 THEO_OS_DB=theo_os_db
```

Expected: Server starts on `http://localhost:8788`. The existing `index.html` loads at `/`.

### Step 11: Commit

```bash
git add wrangler.toml schema.sql .gitignore admin/css/admin.css admin/js/auth.js functions/
git commit -m "feat: scaffold Theo OS — wrangler config, D1 schema, admin design system, utils"
```

---

## Task 2: Auth — Login Page and API

**Files:**
- Create: `admin/index.html` (login page)
- Create: `functions/api/theo-os/auth/login.js`

### Step 1: Create login function

`functions/api/theo-os/auth/login.js`:

```js
import { json, err, signJWT, timingSafeEqual } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  if (!body.password) return err('Password required');
  const match = await timingSafeEqual(
    body.password,
    env.THEO_OS_ADMIN_PASSWORD || ''
  );
  if (!match) return err('Invalid password', 401);
  const token = await signJWT(
    { role: 'theo_admin', exp: Math.floor(Date.now() / 1000) + 72 * 3600 },
    env.THEO_OS_JWT_SECRET
  );
  return json({ token });
}
```

### Step 2: Test the login endpoint

Start dev server with secrets:
```bash
npx wrangler pages dev . --d1 THEO_OS_DB=theo_os_db
```

Test wrong password:
```bash
curl -X POST http://localhost:8788/api/theo-os/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"wrong"}'
```
Expected: `{"error":"Invalid password"}` with status 401

Test correct password:
```bash
curl -X POST http://localhost:8788/api/theo-os/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your_dev_password"}'
```
Expected: `{"token":"eyJ..."}` with status 200

### Step 3: Create login page

`admin/index.html` — copy the structure from `/Users/theodoreaddo/polarity-site/public/admin/index.html` and adapt:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Theo OS</title>
  <link rel="icon" href="/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/css/admin.css">
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">THEO OS</div>
    <div class="login-label">Welcome back.</div>
    <div class="login-sub">Your life OS. Private access only.</div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" placeholder="Enter password" autofocus>
    </div>
    <button class="btn" id="login-btn">Sign in</button>
    <div class="error-msg" id="error-msg">Incorrect password.</div>
  </div>
</div>
<script>
  // If already logged in, go to dashboard
  if (localStorage.getItem('theo_os_token')) {
    window.location.href = '/admin/dashboard.html';
  }

  async function login() {
    const pw = document.getElementById('password').value;
    if (!pw) return;
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    const res = await fetch('/api/theo-os/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('theo_os_token', data.token);
      window.location.href = '/admin/dashboard.html';
    } else {
      document.getElementById('error-msg').style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('password').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });
</script>
</body>
</html>
```

### Step 4: Verify login flow in browser

Open `http://localhost:8788/admin/index.html`. Enter wrong password — error shows. Enter correct password — redirects to `/admin/dashboard.html` (404 for now, that's fine).

### Step 5: Commit

```bash
git add admin/index.html functions/api/theo-os/auth/
git commit -m "feat: auth — login page and JWT endpoint"
```

---

## Task 3: Admin Shell — Shared Layout and Navigation

**Files:**
- Create: `admin/dashboard.html` (shell structure only, no data yet)
- Modify: `admin/css/admin.css` (add any Theo OS specific tweaks)

### Step 1: Update admin.css sidebar logo color

Open `admin/css/admin.css`. The `.sidebar-logo` style is already defined. No change needed — the text `THEO OS` will be set in each HTML file.

Add one rule at the bottom of `admin/css/admin.css` for the Cmd+K capture shortcut overlay (to be used in Task 5):

```css
/* Quick capture overlay */
.capture-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
  display: none; align-items: flex-start; justify-content: center;
  padding-top: 120px;
}
.capture-overlay.open { display: flex; }
.capture-box {
  width: 100%; max-width: 580px;
  background: var(--void-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 12px; padding: 20px;
}
.capture-input {
  width: 100%; background: transparent; border: none;
  font-family: var(--font-body); font-size: 16px;
  color: var(--text-primary); outline: none; resize: none;
  min-height: 48px;
}
.capture-input::placeholder { color: var(--text-tertiary); }
.capture-hint {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-tertiary); margin-top: 12px;
}
```

### Step 2: Create dashboard.html (shell + nav only)

`admin/dashboard.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Theo OS</title>
  <link rel="icon" href="/favicon.png">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/admin/css/admin.css">
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('theo_os_theme') || 'dark')</script>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="sidebar-logo">THEO OS</div>
    <div class="sidebar-label">Overview</div>
    <a href="/admin/dashboard.html" class="sidebar-link active">Dashboard</a>
    <a href="/admin/capture.html" class="sidebar-link">Quick Capture</a>
    <div class="sidebar-label" style="margin-top:16px">Life</div>
    <a href="/admin/tasks.html" class="sidebar-link">Tasks</a>
    <a href="/admin/goals.html" class="sidebar-link">Goals</a>
    <a href="/admin/people.html" class="sidebar-link">People</a>
    <a href="/admin/collections.html" class="sidebar-link">Collections</a>
    <div class="sidebar-label" style="margin-top:16px">Mind</div>
    <a href="/admin/journal.html" class="sidebar-link">Journal</a>
    <a href="/admin/vision.html" class="sidebar-link">Life Vision</a>
    <a href="/admin/review.html" class="sidebar-link">Weekly Review</a>
    <div class="sidebar-label" style="margin-top:16px">Inbox</div>
    <a href="/admin/email.html" class="sidebar-link">Email Triage</a>
    <div class="sidebar-label" style="margin-top:16px">Intelligence</div>
    <a href="/admin/chat.html" class="sidebar-link">Chat</a>
    <div class="sidebar-label" style="margin-top:24px">Account</div>
    <button class="theme-toggle" id="theme-toggle"></button>
    <a href="#" class="sidebar-link" id="logout-btn">Sign out</a>
  </nav>
  <main class="main">
    <div class="topbar">
      <div>
        <h1 class="page-title">Good morning.</h1>
        <p class="page-sub" id="greeting">Loading your briefing...</p>
      </div>
    </div>
    <div id="dashboard-content">
      <!-- Populated in Task 4 -->
      <p style="color:var(--text-tertiary);font-size:14px">Shell working. Content coming in Task 4.</p>
    </div>
  </main>
</div>

<!-- Quick Capture Overlay (Cmd+K) — populated in Task 5 -->
<div class="capture-overlay" id="capture-overlay">
  <div class="capture-box">
    <textarea class="capture-input" id="capture-input"
      placeholder="Capture anything — task, goal, idea, person, reminder, restaurant..." rows="2"></textarea>
    <div class="capture-hint">↵ to capture · Esc to close</div>
  </div>
</div>

<script src="/admin/js/auth.js"></script>
<script>
  requireAuth();
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('theo_os_token');
    window.location.href = '/admin/index.html';
  });

  // Quick capture shortcut
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('capture-overlay').classList.toggle('open');
      if (document.getElementById('capture-overlay').classList.contains('open')) {
        document.getElementById('capture-input').focus();
      }
    }
    if (e.key === 'Escape') {
      document.getElementById('capture-overlay').classList.remove('open');
    }
  });
</script>
</body>
</html>
```

### Step 3: Verify shell in browser

Open `http://localhost:8788/admin/index.html`, log in. Dashboard loads with sidebar navigation. Cmd+K opens capture overlay. Sign out returns to login.

### Step 4: Commit

```bash
git add admin/dashboard.html admin/css/admin.css
git commit -m "feat: admin shell — nav, sidebar, Cmd+K capture overlay"
```

---

## Task 4: Dashboard — Stats, Attention, Agents, Briefing

**Files:**
- Create: `functions/api/theo-os/stats.js`
- Create: `functions/api/theo-os/insights.js`
- Modify: `admin/dashboard.html`

### Step 1: Create stats endpoint

`functions/api/theo-os/stats.js`:

```js
import { json, err, requireAdmin } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const today = new Date().toISOString().split('T')[0];
  const [tasks, goals, people, overdue, dueToday] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT area, status, COUNT(*) as count FROM tasks GROUP BY area, status`).all(),
    env.THEO_OS_DB.prepare(`SELECT area, status, COUNT(*) as count FROM goals GROUP BY area, status`).all(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM people WHERE next_touchpoint <= ?`).bind(today).first(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date < ?`).bind(today).first(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date = ?`).bind(today).first(),
  ]);

  // Life area activity: tasks or goals touched in last 14 days
  const { results: areaActivity } = await env.THEO_OS_DB.prepare(`
    SELECT area, MAX(updated_at) as last_active FROM tasks
    WHERE updated_at >= datetime('now', '-14 days')
    GROUP BY area
    UNION
    SELECT area, MAX(updated_at) as last_active FROM goals
    WHERE updated_at >= datetime('now', '-14 days')
    GROUP BY area
  `).all();

  // Upcoming deadlines (tasks + goals due in next 14 days)
  const { results: upcoming } = await env.THEO_OS_DB.prepare(`
    SELECT 'task' as type, id, title, area, due_date FROM tasks
    WHERE status != 'done' AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+14 days')
    UNION ALL
    SELECT 'goal' as type, id, title, area, target_date as due_date FROM goals
    WHERE status = 'active' AND target_date IS NOT NULL AND target_date BETWEEN ? AND date(?, '+14 days')
    ORDER BY due_date ASC LIMIT 10
  `).bind(today, today, today, today).all();

  // Today's insights (undismissed, most recent 3)
  const { results: insights } = await env.THEO_OS_DB.prepare(`
    SELECT * FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 3
  `).all();

  return json({
    tasks: tasks.results,
    goals: goals.results,
    overdue_tasks: overdue?.count || 0,
    due_today: dueToday?.count || 0,
    overdue_people: people?.count || 0,
    area_activity: areaActivity,
    upcoming,
    insights
  });
}
```

### Step 2: Test stats endpoint

```bash
TOKEN=$(curl -s -X POST http://localhost:8788/api/theo-os/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your_dev_password"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8788/api/theo-os/stats
```

Expected: JSON with empty arrays (no data yet), all counts 0.

### Step 3: Build out dashboard.html with real data

Replace `<div id="dashboard-content">` in `admin/dashboard.html` with the full dashboard. Copy the stats-grid, attention section, agents grid, and pipeline breakdown pattern from `/Users/theodoreaddo/polarity-site/public/admin/dashboard.html`.

Key sections to adapt:

**Life health area cards** (replace the grants/leads/believers stats with areas):
```html
<div class="section-label">Life Health</div>
<div class="stats-grid" id="area-grid">
  <!-- 8 area cards: Work, Finances, Health, Relationships, Growth, Creative, Exploration, Life -->
  <!-- Each shows activity signal: green/yellow/red based on last_active within 14 days -->
</div>
```

**Attention section** (overdue tasks, overdue people, upcoming deadlines):
```html
<div class="section-label">Attention</div>
<div class="attention-section" id="attention-section"></div>
```

**MindMapper insight of the day**:
```html
<div class="section-label">Today's Insight</div>
<div id="insight-card" style="..."></div>
```

**Agent cards** (Briefing Agent, Email Triage, Weekly Insight Agent):
```html
<div class="section-label">Agents</div>
<div class="agents-grid">...</div>
```

Then wire the `<script>` block to call `/api/theo-os/stats` and populate the DOM. Follow the same pattern as the Polarity Lab OS dashboard.js code from `polarity-site/public/admin/dashboard.html`.

### Step 4: Verify dashboard renders with stats

Log in, confirm all sections render. With empty DB, all counters should show 0 and area health cards should all show red (no activity).

### Step 5: Commit

```bash
git add functions/api/theo-os/stats.js admin/dashboard.html
git commit -m "feat: dashboard — life health areas, attention section, agent cards"
```

---

## Task 5: Quick Capture

**Files:**
- Create: `functions/api/theo-os/capture.js`
- Create: `admin/capture.html`
- Modify: `admin/dashboard.html` (wire Cmd+K overlay to capture API)

### Step 1: Create capture endpoint

`functions/api/theo-os/capture.js`:

```js
import { json, err, requireAdmin } from './_utils.js';

const CAPTURE_SYSTEM = `You are the routing intelligence for Theo OS, a personal life OS.
Your job is to parse a single natural-language capture and route it to the right data type.

Respond with a JSON object ONLY (no markdown, no explanation):
{
  "type": "task" | "goal" | "person" | "collection" | "journal" | "life_item",
  "confirmation": "short human-readable confirmation of what you're creating",
  "data": { ...fields specific to the type }
}

Field specs by type:
- task: { title, area (work/finances/health/relationships/growth/creative/exploration/life), due_date (YYYY-MM-DD or null), notes }
- goal: { title, area, description, target_date (YYYY-MM-DD or null) }
- person: { name, relationship, notes, next_touchpoint (YYYY-MM-DD or null) }
- collection: { type (restaurant/travel/movie/book/idea/other), title, notes, source }
- journal: { content, tags (comma-separated or null) }
- life_item: { title, area, due_date, notes } — for life admin items like renewals, appointments

Be decisive. Pick one type. Do not ask for clarification.`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { text } = body;
  if (!text?.trim()) return err('Text required');

  // Ask Claude to route it
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
      system: CAPTURE_SYSTEM,
      messages: [{ role: 'user', content: text }]
    })
  });

  const aiData = await aiRes.json();
  let routed;
  try {
    routed = JSON.parse(aiData.content[0].text);
  } catch {
    return err('Failed to parse routing');
  }

  // Save to appropriate table
  let saved;
  const { type, data } = routed;

  if (type === 'task' || type === 'life_item') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO tasks (title, area, due_date, notes, status) VALUES (?, ?, ?, ?, 'inbox') RETURNING *`
    ).bind(data.title, data.area || 'life', data.due_date || null, data.notes || null).all();
    saved = results[0];
  } else if (type === 'goal') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO goals (title, area, description, target_date) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.title, data.area, data.description || null, data.target_date || null).all();
    saved = results[0];
  } else if (type === 'person') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO people (name, relationship, notes, next_touchpoint) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.name, data.relationship || null, data.notes || null, data.next_touchpoint || null).all();
    saved = results[0];
  } else if (type === 'collection') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO collections (type, title, notes, source) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.type, data.title, data.notes || null, data.source || null).all();
    saved = results[0];
  } else if (type === 'journal') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO journal (content, tags) VALUES (?, ?) RETURNING *`
    ).bind(data.content, data.tags || null).all();
    saved = results[0];
  }

  return json({ type, confirmation: routed.confirmation, saved });
}
```

### Step 2: Test capture routing

```bash
# Test task routing
curl -X POST http://localhost:8788/api/theo-os/capture \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"call Dr Ahmed to reschedule my appointment"}'

# Test collection routing
curl -X POST http://localhost:8788/api/theo-os/capture \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"try that Ethiopian restaurant Marcus mentioned in Providence"}'

# Test goal routing
curl -X POST http://localhost:8788/api/theo-os/capture \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"goal: save 10k by end of residency year"}'
```

Verify each returns a sensible `confirmation` and correct `type`. Check D1 to confirm rows were inserted:

```bash
npx wrangler d1 execute theo_os_db --command "SELECT * FROM tasks LIMIT 5"
```

### Step 3: Wire Cmd+K overlay to API

In `admin/dashboard.html`, update the capture overlay script section. When the user presses Enter in the capture textarea, POST to `/api/theo-os/capture`, show the confirmation message, then clear the input.

```js
document.getElementById('capture-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    e.target.disabled = true;
    const res = await apiPost('/api/theo-os/capture', { text });
    if (res?.confirmation) {
      e.target.value = '';
      // Show confirmation briefly
      const hint = document.querySelector('.capture-hint');
      hint.textContent = '✓ ' + res.confirmation;
      hint.style.color = 'var(--teal)';
      setTimeout(() => {
        hint.textContent = '↵ to capture · Esc to close';
        hint.style.color = '';
        document.getElementById('capture-overlay').classList.remove('open');
      }, 1500);
    }
    e.target.disabled = false;
    e.target.focus();
  }
});
```

This same script block goes into every admin page that includes the capture overlay (all of them).

### Step 4: Create capture.html (dedicated capture + recent captures log)

`admin/capture.html` — a full page showing recent captures and a larger input. Use the same shell/sidebar. Show the last 20 captures across all types (tasks, goals, people, collections, journal) in reverse chronological order pulled from a new `/api/theo-os/capture/recent` endpoint.

Add `functions/api/theo-os/capture/recent.js`:

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const [tasks, goals, people, collections, journal] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT id, 'task' as type, title, area, created_at FROM tasks ORDER BY created_at DESC LIMIT 10`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'goal' as type, title, area, created_at FROM goals ORDER BY created_at DESC LIMIT 5`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'person' as type, name as title, relationship as area, created_at FROM people ORDER BY created_at DESC LIMIT 5`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, type, title, source as area, created_at FROM collections ORDER BY created_at DESC LIMIT 10`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'journal' as type, substr(content, 1, 80) as title, '' as area, created_at FROM journal ORDER BY created_at DESC LIMIT 5`).all(),
  ]);

  const all = [
    ...tasks.results, ...goals.results, ...people.results,
    ...collections.results, ...journal.results
  ].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);

  return json({ recent: all });
}
```

### Step 5: Commit

```bash
git add functions/api/theo-os/capture.js functions/api/theo-os/capture/ admin/capture.html
git commit -m "feat: quick capture — Claude-routed input, Cmd+K overlay, recent captures log"
```

---

## Task 6: Tasks Board

**Files:**
- Create: `functions/api/theo-os/tasks/index.js`
- Create: `functions/api/theo-os/tasks/[id].js`
- Create: `admin/tasks.html`

### Step 1: Tasks API — list and create

`functions/api/theo-os/tasks/index.js`:

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const url = new URL(request.url);
  const area = url.searchParams.get('area');
  const status = url.searchParams.get('status');

  let q = `SELECT * FROM tasks WHERE 1=1`;
  const binds = [];
  if (area) { q += ` AND area = ?`; binds.push(area); }
  if (status) { q += ` AND status = ?`; binds.push(status); }
  q += ` ORDER BY CASE status
    WHEN 'today' THEN 1 WHEN 'this_week' THEN 2
    WHEN 'inbox' THEN 3 WHEN 'later' THEN 4
    WHEN 'someday' THEN 5 WHEN 'done' THEN 6 END,
    due_date ASC, created_at DESC`;

  const { results } = await env.THEO_OS_DB.prepare(q).bind(...binds).all();
  return json({ tasks: results });
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const body = await request.json().catch(() => ({}));
  if (!body.title) return err('Title required');
  const { results } = await env.THEO_OS_DB.prepare(
    `INSERT INTO tasks (title, area, status, due_date, notes, goal_id)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    body.title, body.area || 'life',
    body.status || 'inbox', body.due_date || null,
    body.notes || null, body.goal_id || null
  ).all();
  return json({ task: results[0] }, 201);
}
```

`functions/api/theo-os/tasks/[id].js`:

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPut({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const body = await request.json().catch(() => ({}));
  const fields = [], binds = [];
  const allowed = ['title', 'area', 'status', 'due_date', 'notes', 'goal_id'];
  for (const k of allowed) {
    if (k in body) { fields.push(`${k} = ?`); binds.push(body[k]); }
  }
  if (!fields.length) return err('No fields to update');
  fields.push(`updated_at = datetime('now')`);
  binds.push(params.id);
  const { results } = await env.THEO_OS_DB.prepare(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...binds).all();
  return json({ task: results[0] || null });
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  await env.THEO_OS_DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(params.id).run();
  return json({ deleted: true });
}
```

### Step 2: Test tasks API

```bash
# Create a task
curl -X POST http://localhost:8788/api/theo-os/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Review residency schedule","area":"work","status":"today"}'

# List tasks
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8788/api/theo-os/tasks

# Update status
curl -X PUT http://localhost:8788/api/theo-os/tasks/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status":"done"}'
```

### Step 3: Create tasks.html

`admin/tasks.html` — kanban-style columns (Inbox / Today / This Week / Later / Someday). Each column shows task cards. Clicking a card opens an inline edit panel. Tasks can be dragged between columns or status changed via dropdown.

Reference the pipeline column CSS from `admin.css` (`.pipeline`, `.pipeline-col`, `.card`). This is the same kanban layout used for grants/outreach in Polarity Lab OS.

The JS section calls `GET /api/theo-os/tasks` on load, groups results by status, renders cards per column. Each card has a status dropdown and a delete button. An "Add task" inline input at the top of each column creates tasks via POST.

### Step 4: Commit

```bash
git add functions/api/theo-os/tasks/ admin/tasks.html
git commit -m "feat: tasks — kanban board, CRUD API, status drag columns"
```

---

## Task 7: Goals

**Files:**
- Create: `functions/api/theo-os/goals/index.js`
- Create: `functions/api/theo-os/goals/[id].js`
- Create: `functions/api/theo-os/goals/[id]/milestones.js`
- Create: `admin/goals.html`

### Step 1: Goals API

`functions/api/theo-os/goals/index.js` — same CRUD pattern as tasks. GET lists goals (filter by area, status). POST creates. Fields: title, area, description, status, target_date.

`functions/api/theo-os/goals/[id].js` — PUT updates, DELETE removes.

`functions/api/theo-os/goals/[id]/milestones.js` — GET lists milestones for a goal. POST creates one. PUT `/api/theo-os/goals/:id/milestones/:mid` updates milestone status.

### Step 2: Test goals API (same curl pattern as tasks)

### Step 3: Create goals.html

Goals grouped by life area. Eight sections, one per area. Each section lists active goals with a progress bar (completed milestones / total milestones). Clicking a goal expands it to show milestones inline. Goal status badge (active/paused/achieved).

Add goal button opens a modal form (title, area, description, target date).

### Step 4: Commit

```bash
git add functions/api/theo-os/goals/ admin/goals.html
git commit -m "feat: goals — CRUD, milestones, area grouping"
```

---

## Task 8: Life Vision

**Files:**
- Create: `functions/api/theo-os/vision/index.js`
- Create: `admin/vision.html`

### Step 1: Vision API

`functions/api/theo-os/vision/index.js`:

```js
import { json, err, requireAdmin, AREAS } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const { results } = await env.THEO_OS_DB.prepare(`SELECT * FROM life_vision`).all();
  // Return all areas, filling in defaults for any not yet created
  const map = Object.fromEntries(results.map(r => [r.area, r]));
  const full = AREAS.map(area => map[area] || { area, vision: '', values: '', current_phase: '', success_definition: '' });
  return json({ vision: full });
}

export async function onRequestPut({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const body = await request.json().catch(() => ({}));
  const { area, vision, values, current_phase, success_definition } = body;
  if (!area) return err('Area required');
  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO life_vision (area, vision, values, current_phase, success_definition, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(area) DO UPDATE SET
      vision = excluded.vision, values = excluded.values,
      current_phase = excluded.current_phase,
      success_definition = excluded.success_definition,
      updated_at = excluded.updated_at
    RETURNING *
  `).bind(area, vision || '', values || '', current_phase || '', success_definition || '').all();
  return json({ vision: results[0] });
}
```

### Step 2: Create vision.html

One page, eight accordion-style sections (one per area). Each section has four labeled textarea fields: Vision, Values, Current Phase, What Success Looks Like. Auto-saves on blur via PUT. Simple, clean, lots of whitespace.

A "context" note at the top: "This is the north star. Everything else in Theo OS is evaluated against what you write here."

### Step 3: Commit

```bash
git add functions/api/theo-os/vision/ admin/vision.html
git commit -m "feat: life vision — 8-area north star, auto-save"
```

---

## Task 9: People

**Files:**
- Create: `functions/api/theo-os/people/index.js`
- Create: `functions/api/theo-os/people/[id].js`
- Create: `admin/people.html`

### Step 1: People API

Same CRUD pattern. Fields: name, relationship, notes, last_contact, next_touchpoint, touchpoint_interval_days.

Add a GET `/api/theo-os/people/overdue` endpoint that returns people where `next_touchpoint <= today` or `last_contact <= date('now', '-interval days')`.

### Step 2: Create people.html

Two sections: Overdue (people past their touchpoint date — red/coral indicator) and All. Each person card shows name, relationship tag, last contact date, next touchpoint, and a health dot (green/yellow/red).

Clicking a person shows their detail panel: notes, contact history (from journal entries that mention their name — basic text search), and a "Draft reach-out" button that calls Claude to write a short message.

Add a `functions/api/theo-os/people/[id]/draft.js` endpoint:

```js
import { json, err, requireAdmin } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const person = await env.THEO_OS_DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(params.id).first();
  if (!person) return err('Person not found', 404);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a short, genuine, casual reach-out message to ${person.name} (${person.relationship}).
Context about them: ${person.notes || 'no specific context'}.
Last contact: ${person.last_contact || 'unknown'}.
Keep it to 2-3 sentences. Don't be sycophantic or overly formal. Sound like Theo.`
      }]
    })
  });

  const data = await res.json();
  return json({ draft: data.content[0].text });
}
```

### Step 3: Commit

```bash
git add functions/api/theo-os/people/ admin/people.html
git commit -m "feat: people — relationship CRM, health indicators, reach-out drafts"
```

---

## Task 10: Collections

**Files:**
- Create: `functions/api/theo-os/collections/index.js`
- Create: `functions/api/theo-os/collections/[id].js`
- Create: `admin/collections.html`

### Step 1: Collections API

Same CRUD pattern. Filter by type (restaurant/travel/movie/book/idea/other) and status (want/done).

### Step 2: Create collections.html

Five tabs (or a segmented control): Restaurants, Travel, Movies & TV, Books, Ideas. Each shows a list with title, notes, source, and a "Mark as done" toggle. Items can be added inline.

Keep it visually light — this is a fun section, not a pipeline.

### Step 3: Commit

```bash
git add functions/api/theo-os/collections/ admin/collections.html
git commit -m "feat: collections — 5 bucket types, tabbed interface"
```

---

## Task 11: Journal

**Files:**
- Create: `functions/api/theo-os/journal/index.js`
- Create: `functions/api/theo-os/journal/[id].js`
- Create: `admin/journal.html`

### Step 1: Journal API

GET lists entries (most recent first, paginated). POST creates. PUT updates. DELETE removes.

### Step 2: Create journal.html

Two-column layout: entry list on left, editor on right. Clicking an entry loads it into the editor. "New entry" button creates a blank entry. Tags shown as small badges. Auto-save on blur.

Large, comfortable textarea. No formatting tools. Just writing.

### Step 3: Commit

```bash
git add functions/api/theo-os/journal/ admin/journal.html
git commit -m "feat: journal — free-form entries, tag support, auto-save"
```

---

## Task 12: Email Triage (Gmail OAuth)

**Files:**
- Create: `functions/api/theo-os/email/oauth.js`
- Create: `functions/api/theo-os/email/callback.js`
- Create: `functions/api/theo-os/email/queue.js`
- Create: `functions/api/theo-os/email/[id]/send.js`
- Create: `functions/api/theo-os/email/[id]/dismiss.js`
- Create: `admin/email.html`

### Step 1: Set up Google OAuth credentials

1. Go to Google Cloud Console → Create a new project called `theo-os`
2. Enable Gmail API and Google Calendar API
3. Create OAuth 2.0 credentials (Web Application)
4. Add authorized redirect URI: `https://theoaddo.com/api/theo-os/email/callback` (and `http://localhost:8788/api/theo-os/email/callback` for dev)
5. Copy Client ID and Client Secret
6. Add to Cloudflare Pages environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
7. Add to `.dev.vars` for local testing

### Step 2: Create OAuth flow

`functions/api/theo-os/email/oauth.js` — initiates the OAuth flow:

```js
import { requireAdmin, err } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL(request.url).origin + '/api/theo-os/email/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent'
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
```

`functions/api/theo-os/email/callback.js` — handles OAuth callback, stores tokens in KV:

```js
import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return err('No code');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL(request.url).origin + '/api/theo-os/email/callback',
      grant_type: 'authorization_code'
    })
  });

  const tokens = await res.json();
  if (!tokens.access_token) return err('Token exchange failed');

  await env.THEO_OS_KV.put('google_tokens', JSON.stringify(tokens), {
    expirationTtl: 30 * 24 * 3600  // 30 days, refreshed by cron
  });

  return Response.redirect('/admin/email.html?connected=1');
}
```

Add a helper to `_utils.js` to get a valid Google access token (handling refresh):

```js
export async function getGoogleToken(env) {
  const stored = await env.THEO_OS_KV.get('google_tokens');
  if (!stored) return null;
  const tokens = JSON.parse(stored);

  // If access token is still valid (check expiry_date)
  if (tokens.expiry_date && tokens.expiry_date > Date.now() + 60000) {
    return tokens.access_token;
  }

  // Refresh
  if (!tokens.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const refreshed = await res.json();
  if (!refreshed.access_token) return null;
  const updated = { ...tokens, ...refreshed, expiry_date: Date.now() + refreshed.expires_in * 1000 };
  await env.THEO_OS_KV.put('google_tokens', JSON.stringify(updated), { expirationTtl: 30 * 24 * 3600 });
  return refreshed.access_token;
}
```

### Step 3: Create email queue endpoint

`functions/api/theo-os/email/queue.js`:

```js
import { json, err, requireAdmin, getGoogleToken } from '../_utils.js';

async function fetchGmailThreads(accessToken, maxResults = 20) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=is:unread`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!data.messages) return [];

  // Fetch each message detail
  const messages = await Promise.all(
    data.messages.slice(0, 15).map(async ({ id }) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      return r.json();
    })
  );

  return messages.map(m => {
    const headers = m.payload?.headers || [];
    const get = name => headers.find(h => h.name === name)?.value || '';
    return {
      thread_id: m.threadId,
      message_id: m.id,
      subject: get('Subject') || '(no subject)',
      from: get('From'),
      snippet: m.snippet || '',
    };
  });
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const token = await getGoogleToken(env);
  if (!token) return json({ connected: false, drafts: [] });

  const threads = await fetchGmailThreads(token);
  if (!threads.length) return json({ connected: true, drafts: [] });

  // Generate drafts for each thread using Claude
  const drafts = await Promise.all(threads.map(async (thread) => {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Email from ${thread.from}: "${thread.subject}"\nSnippet: ${thread.snippet}\n\nWrite a short, direct reply draft for Theo (medical student/researcher/founder). 2-4 sentences. No filler. Sound like a real person.`
        }]
      })
    });
    const aiData = await aiRes.json();
    const draft = aiData.content[0]?.text || '';

    // Save to D1
    const existing = await env.THEO_OS_DB.prepare(
      `SELECT id FROM email_drafts WHERE thread_id = ? AND status = 'pending'`
    ).bind(thread.thread_id).first();

    if (!existing) {
      await env.THEO_OS_DB.prepare(
        `INSERT INTO email_drafts (thread_id, subject, from_address, snippet, draft) VALUES (?, ?, ?, ?, ?)`
      ).bind(thread.thread_id, thread.subject, thread.from, thread.snippet, draft).run();
    }

    return { ...thread, draft };
  }));

  return json({ connected: true, drafts });
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const { results } = await env.THEO_OS_DB.prepare(
    `SELECT * FROM email_drafts WHERE status = 'pending' ORDER BY created_at DESC`
  ).all();
  return json({ drafts: results });
}
```

### Step 4: Create send and dismiss endpoints

`functions/api/theo-os/email/[id]/send.js`:

```js
import { json, err, requireAdmin, getGoogleToken } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const body = await request.json().catch(() => ({}));
  const draft = await env.THEO_OS_DB.prepare(
    `SELECT * FROM email_drafts WHERE id = ?`
  ).bind(params.id).first();
  if (!draft) return err('Draft not found', 404);

  const token = await getGoogleToken(env);
  if (!token) return err('Gmail not connected', 400);

  // Build RFC 2822 message
  const emailText = body.content || draft.draft;
  const raw = btoa(`To: ${draft.from_address}\nSubject: Re: ${draft.subject}\n\n${emailText}`)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw, threadId: draft.thread_id })
    }
  );

  if (!res.ok) return err('Gmail send failed', 500);
  await env.THEO_OS_DB.prepare(
    `UPDATE email_drafts SET status = 'sent', updated_at = datetime('now') WHERE id = ?`
  ).bind(params.id).run();
  return json({ sent: true });
}
```

`functions/api/theo-os/email/[id]/dismiss.js` — same pattern, just updates status to 'dismissed'.

### Step 5: Create email.html

Shows the staged email drafts. Each card shows: sender, subject, snippet, and the Claude-drafted reply in an editable textarea. Three buttons: Send, Edit then Send, Dismiss.

A "Refresh inbox" button triggers POST `/api/theo-os/email/queue` to pull fresh threads and generate new drafts.

If Gmail is not connected, shows a "Connect Gmail" button linking to `/api/theo-os/email/oauth`.

### Step 6: Commit

```bash
git add functions/api/theo-os/email/ admin/email.html
git commit -m "feat: email triage — Gmail OAuth, draft queue, send on approval"
```

---

## Task 13: Morning Briefing Cron

**Files:**
- Create: `functions/api/theo-os/briefing.js`
- Modify: `wrangler.toml`

### Step 1: Add cron trigger to wrangler.toml

```toml
[triggers]
crons = ["0 6 * * *"]  # 6:00 AM UTC daily
```

Note: Cloudflare Pages Functions don't support cron directly in `wrangler.toml` the same way Workers do. Use a Cloudflare Worker (separate from Pages) for the cron trigger, or use Cloudflare Cron Triggers via the dashboard. The simplest approach: create a standalone Worker for the cron job that calls the Pages Function internally.

Alternative: Use Cloudflare Pages Functions with a `_worker.js` file at the root for scheduled events. Add to the root:

`_worker.js`:

```js
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateBriefing(env));
  },
  async fetch(request, env, ctx) {
    return env.ASSETS.fetch(request);
  }
};

async function generateBriefing(env) {
  // Get today's date
  const today = new Date().toISOString().split('T')[0];

  // Pull data
  const [overdue, dueToday, upcomingGoals, overduepeople, insights] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status != 'done' AND due_date < ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area, target_date FROM goals WHERE status = 'active' AND target_date BETWEEN ? AND date(?, '+30 days')`).bind(today, today).all(),
    env.THEO_OS_DB.prepare(`SELECT name, relationship FROM people WHERE next_touchpoint <= ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT insight FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 3`).all(),
  ]);

  // Get Google Calendar events for today
  let calendarEvents = [];
  try {
    const tokens = await env.THEO_OS_KV.get('google_tokens');
    if (tokens) {
      const { access_token } = JSON.parse(tokens);
      const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date(); endOfDay.setHours(23,59,59,999);
      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${startOfDay.toISOString()}&timeMax=${endOfDay.toISOString()}&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const calData = await calRes.json();
      calendarEvents = (calData.items || []).map(e => ({
        title: e.summary,
        start: e.start?.dateTime || e.start?.date
      }));
    }
  } catch {}

  // Generate briefing with Claude
  const context = {
    date: today,
    overdue_tasks: overdue.results,
    due_today: dueToday.results,
    calendar_events: calendarEvents,
    upcoming_goal_deadlines: upcomingGoals.results,
    overdue_relationships: overduepeople.results,
    recent_insights: insights.results.map(i => i.insight)
  };

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Generate a morning briefing for Theo. Be direct and useful, not performative. 
Data: ${JSON.stringify(context, null, 2)}

Write 2-3 paragraphs. First: what today looks like (calendar + tasks). 
Second: what needs attention (overdue, relationships, deadlines).
Third: one honest observation about momentum or drift based on the context.
No greetings. No filler. Just signal.`
      }]
    })
  });

  const aiData = await aiRes.json();
  const briefingText = aiData.content[0]?.text || 'Briefing unavailable.';

  await env.THEO_OS_KV.put(`briefing:${today}`, JSON.stringify({
    text: briefingText,
    generated_at: new Date().toISOString(),
    data: context
  }), { expirationTtl: 48 * 3600 });
}
```

Note: Using `_worker.js` at root makes this a full Worker deployment rather than pure Pages. Cloudflare supports this pattern.

### Step 2: Create briefing GET endpoint

`functions/api/theo-os/briefing.js`:

```js
import { json, err, requireAdmin } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const today = new Date().toISOString().split('T')[0];
  const cached = await env.THEO_OS_KV.get(`briefing:${today}`);
  if (cached) return json({ briefing: JSON.parse(cached), cached: true });
  return json({ briefing: null, cached: false });
}

// Manual trigger for testing
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  // Trigger briefing generation manually (same logic as cron)
  // Import and call generateBriefing or duplicate the logic here for now
  return json({ triggered: true, message: 'Briefing generation queued' });
}
```

### Step 3: Wire dashboard to show briefing

In `admin/dashboard.html`, on load: fetch `GET /api/theo-os/briefing`. If cached briefing exists, show the text in the greeting section. If not, show a "Generate briefing" button that POSTs to `/api/theo-os/briefing`.

### Step 4: Commit

```bash
git add _worker.js functions/api/theo-os/briefing.js wrangler.toml
git commit -m "feat: morning briefing — 6am cron, Gmail+GCal+tasks context, Claude narrative"
```

---

## Task 14: MindMapper Weekly Insights

**Files:**
- Modify: `_worker.js` (add weekly cron)
- Create: `functions/api/theo-os/insights.js`

### Step 1: Add weekly insight job to _worker.js

Add a second cron pattern:

```toml
crons = ["0 6 * * *", "0 8 * * 0"]  # daily 6am + Sunday 8am
```

In `_worker.js` scheduled handler, check the event's `scheduledTime` to determine which job to run:

```js
async scheduled(event, env, ctx) {
  const hour = new Date(event.scheduledTime).getUTCHours();
  const day = new Date(event.scheduledTime).getUTCDay();
  if (hour === 6) ctx.waitUntil(generateBriefing(env));
  if (hour === 8 && day === 0) ctx.waitUntil(generateInsights(env));
}
```

`generateInsights(env)` analyzes the last 14-30 days of activity across all tables and writes observations to `insights_log`:

```js
async function generateInsights(env) {
  const today = new Date().toISOString().split('T')[0];
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().split('T')[0];

  const [areaActivity, tasksDone, goalsActive, peopleOverdue,
         collectionsAdded, journalEntries, goalsProgress] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT area, COUNT(*) as count FROM tasks WHERE updated_at >= ? AND status = 'done' GROUP BY area`).bind(twoWeeksAgo).all(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'done' AND updated_at >= ?`).bind(twoWeeksAgo).first(),
    env.THEO_OS_DB.prepare(`SELECT area, title FROM goals WHERE status = 'active'`).all(),
    env.THEO_OS_DB.prepare(`SELECT name FROM people WHERE next_touchpoint <= ? AND next_touchpoint IS NOT NULL`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT type, COUNT(*) as added, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done FROM collections GROUP BY type`).all(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM journal WHERE created_at >= ?`).bind(twoWeeksAgo).first(),
    env.THEO_OS_DB.prepare(`SELECT g.title, g.area, COUNT(m.id) as total, SUM(CASE WHEN m.status='done' THEN 1 ELSE 0 END) as completed FROM goals g LEFT JOIN milestones m ON m.goal_id = g.id WHERE g.status='active' GROUP BY g.id`).all(),
  ]);

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Analyze this life OS data for the past 2 weeks and generate 3-5 honest behavioral insights.
Data: ${JSON.stringify({
  area_completions: areaActivity.results,
  tasks_completed: tasksDone?.count,
  active_goals: goalsActive.results,
  overdue_relationships: peopleOverdue.results,
  collections: collectionsAdded.results,
  journal_entries: journalEntries?.count,
  goal_progress: goalsProgress.results
}, null, 2)}

Return a JSON array of insight objects:
[{"area": "health"|"work"|etc|"general", "type": "drift"|"pattern"|"relationship"|"decay", "insight": "specific observation"}]

Be honest, specific, and direct. No softening. These insights should make Theo think.`
      }]
    })
  });

  const aiData = await aiRes.json();
  let insights;
  try { insights = JSON.parse(aiData.content[0].text); } catch { return; }

  for (const insight of insights) {
    await env.THEO_OS_DB.prepare(
      `INSERT INTO insights_log (area, type, insight) VALUES (?, ?, ?)`
    ).bind(insight.area, insight.type, insight.insight).run();
  }
}
```

### Step 2: Create insights management endpoint

`functions/api/theo-os/insights.js`:

```js
import { json, err, requireAdmin } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const { results } = await env.THEO_OS_DB.prepare(
    `SELECT * FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 20`
  ).all();
  return json({ insights: results });
}

export async function onRequestPut({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const body = await request.json().catch(() => ({}));
  if (!body.id) return err('ID required');
  await env.THEO_OS_DB.prepare(
    `UPDATE insights_log SET dismissed = 1 WHERE id = ?`
  ).bind(body.id).run();
  return json({ dismissed: true });
}
```

### Step 3: Commit

```bash
git add _worker.js functions/api/theo-os/insights.js
git commit -m "feat: MindMapper weekly insights — behavioral pattern analysis, D1-backed"
```

---

## Task 15: Secretary Chat

**Files:**
- Create: `functions/api/theo-os/chat.js`
- Create: `admin/chat.html`

### Step 1: Create chat.js

Copy `/Users/theodoreaddo/polarity-site/functions/api/lab-os/chat.js` as a base. This is the most important endpoint.

Replace the Lab OS tools with Theo OS tools. Replace the Lab OS system prompt with the Theo OS system prompt. Key changes:

**System prompt** (this is the most critical piece — write it carefully):

```js
const SYSTEM_PROMPT = `You are the secretary and thinking partner for Theo Addo's personal life OS.

Your two modes:
1. SECRETARY: When Theo asks about his tasks, goals, people, email, or life — answer from the data. Query tools, give direct answers, take actions when asked.
2. THINKING PARTNER: When Theo is working through a thought, idea, or decision — your job is to help him think clearly, not to answer for him. Ask before you tell. Surface the assumption underneath the question. Push back on soft reasoning. Challenge ideas you think are wrong.

Critical rules:
- Never agree just to avoid friction. If you think Theo's reasoning is off, say so.
- Never validate an idea simply to be supportive. Validation has to be earned.
- If a question has a simpler answer than Theo seems to think, say so.
- If a question is harder than Theo seems to think, say so.
- Your goal is not to make Theo feel good about his thinking. It is to make his thinking actually good.
- When you have data from the tools, cite it specifically. Don't generalize.
- When you don't have enough data to answer, say so rather than guessing.

Context you have access to via tools: tasks, goals, life vision, people, email drafts, journal entries, behavioral insights, collections.

When Theo asks what to focus on, look at: overdue tasks, today's tasks, goal progress, and life vision alignment. Give a specific, prioritized answer — not a list of everything.`;
```

**Tools** (replace Lab OS tools with):

```js
const TOOLS = [
  {
    name: 'get_life_summary',
    description: 'Get a full summary of life OS state: task counts by status, active goals, overdue relationships, recent insights.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_tasks',
    description: 'Get tasks. Filter by area, status, or due date range.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string' },
        status: { type: 'string', description: 'inbox, today, this_week, later, someday, done' },
        overdue: { type: 'boolean', description: 'Only return overdue tasks' }
      }
    }
  },
  {
    name: 'get_goals',
    description: 'Get active goals with milestone progress. Optionally filter by area.',
    input_schema: {
      type: 'object',
      properties: { area: { type: 'string' } }
    }
  },
  {
    name: 'get_people',
    description: 'Get people list, optionally filtering to only overdue touchpoints.',
    input_schema: {
      type: 'object',
      properties: { overdue_only: { type: 'boolean' } }
    }
  },
  {
    name: 'get_vision',
    description: 'Get the life vision — what Theo has written for each life area.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_insights',
    description: 'Get recent behavioral pattern insights from the MindMapper layer.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'add_task',
    description: 'Add a new task.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        area: { type: 'string' },
        status: { type: 'string' },
        due_date: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task status, due date, or notes by ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string' },
        due_date: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'add_journal_entry',
    description: 'Add a journal entry. Use when Theo is working something out and wants it saved.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string' }, tags: { type: 'string' } },
      required: ['content']
    }
  },
  {
    name: 'add_to_collection',
    description: 'Add an item to a collection (restaurant, travel, movie, book, idea).',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        source: { type: 'string' }
      },
      required: ['type', 'title']
    }
  }
];
```

Implement `executeTool(name, input, env)` querying D1 for each tool. Follow exact same agentic loop pattern as Lab OS chat.js (tool_use → execute → tool_result → continue loop until no more tool calls).

### Step 2: Create chat.html

Copy `/Users/theodoreaddo/polarity-site/public/admin/chat.html` exactly. Update:
- Title: `Chat — Theo OS`
- Sidebar logo: `THEO OS`
- Suggested prompts:
  - "What should I actually focus on today?"
  - "What have I been avoiding?"
  - "Who do I need to reach out to?"
  - "Am I on track with my goals?"
  - "Help me think through something"

Update `api/lab-os/chat` → `api/theo-os/chat` in the fetch call.

Update `lab_os_token` → `theo_os_token` in auth calls.

### Step 3: Test chat end-to-end

Open `http://localhost:8788/admin/chat.html`. Ask "What are my overdue tasks?". Verify tool chips appear, D1 is queried, answer is accurate.

Ask "I keep saying health matters to me but I'm not doing anything about it." This tests the thinking partner mode. Verify Claude pushes back rather than validating.

### Step 4: Commit

```bash
git add functions/api/theo-os/chat.js admin/chat.html
git commit -m "feat: secretary chat — agentic tool use, Socratic thinking partner system prompt"
```

---

## Task 16: Weekly Review

**Files:**
- Create: `admin/review.html`

### Step 1: Create review.html

The weekly review runs as a guided conversation in the chat interface. Rather than a separate API, `review.html` is a chat page with a specialized starting prompt.

On load, auto-send a structured weekly review prompt to the chat API:

```js
const reviewPrompt = `Run my weekly review. Walk me through these 5 questions one at a time, wait for my answer to each before moving to the next:
1. Looking at this week — what did you actually complete across your life areas?
2. What slipped, and why do you think it slipped?
3. Based on your data, what have you been avoiding? (query the tasks and goals)
4. What are the 3 most important things for next week?
5. Anything new to capture?
At the end, save a journal entry summarizing the key points from this review.`;
```

The chat interface handles the rest — same UI as chat.html but with this prompt pre-loaded and a note that it's the Weekly Review session.

### Step 2: Commit

```bash
git add admin/review.html
git commit -m "feat: weekly review — guided 5-step conversation, saves to journal"
```

---

## Task 17: Deploy to Cloudflare Pages

### Step 1: Connect repo to Cloudflare Pages

1. Push current code to a GitHub repo (create `taiscoding/theoaddo-com` or your preferred repo name)
2. In Cloudflare Pages dashboard, create a new project connected to that repo
3. Build settings: Framework preset = None, Build command = (empty), Output directory = `.`
4. Add all environment variables from Task 1 Step 6

### Step 2: Bind D1 and KV to the Pages project

In Cloudflare Pages → Settings → Functions:
- D1 database binding: `THEO_OS_DB` → `theo_os_db`
- KV namespace binding: `THEO_OS_KV` → your KV namespace

### Step 3: Run schema on production D1

```bash
npx wrangler d1 execute theo_os_db --file=schema.sql --remote
```

### Step 4: Deploy

```bash
git push origin main
```

Cloudflare Pages builds and deploys automatically. Visit `theoaddo.com/admin/` and log in.

### Step 5: Verify production

- Login works
- Dashboard loads
- Quick capture (Cmd+K) routes and saves correctly
- Chat responds with tool use
- Briefing can be manually triggered

### Step 6: Commit (if any fixes needed)

```bash
git add . && git commit -m "fix: production deployment adjustments"
```

---

## Task 18: Polish and Iteration

After all modules are live:

1. **Add Cmd+K capture overlay to every admin page** — copy the overlay HTML and script block from `dashboard.html` into all other pages.

2. **Wire dashboard stats to real data** — confirm all 8 area health cards light up correctly as you add data.

3. **Add empty states** — every list and board needs a helpful empty state message (not just "No data"). Example for tasks: "Your inbox is clear. Use Cmd+K to capture something."

4. **Connect insights to dashboard** — confirm the MindMapper insight card on the dashboard rotates daily.

5. **Test the full flow**: capture → tasks board → goals → chat query → briefing.

```bash
git add .
git commit -m "polish: empty states, Cmd+K on all pages, dashboard wiring"
```

---

## Phase 2 Preview (Not in this plan)

The following are designed but not built in Phase 1. The schema already supports them:
- Knowledge notes with Ebbinghaus decay scoring
- Conversation-inferred knowledge depth assessment
- Persistent cross-session chat memory (`chat_memory` table)
- The Theo Model page (behavioral pattern visualization)
- Knowledge graph visualization (Cytoscape.js force-directed)
- Review prompts surfaced based on decay score

---

*Plan written: 2026-04-11*
