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
<html><head>
<meta charset="utf-8">
<title>ZCode Proxy Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
  h1{font-size:24px;margin-bottom:24px;color:#38bdf8}
  h2{font-size:18px;margin:24px 0 12px;color:#cbd5e1}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
  .card{background:#1e293b;border-radius:8px;padding:16px}
  .card .label{font-size:12px;color:#94a3b8;text-transform:uppercase}
  .card .value{font-size:28px;font-weight:bold;margin-top:4px}
  .good{color:#4ade80}.warn{color:#fbbf24}.bad{color:#f87171}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #334155;font-size:13px}
  th{color:#94a3b8;font-weight:500;font-size:12px;text-transform:uppercase}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px}
  .badge-openai{background:#166534;color:#4ade80}
  .badge-anthropic{background:#854d0e;color:#fbbf24}
  .badge-active{background:#166534;color:#4ade80}
  .badge-paused{background:#854d0e;color:#fbbf24}
  .badge-error{background:#991b1b;color:#f87171}
  .endpoint{background:#1e293b;border-radius:8px;padding:12px 16px;margin-bottom:8px;font-family:monospace;font-size:13px}
  .endpoint .method{color:#38bdf8;font-weight:bold}
  button{background:#38bdf8;color:#0f172a;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px}
  button:hover{background:#7dd3fc}
  button.btn-danger{background:#ef4444}
  button.btn-danger:hover{background:#dc2626}
  button.btn-success{background:#22c55e}
  button.btn-success:hover{background:#16a34a}
  .modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center}
  .modal.active{display:flex}
  .modal-content{background:#1e293b;border-radius:12px;padding:24px;max-width:500px;width:90%}
  .modal-title{font-size:18px;font-weight:bold;margin-bottom:16px;color:#38bdf8}
  input,textarea,select{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;width:100%;margin-bottom:12px}
  textarea{min-height:100px;resize:vertical}
  .form-group{margin-bottom:12px}
  .form-label{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px}
  .form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .quota-bar{height:6px;border-radius:3px;background:#334155;margin-top:4px;overflow:hidden}
  .quota-bar-fill{height:100%;border-radius:3px;transition:width 0.3s}
</style>
</head><body>
<h1>ZCode Proxy Dashboard</h1>

<div class="grid">
  <div class="card"><div class="label">Uptime</div><div class="value">${formatUptime(stats.uptime)}</div></div>
  <div class="card"><div class="label">Requests</div><div class="value">${stats.totalRequests}</div></div>
  <div class="card"><div class="label">Success Rate</div><div class="value good">${stats.successRate}</div></div>
  <div class="card"><div class="label">Accounts</div><div class="value">${accStats.active}<span style="font-size:14px;color:#94a3b8">/${accStats.total}</span></div></div>
</div>

<h2>Account Pool
  <button onclick="openAddModal()" style="float:right;font-size:13px">+ Add Account</button>
  <button onclick="refreshAllQuota()" style="float:right;margin-right:8px;font-size:13px;background:#8b5cf6">Refresh Quota</button>
</h2>
<table>
  <tr><th>Email</th><th>Status</th><th>GLM-5.2</th><th>GLM-5-Turbo</th><th>Requests</th><th>Errors</th><th>Actions</th></tr>
  <tbody id="accounts-body"></tbody>
</table>

<h2>Configuration</h2>
<div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px">
  <p style="margin-bottom:8px"><strong>Plan:</strong> ${config.plan}</p>
  <p style="margin-bottom:8px"><strong>Provider:</strong> ${config.provider}</p>
  <p><strong>Default Model:</strong> ${config.defaultModel}</p>
</div>

<h2>API Endpoints</h2>
<div class="endpoint"><span class="method">POST</span> /v1/chat/completions — OpenAI Chat</div>
<div class="endpoint"><span class="method">POST</span> /v1/messages — Anthropic Messages</div>
<div class="endpoint"><span class="method">GET</span> /v1/models — Model List</div>
<div class="endpoint"><span class="method">GET</span> /api/accounts — Account List</div>
<div class="endpoint"><span class="method">POST</span> /api/accounts — Add Account</div>

<h2>Recent Requests</h2>
<table>
  <tr><th>Time</th><th>Method</th><th>Model</th><th>Duration</th><th>Status</th><th>Error</th></tr>
  ${metrics.recentLogs.slice(0, 20).map(log => `<tr>
    <td>${new Date(log.time).toLocaleTimeString()}</td>
    <td><span class="badge badge-${log.method}">${log.method}</span></td>
    <td>${log.model}</td>
    <td>${log.durationMs}ms</td>
    <td>${log.success ? '<span style="color:#4ade80">✓</span>' : '<span style="color:#f87171">✗</span>'}</td>
    <td style="font-size:11px;color:#94a3b8">${log.error ? log.error.slice(0, 50) : '—'}</td>
  </tr>`).join('')}
</table>

<!-- Add Account Modal -->
<div class="modal" id="add-modal">
  <div class="modal-content">
    <div class="modal-title">Add Account</div>
    <div class="form-group">
      <label class="form-label">JWT Token</label>
      <textarea id="add-jwt" placeholder="Paste JWT token here..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Email (optional)</label>
      <input id="add-email" placeholder="user@example.com">
    </div>
    <div class="form-actions">
      <button onclick="closeAddModal()">Cancel</button>
      <button onclick="doAddAccount()" class="btn-success">Add</button>
    </div>
  </div>
</div>

<script>
const API_KEY = '${config.auth.proxyApiKey || ""}';
const headers = API_KEY ? {'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json'} : {'Content-Type': 'application/json'};

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts', { headers });
    const data = await res.json();
    renderAccounts(data.accounts || []);
  } catch (e) {
    console.error('Failed to load accounts:', e);
  }
}

function renderAccounts(accounts) {
  const tbody = document.getElementById('accounts-body');
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8">No accounts. Click "Add Account" to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => {
    const glm52 = a.quota_details?.find(q => q.model === 'GLM-5.2');
    const glm5turbo = a.quota_details?.find(q => q.model === 'GLM-5-Turbo');
    return '<tr>' +
      '<td>' + (a.email || a.id.slice(0, 8)) + '</td>' +
      '<td><span class="badge badge-' + a.status + '">' + a.status + '</span></td>' +
      '<td>' + (glm52 ? '<div class="quota-bar"><div class="quota-bar-fill" style="width:' + Math.round(glm52.remaining/glm52.total*100) + '%"></div></div><small>' + (glm52.remaining/1000).toFixed(0) + 'k</small>' : '—') + '</td>' +
      '<td>' + (glm5turbo ? '<div class="quota-bar"><div class="quota-bar-fill" style="width:' + Math.round(glm5turbo.remaining/glm5turbo.total*100) + '%"></div></div><small>' + (glm5turbo.remaining/1000).toFixed(0) + 'k</small>' : '—') + '</td>' +
      '<td>' + a.requests + '</td>' +
      '<td>' + a.errors + '</td>' +
      '<td>' +
        '<button onclick="toggleAccount(\\'' + a.id + '\\',\\'' + a.status + '\\')" style="padding:2px 8px;font-size:11px">' + (a.status === 'active' ? 'Pause' : 'Resume') + '</button> ' +
        '<button onclick="deleteAccount(\\'' + a.id + '\\')" class="btn-danger" style="padding:2px 8px;font-size:11px">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function openAddModal() { document.getElementById('add-modal').classList.add('active'); }
function closeAddModal() { document.getElementById('add-modal').classList.remove('active'); }

async function doAddAccount() {
  const jwt = document.getElementById('add-jwt').value.trim();
  const email = document.getElementById('add-email').value.trim();
  if (!jwt) return alert('JWT token required');
  try {
    const res = await fetch('/api/accounts', { method: 'POST', headers, body: JSON.stringify({ zcode_jwt: jwt, email: email || undefined }) });
    const data = await res.json();
    if (data.ok) { closeAddModal(); loadAccounts(); } else { alert('Error: ' + (data.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteAccount(id) {
  if (!confirm('Delete this account?')) return;
  await fetch('/api/accounts/' + id, { method: 'DELETE', headers });
  loadAccounts();
}

async function toggleAccount(id, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  await fetch('/api/accounts/' + id + '/status', { method: 'POST', headers, body: JSON.stringify({ status: newStatus }) });
  loadAccounts();
}

async function refreshAllQuota() {
  await fetch('/api/accounts/quota', { headers });
  loadAccounts();
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
