// admin/js/auth.js
const API_BASE = '';

// Theme
function getTheme() { return localStorage.getItem('theo_os_theme') || 'dark'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theo_os_theme', t);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.innerHTML = t === 'dark' ? themeIcon('light') : themeIcon('dark');
}
function themeIcon(next) {
  return next === 'light'
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg> Light`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg> Dark`;
}
function toggleTheme() { applyTheme(getTheme() === 'dark' ? 'light' : 'dark'); }
function initIOSZoomFix() {
  // iOS Safari keeps zoom level after input blur — reset viewport to snap back
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  document.addEventListener('focusout', () => {
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1';
    requestAnimationFrame(() => {
      meta.content = 'width=device-width, initial-scale=1';
    });
  });
}

function initMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  const btn = document.createElement('button');
  btn.className = 'menu-toggle';
  btn.setAttribute('aria-label', 'Open menu');
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  document.body.appendChild(btn);

  const close = () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); };
  btn.addEventListener('click', () => { sidebar.classList.toggle('open'); overlay.classList.toggle('open'); });
  overlay.addEventListener('click', close);
  sidebar.querySelectorAll('.sidebar-link').forEach(l => l.addEventListener('click', close));
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getTheme());
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  initMobileSidebar();
  initIOSZoomFix();
});

function getToken() {
  return localStorage.getItem('theo_os_token');
}

function setToken(token) {
  localStorage.setItem('theo_os_token', token);
}

function clearToken() {
  localStorage.removeItem('theo_os_token');
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`
  };
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) { clearToken(); window.location.href = '/admin/index.html'; return null; }
  if (!res.ok) return null;
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body)
  });
  if (res.status === 401) { clearToken(); window.location.href = '/admin/index.html'; return null; }
  if (!res.ok) {
    try {
      const errBody = await res.json();
      apiPost._lastError = errBody.error || JSON.stringify(errBody) || `HTTP ${res.status}`;
    } catch { apiPost._lastError = `HTTP ${res.status}`; }
    return null;
  }
  apiPost._lastError = null;
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify(body)
  });
  if (res.status === 401) { clearToken(); window.location.href = '/admin/index.html'; return null; }
  if (!res.ok) return null;
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body)
  });
  if (res.status === 401) { clearToken(); window.location.href = '/admin/index.html'; return null; }
  if (!res.ok) {
    try { apiPatch._lastError = (await res.json()).error || `HTTP ${res.status}`; } catch { apiPatch._lastError = `HTTP ${res.status}`; }
    return null;
  }
  apiPatch._lastError = null;
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) { clearToken(); window.location.href = '/admin/index.html'; return null; }
  return res.ok;
}

function requireAuth() {
  if (!getToken()) window.location.href = '/admin/index.html';
}
