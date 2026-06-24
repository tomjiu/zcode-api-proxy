/**
 * Bun.serve server setup with routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { errorResponse } from "../proxy/handler.js";
import { MODELS } from "../provider/models.js";

interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
}

/** Request metrics tracker */
const metrics = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  startTime: Date.now(),
  recentLogs: [] as Array<{ time: string; method: string; model: string; durationMs: number; success: boolean; error?: string }>,

  record(success: boolean, method: string, model: string, durationMs: number, error?: string) {
    this.totalRequests++;
    if (success) this.successRequests++;
    else this.errorRequests++;
    this.recentLogs.unshift({ time: new Date().toISOString(), method, model, durationMs, success, error: error || undefined });
    if (this.recentLogs.length > 50) this.recentLogs.pop();
  },

  getStats() {
    return {
      uptime: Date.now() - this.startTime,
      totalRequests: this.totalRequests,
      successRequests: this.successRequests,
      errorRequests: this.errorRequests,
      successRate: this.totalRequests > 0 ? (this.successRequests / this.totalRequests * 100).toFixed(1) + "%" : "N/A",
    };
  },
};

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // Dashboard (no auth required for viewing)
    if (path === "/" || path === "/dashboard") {
      return new Response(getDashboardHTML(config, metrics), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Static files
    if (path.startsWith("/static/")) {
      return serveStaticFile(path);
    }

    // Proxy API key auth (if configured)
    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }

    // --- Routing ---

    // OpenAI routes
    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels();
    }

    // Anthropic routes
    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok", provider: config.provider }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // API status
    if (path === "/api/status" && method === "GET") {
      return jsonResponse(200, {
        status: "ok",
        provider: config.provider,
        plan: config.plan,
        metrics: metrics.getStats(),
        models: MODELS.map(m => m.id),
      });
    }

    // Account management API
    if (path === "/api/accounts" && method === "GET") {
      return handleListAccounts();
    }
    if (path === "/api/accounts" && method === "POST") {
      return handleAddAccount(req);
    }
    if (path.match(/^\/api\/accounts\/[^/]+$/) && method === "DELETE") {
      const id = path.split("/").pop()!;
      return handleDeleteAccount(id);
    }
    if (path.match(/^\/api\/accounts\/[^/]+\/status$/) && method === "POST") {
      const id = path.split("/")[3];
      return handleUpdateAccountStatus(req, id);
    }
    if (path === "/api/accounts/quota" && method === "GET") {
      return handleRefreshQuota();
    }
    if (path === "/api/settings" && method === "GET") {
      return handleGetSettings();
    }
    if (path === "/api/settings" && method === "POST") {
      return handleUpdateSettings(req);
    }

    // OAuth login flow
    if (path === "/api/oauth/init" && method === "POST") {
      return handleOAuthInit();
    }
    if (path === "/api/oauth/poll" && method === "POST") {
      return handleOAuthPoll(req);
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(opts);
  const { port, host } = opts.config.server;

  return Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // 自用代理：禁用空闲超时，避免长 reasoning 的 LLM 请求被杀
    fetch(req) {
      // Add CORS headers to all responses
      return handler(req).then((resp) => addCorsHeaders(resp));
    },
  });
}

/** Check whether the client provided the correct proxy API key. */
function checkProxyKey(authHeader: string, expected: string): boolean {
  // Accept "Bearer {key}" or bare key
  const trimmed = authHeader.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim() === expected;
  }
  // Also accept x-api-key: {key}
  return trimmed === expected;
}

/** Build a CORS preflight response. */
function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
  };
}

/** JSON response helper */
function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Serve static files */
function serveStaticFile(path: string): Response {
  try {
    const { readFileSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const filePath = join(__dirname, "statics", path.replace("/static/", ""));
    if (!existsSync(filePath)) {
      return new Response("Not Found", { status: 404 });
    }
    const content = readFileSync(filePath);
    const ext = path.split(".").pop() || "";
    const contentTypes: Record<string, string> = {
      css: "text/css",
      js: "application/javascript",
      html: "text/html",
      png: "image/png",
      jpg: "image/jpeg",
      svg: "image/svg+xml",
    };
    return new Response(content, {
      headers: { "content-type": contentTypes[ext] || "application/octet-stream" },
    });
  } catch {
    return new Response("Internal Error", { status: 500 });
  }
}

/** Format uptime */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

/** Dashboard HTML */
function getDashboardHTML(config: ProxyConfig, metrics: { getStats: () => { uptime: number; totalRequests: number; successRequests: number; errorRequests: number; successRate: string }; recentLogs: Array<{ time: string; method: string; model: string; durationMs: number; success: boolean; error?: string }> }): string {
  const stats = metrics.getStats();
  const accStats = getStats();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZCode Proxy Dashboard</title>
  <link href="/static/css/app.css" rel="stylesheet">
</head>
<body>
<div class="admin-header">
  <div class="admin-header-inner">
    <div class="admin-brand-wrap">
      <div class="admin-brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        ZCode Proxy
      </div>
    </div>
    <div class="admin-nav">
      <a class="admin-nav-link active" href="/">Dashboard</a>
    </div>
    <div class="admin-header-right">
      <span class="admin-header-version">v2.0</span>
    </div>
  </div>
</div>

<main class="admin-main">
  <div class="page-hd">
    <div>
      <div class="page-title">Account Pool</div>
      <div class="page-sub">Multi-account rotation · Auto-switch when quota exhausted · Real-time monitoring</div>
    </div>
    <div class="page-actions">
      <span class="live-dot">Live monitoring</span>
      <button onclick="refreshAllQuota()" class="page-action-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.6"/><path d="M20 20v-5h-5"/></svg>
        Refresh Quota
      </button>
      <button onclick="openAddModal(); switchAddTab('login')" class="page-action-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        OAuth Login
      </button>
      <button onclick="openAddModal(); switchAddTab('paste')" class="page-action-btn page-action-btn-primary">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Account
      </button>
    </div>
  </div>

  <div class="section-head"><div class="section-title">Account Overview</div></div>
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">Total Accounts</div><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4"/><circle cx="12" cy="8" r="4"/></svg></span></div><div class="stat-num" id="s-total">${accStats.total}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">Active</div><span class="stat-icon" style="color:#16a34a"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.4 2.4 4.8-4.8"/></svg></span></div><div class="stat-num" id="s-active" style="color:#16a34a">${accStats.active}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">Requests</div><span class="stat-icon" style="color:#4c9168"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg></span></div><div class="stat-num" id="s-requests" style="color:#4c9168">${stats.totalRequests}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">Success Rate</div><span class="stat-icon" style="color:#16a34a"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M12 2v20M2 12h20"/></svg></span></div><div class="stat-num" id="s-rate" style="color:#16a34a">${stats.successRate}</div></div>
  </div>

  <div class="section-head">
    <div class="section-title">Account Details <span class="section-count-badge" id="tbl-count">0</span></div>
    <div class="section-meta" id="last-updated"></div>
  </div>

  <div class="table-card">
    <table>
      <thead><tr>
        <th>Email</th>
        <th class="table-center" style="width:80px">Status</th>
        <th style="min-width:220px">Quota</th>
        <th class="table-center" style="width:60px">Requests</th>
        <th class="table-center" style="width:60px">Errors</th>
        <th style="width:120px">Last Used</th>
        <th style="width:120px">Actions</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <div class="section-head"><div class="section-title">API Endpoints</div></div>
  <div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:16px">
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">POST</span> /v1/chat/completions — OpenAI Chat</div>
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">POST</span> /v1/messages — Anthropic Messages</div>
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">GET</span> /v1/models — Model List</div>
    <div style="font-family:monospace;font-size:13px"><span style="color:#4c76b2;font-weight:bold">GET</span> /api/status — API Status</div>
  </div>

  <div class="section-head"><div class="section-title">Recent Requests</div></div>
  <div class="table-card">
    <table>
      <thead><tr><th>Time</th><th>Method</th><th>Model</th><th>Duration</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>
        ${metrics.recentLogs.slice(0, 20).map(log => `<tr>
          <td>${new Date(log.time).toLocaleTimeString()}</td>
          <td><span class="badge badge-${log.method === 'openai' ? 'jwt' : 'apiKey'}">${log.method}</span></td>
          <td>${log.model}</td>
          <td>${log.durationMs}ms</td>
          <td>${log.success ? '<span style="color:#16a34a">✓</span>' : '<span style="color:#dc2626">✗</span>'}</td>
          <td style="font-size:11px;color:#9a9a9a">${log.error ? log.error.slice(0, 50) : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</main>

<!-- Add Account Modal -->
<div class="modal-overlay" id="modal-add">
  <div class="modal">
    <div class="modal-title">Add Account</div>
    <div class="filter-bar" style="margin-bottom:16px">
      <button class="filter-chip active" id="tab-paste" onclick="switchAddTab('paste')">Paste Token</button>
      <button class="filter-chip" id="tab-login" onclick="switchAddTab('login')">OAuth Login</button>
    </div>

    <!-- Paste Token -->
    <div id="add-pane-paste">
      <div class="dialog-body">
        <div>
          <div class="dialog-help">Paste JWT token or API Key</div>
          <textarea class="input" id="add-jwt" rows="5" placeholder="Paste JWT token here..."></textarea>
        </div>
        <div class="dialog-field">
          <span class="dialog-label">Email</span>
          <input class="input" id="add-email" placeholder="user@example.com (optional)">
        </div>
      </div>
      <div class="dialog-actions">
        <button onclick="closeModal('modal-add')" class="dialog-btn">Cancel</button>
        <button onclick="doAddAccount()" class="dialog-btn dialog-btn-primary">Add</button>
      </div>
    </div>

    <!-- OAuth Login -->
    <div id="add-pane-login" style="display:none">
      <div class="dialog-body">
        <div class="dialog-help">Login via Z.AI OAuth to get JWT token with Coding Plan quota.</div>
        <div id="login-idle">
          <button onclick="startOAuthLogin()" id="login-start-btn" class="dialog-btn dialog-btn-primary w-full" style="height:40px">Start Login</button>
        </div>
        <div id="login-active" style="display:none">
          <div class="dialog-help" style="margin-bottom:6px">Open this URL in browser to authorize:</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="input" id="login-url" readonly style="font-size:12px">
            <button onclick="copyLoginUrl()" class="dialog-btn">Copy</button>
            <button onclick="openLoginUrl()" class="dialog-btn dialog-btn-primary">Open</button>
          </div>
          <div class="live-dot" id="login-status" style="margin-top:16px">Waiting for authorization...</div>
        </div>
      </div>
      <div class="dialog-actions">
        <button onclick="cancelOAuthLogin()" class="dialog-btn">Close</button>
      </div>
    </div>
  </div>
</div>

<!-- Toast container -->
<div class="toast-container" id="toast-container"></div>

<script src="/static/js/toast.js"></script>
<script>
const API_KEY = '${config.auth.proxyApiKey || ""}';
const apiHeaders = API_KEY ? {'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json'} : {'Content-Type': 'application/json'};

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts', { headers: apiHeaders });
    const data = await res.json();
    renderAccounts(data.accounts || []);
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Failed to load accounts:', e);
  }
}

function renderAccounts(accounts) {
  document.getElementById('tbl-count').textContent = accounts.length;
  const tbody = document.getElementById('tbody');
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No accounts. Click "Add Account" to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => {
    const glm52 = a.quota_details?.find(q => q.model === 'GLM-5.2');
    const glm5turbo = a.quota_details?.find(q => q.model === 'GLM-5-Turbo');
    const statusClass = a.status === 'active' ? 'active' : (a.status === 'paused' ? 'disabled' : 'invalid');
    return '<tr>' +
      '<td><span class="tok">' + (a.email || a.id.slice(0, 12)) + '</span></td>' +
      '<td class="table-center"><span class="badge badge-' + statusClass + '">' + a.status + '</span></td>' +
      '<td>' + quotaCell(glm52, glm5turbo) + '</td>' +
      '<td class="table-center" style="color:#8f8f8f">' + a.requests + '</td>' +
      '<td class="table-center" style="color:#9a9a9a">' + a.errors + '</td>' +
      '<td style="font-size:12px;color:#9a9a9a">' + (a.last_used_at ? new Date(a.last_used_at).toLocaleString() : '—') + '</td>' +
      '<td><div class="row-actions">' +
        '<button onclick="toggleAccount(\\'' + a.id + '\\',\\'' + a.status + '\\')" class="row-icon-btn" title="' + (a.status === 'active' ? 'Pause' : 'Resume') + '">' +
          (a.status === 'active' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M8.5 8.5 15.5 15.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.708"/><path d="M3 4v5h5"/></svg>') +
        '</button>' +
        '<button onclick="deleteAccount(\\'' + a.id + '\\')" class="row-icon-btn row-icon-danger" title="Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M8 10v7"/><path d="M12 10v7"/><path d="M16 10v7"/><path d="M7 7l1 13h8l1-13"/></svg></button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

function quotaCell(glm52, glm5turbo) {
  let html = '<div class="quota-rows">';
  if (glm52) {
    const pct = glm52.total > 0 ? Math.max(0, Math.min(100, Math.round(glm52.remaining / glm52.total * 100))) : 0;
    const color = glm52.remaining <= 0 ? '#c9c9cf' : (pct < 15 ? '#b0632a' : '#4c9168');
    html += '<div class="quota-row"><span class="quota-row-name">5.2</span><span class="quota-row-track"><span class="quota-row-fill" style="width:' + pct + '%;background:' + color + '"></span></span><span class="quota-row-val">' + fmt(glm52.remaining) + ' / ' + fmt(glm52.total) + '</span></div>';
  }
  if (glm5turbo) {
    const pct = glm5turbo.total > 0 ? Math.max(0, Math.min(100, Math.round(glm5turbo.remaining / glm5turbo.total * 100))) : 0;
    const color = glm5turbo.remaining <= 0 ? '#c9c9cf' : (pct < 15 ? '#b0632a' : '#4c9168');
    html += '<div class="quota-row"><span class="quota-row-name">5-Turbo</span><span class="quota-row-track"><span class="quota-row-fill" style="width:' + pct + '%;background:' + color + '"></span></span><span class="quota-row-val">' + fmt(glm5turbo.remaining) + ' / ' + fmt(glm5turbo.total) + '</span></div>';
  }
  if (!glm52 && !glm5turbo) return '<span class="quota-empty">No quota data</span>';
  return html + '</div>';
}

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openAddModal() { openModal('modal-add'); }

function switchAddTab(tab) {
  document.getElementById('tab-paste').className = 'filter-chip' + (tab === 'paste' ? ' active' : '');
  document.getElementById('tab-login').className = 'filter-chip' + (tab === 'login' ? ' active' : '');
  document.getElementById('add-pane-paste').style.display = tab === 'paste' ? 'block' : 'none';
  document.getElementById('add-pane-login').style.display = tab === 'login' ? 'block' : 'none';
}

// OAuth Login
let oauthFlowId = '';
let oauthPolling = false;

async function startOAuthLogin() {
  try {
    const res = await fetch('/api/oauth/init', { method: 'POST', headers: apiHeaders });
    const data = await res.json();
    if (data.ok) {
      oauthFlowId = data.flow_id;
      document.getElementById('login-idle').style.display = 'none';
      document.getElementById('login-active').style.display = 'block';
      document.getElementById('login-url').value = data.authorize_url;
      oauthPolling = true;
      startOAuthPoll();
    } else {
      showToast('OAuth init failed: ' + (data.error || 'unknown'), 'error');
    }
  } catch (e) {
    showToast('OAuth init failed: ' + e.message, 'error');
  }
}

async function startOAuthPoll() {
  while (oauthPolling && oauthFlowId) {
    await new Promise(r => setTimeout(r, 2000));
    if (!oauthPolling) break;
    try {
      const res = await fetch('/api/oauth/poll', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ flow_id: oauthFlowId }) });
      const data = await res.json();
      if (data.ok && data.status === 'ready') {
        oauthPolling = false;
        showToast('Login successful! Account added.', 'success');
        closeModal('modal-add');
        loadAccounts();
        resetOAuthLogin();
        return;
      } else if (data.error) {
        oauthPolling = false;
        showToast('OAuth error: ' + data.error, 'error');
        resetOAuthLogin();
        return;
      }
    } catch (e) {
      // Network error, continue polling
    }
  }
}

function cancelOAuthLogin() {
  oauthPolling = false;
  resetOAuthLogin();
  closeModal('modal-add');
}

function resetOAuthLogin() {
  oauthFlowId = '';
  oauthPolling = false;
  document.getElementById('login-idle').style.display = 'block';
  document.getElementById('login-active').style.display = 'none';
}

function copyLoginUrl() {
  const url = document.getElementById('login-url').value;
  navigator.clipboard.writeText(url);
  showToast('URL copied to clipboard', 'success');
}

function openLoginUrl() {
  const url = document.getElementById('login-url').value;
  window.open(url, '_blank');
}

async function doAddAccount() {
  const jwt = document.getElementById('add-jwt').value.trim();
  const email = document.getElementById('add-email').value.trim();
  if (!jwt) return showToast('JWT token required', 'error');
  try {
    const res = await fetch('/api/accounts', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ zcode_jwt: jwt, email: email || undefined }) });
    const data = await res.json();
    if (data.ok) { closeModal('modal-add'); loadAccounts(); showToast('Account added successfully', 'success'); }
    else { showToast('Error: ' + (data.error || 'unknown'), 'error'); }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function deleteAccount(id) {
  if (!confirm('Delete this account?')) return;
  await fetch('/api/accounts/' + id, { method: 'DELETE', headers: apiHeaders });
  loadAccounts();
  showToast('Account deleted', 'success');
}

async function toggleAccount(id, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  await fetch('/api/accounts/' + id + '/status', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ status: newStatus }) });
  loadAccounts();
  showToast('Account status updated', 'success');
}

async function refreshAllQuota() {
  showToast('Refreshing quota...', 'info');
  await fetch('/api/accounts/quota', { headers: apiHeaders });
  loadAccounts();
  showToast('Quota refreshed', 'success');
}

loadAccounts();
setInterval(loadAccounts, 10000);
</script>
</body></html>`;
}

// ─── Account Management Handlers ──────────────────────────────────────────────

import { listAccounts, addAccount, deleteAccount, updateAccount, getSettings, updateSettings, getStats } from "./account-manager.js";

function handleListAccounts(): Response {
  const accounts = listAccounts();
  const stats = getStats();
  return jsonResponse(200, { accounts, stats });
}

async function handleAddAccount(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    if (!body.zcode_jwt && !body.api_key) {
      return jsonResponse(400, { error: "missing zcode_jwt or api_key" });
    }
    const account = addAccount(body);
    return jsonResponse(201, { ok: true, account });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

function handleDeleteAccount(id: string): Response {
  const ok = deleteAccount(id);
  return jsonResponse(ok ? 200 : 404, { ok });
}

async function handleUpdateAccountStatus(req: Request, id: string): Promise<Response> {
  try {
    const body = await req.json() as any;
    const account = updateAccount(id, { status: body.status });
    if (!account) return jsonResponse(404, { error: "account not found" });
    return jsonResponse(200, { ok: true, account });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

async function handleRefreshQuota(): Promise<Response> {
  // TODO: implement quota refresh
  return jsonResponse(200, { ok: true, message: "quota refresh not implemented yet" });
}

function handleGetSettings(): Response {
  return jsonResponse(200, { ok: true, settings: getSettings() });
}

async function handleUpdateSettings(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    updateSettings(body);
    return jsonResponse(200, { ok: true, settings: getSettings() });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

// ─── OAuth Handlers ───────────────────────────────────────────────────────────

import { initCliOAuth, pollCliOAuth, activatePlan, getBalance } from "./oauth.js";

// Store active OAuth flows
const oauthFlows = new Map<string, { pollToken: string; expiresAt: number }>();

async function handleOAuthInit(): Promise<Response> {
  try {
    const result = await initCliOAuth();
    oauthFlows.set(result.flow_id, { pollToken: result.poll_token, expiresAt: result.expires_at * 1000 });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

async function handleOAuthPoll(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    const { flow_id } = body;
    const flow = oauthFlows.get(flow_id);
    if (!flow) {
      return jsonResponse(400, { error: "flow not found or expired" });
    }

    const result = await pollCliOAuth(flow_id, flow.pollToken);

    if (result.status === "ready" && result.jwt) {
      // Activate plan and get quota
      try {
        await activatePlan(result.jwt);
      } catch (e) {
        console.error("Plan activation failed:", (e as Error).message);
      }

      // Add account
      const account = addAccount({
        zcode_jwt: result.jwt,
        oauth_access_token: result.oauth_access_token,
        user_id: result.user_id,
        email: result.email,
        label: result.email || result.name || "oauth",
      });

      oauthFlows.delete(flow_id);

      return jsonResponse(200, {
        ok: true,
        status: "ready",
        account_id: account.id,
        email: account.email,
      });
    }

    return jsonResponse(200, { ok: true, status: result.status, pending: result.status === "pending" });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}
