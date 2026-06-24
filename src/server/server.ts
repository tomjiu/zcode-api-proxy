/**
 * Bun.serve server setup with routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponses } from "./routes-responses.js";
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
    if (path === "/v1/responses" && method === "POST") {
      return handleResponses(req, proxyOpts);
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

    // Import/Export
    if (path === "/api/accounts/import" && method === "POST") {
      return handleImportAccounts(req);
    }
    if (path === "/api/accounts/export" && method === "GET") {
      return handleExportAccounts(req);
    }

    // Batch operations
    if (path === "/api/accounts/batch" && method === "POST") {
      return handleBatchAccounts(req);
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
  <link href="static/css/app.css" rel="stylesheet">
</head>
<body>
<div class="admin-header">
  <div class="admin-header-inner">
    <div class="admin-brand-wrap">
      <div class="admin-brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        ZCode 代理
      </div>
    </div>
    <div class="admin-nav">
      <a class="admin-nav-link active" href="/">仪表盘</a>
    </div>
    <div class="admin-header-right">
      <span class="admin-header-version">v2.0</span>
    </div>
  </div>
</div>

<main class="admin-main">
  <div class="page-hd">
    <div>
      <div class="page-title">账号池</div>
      <div class="page-sub">多账号轮询 · 额度用完自动切换 · 实时用量监控</div>
    </div>
    <div class="page-actions">
      <span class="live-dot">实时监控中</span>
      <button onclick="refreshAllQuota()" class="page-action-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.6"/><path d="M20 20v-5h-5"/></svg>
        刷新额度
      </button>
      <button onclick="openAddModal(); switchAddTab('login')" class="page-action-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        OAuth 登录
      </button>
      <button onclick="openAddModal(); switchAddTab('paste')" class="page-action-btn page-action-btn-primary">
        <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        添加账号
      </button>
    </div>
  </div>

  <div class="section-head"><div class="section-title">账户概览</div></div>
  <div class="stat-grid">
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">账户总数</div><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4"/><circle cx="12" cy="8" r="4"/></svg></span></div><div class="stat-num" id="s-total">${accStats.total}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">正常</div><span class="stat-icon" style="color:#16a34a"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.4 2.4 4.8-4.8"/></svg></span></div><div class="stat-num" id="s-active" style="color:#16a34a">${accStats.active}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">请求数</div><span class="stat-icon" style="color:#4c9168"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg></span></div><div class="stat-num" id="s-requests" style="color:#4c9168">${stats.totalRequests}</div></div>
    <div class="stat-cell"><div class="stat-top"><div class="stat-label">成功率</div><span class="stat-icon" style="color:#16a34a"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M12 2v20M2 12h20"/></svg></span></div><div class="stat-num" id="s-rate" style="color:#16a34a">${stats.successRate}</div></div>
  </div>

  <div class="section-head">
    <div class="section-title">账户明细 <span class="section-count-badge" id="tbl-count">0</span></div>
    <div class="section-meta" id="last-updated"></div>
  </div>

  <div class="table-card">
    <table>
      <thead><tr>
        <th>邮箱</th>
        <th class="table-center" style="width:80px">状态</th>
        <th style="min-width:220px">额度</th>
        <th class="table-center" style="width:60px">请求</th>
        <th class="table-center" style="width:60px">错误</th>
        <th style="width:120px">最近使用</th>
        <th style="width:120px">操作</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <div class="section-head"><div class="section-title">设置</div></div>
  <div class="settings-card">
    <div class="settings-row">
      <label>轮询策略</label>
      <select class="input" id="rotation-select" onchange="updateRotation()">
        <option value="least_used">最少使用 - 按请求数最少选择</option>
        <option value="round_robin">轮询 - 按最后使用时间选择</option>
        <option value="by_quota">按额度 - 按剩余额度最多选择</option>
      </select>
    </div>
    <div class="settings-row">
      <label>额度刷新间隔（秒）</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="refresh-interval" type="number" min="0" style="width:120px">
        <button class="btn btn-ghost" onclick="updateRefreshInterval()">保存</button>
      </div>
      <span class="hint">设为 0 关闭自动刷新</span>
    </div>
    <div class="settings-row">
      <label>限流冷却时间（秒）</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" id="cooling-seconds" type="number" min="0" style="width:120px">
        <button class="btn btn-ghost" onclick="updateCoolingSeconds()">保存</button>
      </div>
      <span class="hint">429 限流后自动冷却的时间</span>
    </div>
  </div>

  <div class="section-head"><div class="section-title">API 端点</div></div>
  <div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:16px">
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">POST</span> /v1/chat/completions — OpenAI Chat</div>
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">POST</span> /v1/responses — OpenAI Response</div>
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">POST</span> /v1/messages — Anthropic Messages</div>
    <div style="font-family:monospace;font-size:13px;margin-bottom:6px"><span style="color:#4c76b2;font-weight:bold">GET</span> /v1/models — 模型列表</div>
    <div style="font-family:monospace;font-size:13px"><span style="color:#4c76b2;font-weight:bold">GET</span> /api/status — API 状态</div>
  </div>

  <div class="section-head"><div class="section-title">最近请求</div></div>
  <div class="table-card">
    <table>
      <thead><tr><th>时间</th><th>方法</th><th>模型</th><th>耗时</th><th>状态</th><th>错误</th></tr></thead>
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

<!-- 添加账号模态框 -->
<div class="modal-overlay" id="modal-add">
  <div class="modal">
    <div class="modal-title">添加账号</div>
    <div class="filter-bar" style="margin-bottom:16px">
      <button class="filter-chip active" id="tab-paste" onclick="switchAddTab('paste')">粘贴凭证</button>
      <button class="filter-chip" id="tab-login" onclick="switchAddTab('login')">OAuth 登录</button>
    </div>

    <!-- 粘贴凭证 -->
    <div id="add-pane-paste">
      <div class="dialog-body">
        <div>
          <div class="dialog-help">粘贴 JWT Token 或 API Key</div>
          <textarea class="input" id="add-jwt" rows="5" placeholder="在此粘贴 JWT Token..."></textarea>
        </div>
        <div class="dialog-field">
          <span class="dialog-label">邮箱</span>
          <input class="input" id="add-email" placeholder="user@example.com（可选）">
        </div>
      </div>
      <div class="dialog-actions">
        <button onclick="closeModal('modal-add')" class="dialog-btn">取消</button>
        <button onclick="doAddAccount()" class="dialog-btn dialog-btn-primary">添加</button>
      </div>
    </div>

    <!-- OAuth 登录 -->
    <div id="add-pane-login" style="display:none">
      <div class="dialog-body">
        <div class="dialog-help">通过 Z.AI OAuth 登录，获取包含 Coding Plan 额度的 JWT Token。</div>
        <div id="login-idle">
          <button onclick="startOAuthLogin()" id="login-start-btn" class="dialog-btn dialog-btn-primary w-full" style="height:40px">开始登录</button>
        </div>
        <div id="login-active" style="display:none">
          <div class="dialog-help" style="margin-bottom:6px">请在浏览器中打开以下链接完成授权：</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="input" id="login-url" readonly style="font-size:12px">
            <button onclick="copyLoginUrl()" class="dialog-btn">复制</button>
            <button onclick="openLoginUrl()" class="dialog-btn dialog-btn-primary">打开</button>
          </div>
          <div class="live-dot" id="login-status" style="margin-top:16px">等待授权中...</div>
        </div>
      </div>
      <div class="dialog-actions">
        <button onclick="cancelOAuthLogin()" class="dialog-btn">关闭</button>
      </div>
    </div>
  </div>
</div>

<!-- Toast container -->
<div class="toast-container" id="toast-container"></div>

<script src="static/js/toast.js"></script>
<script>
const API_KEY = '${config.auth.proxyApiKey || ""}';
const apiHeaders = API_KEY ? {'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json'} : {'Content-Type': 'application/json'};

async function loadAccounts() {
  try {
    const res = await fetch('api/accounts', { headers: apiHeaders });
    const data = await res.json();
    renderAccounts(data.accounts || []);
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('Failed to load accounts:', e);
  }
}

const STATUS_LABELS = {active:'正常',paused:'暂停',exhausted:'用完',cooling:'限流',error:'异常'};

function renderAccounts(accounts) {
  document.getElementById('tbl-count').textContent = accounts.length;
  const tbody = document.getElementById('tbody');
  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无账号，点击右上角「添加账号」添加</td></tr>';
    return;
  }
  tbody.innerHTML = accounts.map(a => {
    const glm52 = a.quota_details?.find(q => q.model === 'GLM-5.2');
    const glm5turbo = a.quota_details?.find(q => q.model === 'GLM-5-Turbo');
    const statusClass = a.status === 'active' ? 'active' : (a.status === 'paused' || a.status === 'cooling' ? 'disabled' : 'invalid');
    const statusLabel = STATUS_LABELS[a.status] || a.status;
    const isDisabled = a.status === 'paused' || a.status === 'error';
    return '<tr>' +
      '<td><span class="tok">' + (a.email || a.id.slice(0, 12)) + '</span></td>' +
      '<td class="table-center"><span class="badge badge-' + statusClass + '">' + statusLabel + '</span></td>' +
      '<td>' + quotaCell(glm52, glm5turbo) + '</td>' +
      '<td class="table-center" style="color:#8f8f8f">' + a.requests + '</td>' +
      '<td class="table-center" style="color:#9a9a9a">' + a.errors + '</td>' +
      '<td style="font-size:12px;color:#9a9a9a">' + (a.last_used_at ? new Date(a.last_used_at).toLocaleString() : '—') + '</td>' +
      '<td><div class="row-actions">' +
        '<button onclick="toggleAccount(\\'' + a.id + '\\',\\'' + a.status + '\\')" class="row-icon-btn" title="' + (isDisabled ? '恢复' : '暂停') + '">' +
          (isDisabled ? '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.708"/><path d="M3 4v5h5"/></svg>' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M8.5 8.5 15.5 15.5"/></svg>') +
        '</button>' +
        '<button onclick="deleteAccount(\\'' + a.id + '\\')" class="row-icon-btn row-icon-danger" title="删除"><svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M8 10v7"/><path d="M12 10v7"/><path d="M16 10v7"/><path d="M7 7l1 13h8l1-13"/></svg></button>' +
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
  if (!glm52 && !glm5turbo) return '<span class="quota-empty">暂无额度数据</span>';
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

// OAuth 登录
let oauthFlowId = '';
let oauthPolling = false;

async function startOAuthLogin() {
  try {
    const res = await fetch('api/oauth/init', { method: 'POST', headers: apiHeaders });
    const data = await res.json();
    if (data.ok) {
      oauthFlowId = data.flow_id;
      document.getElementById('login-idle').style.display = 'none';
      document.getElementById('login-active').style.display = 'block';
      document.getElementById('login-url').value = data.authorize_url;
      oauthPolling = true;
      startOAuthPoll();
    } else {
      showToast('OAuth 初始化失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('OAuth 初始化失败: ' + e.message, 'error');
  }
}

async function startOAuthPoll() {
  while (oauthPolling && oauthFlowId) {
    await new Promise(r => setTimeout(r, 2000));
    if (!oauthPolling) break;
    try {
      const res = await fetch('api/oauth/poll', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ flow_id: oauthFlowId }) });
      const data = await res.json();
      if (data.ok && data.status === 'ready') {
        oauthPolling = false;
        showToast('登录成功！账号已添加。', 'success');
        closeModal('modal-add');
        loadAccounts();
        resetOAuthLogin();
        return;
      } else if (data.error) {
        oauthPolling = false;
        showToast('OAuth 错误: ' + data.error, 'error');
        resetOAuthLogin();
        return;
      }
    } catch (e) {
      // 网络错误，继续轮询
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
  showToast('链接已复制到剪贴板', 'success');
}

function openLoginUrl() {
  const url = document.getElementById('login-url').value;
  window.open(url, '_blank');
}

async function doAddAccount() {
  const jwt = document.getElementById('add-jwt').value.trim();
  const email = document.getElementById('add-email').value.trim();
  if (!jwt) return showToast('请输入 JWT Token', 'error');
  try {
    const res = await fetch('api/accounts', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ zcode_jwt: jwt, email: email || undefined }) });
    const data = await res.json();
    if (data.ok) { closeModal('modal-add'); loadAccounts(); showToast('账号添加成功', 'success'); }
    else { showToast('错误: ' + (data.error || '未知错误'), 'error'); }
  } catch (e) { showToast('错误: ' + e.message, 'error'); }
}

async function deleteAccount(id) {
  if (!confirm('确认删除此账号？')) return;
  await fetch('api/accounts/' + id, { method: 'DELETE', headers: apiHeaders });
  loadAccounts();
  showToast('账号已删除', 'success');
}

async function toggleAccount(id, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  await fetch('api/accounts/' + id + '/status', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ status: newStatus }) });
  loadAccounts();
  showToast('账号状态已更新', 'success');
}

async function refreshAllQuota() {
  showToast('正在刷新额度...', 'info');
  await fetch('api/accounts/quota', { headers: apiHeaders });
  loadAccounts();
  showToast('额度已刷新', 'success');
}

// 设置相关
async function loadSettings() {
  try {
    const res = await fetch('api/settings', { headers: apiHeaders });
    const data = await res.json();
    if (data.ok && data.settings) {
      document.getElementById('rotation-select').value = data.settings.rotation || 'least_used';
      document.getElementById('refresh-interval').value = data.settings.quota_refresh_interval || 60;
      document.getElementById('cooling-seconds').value = data.settings.cooling_seconds || 300;
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function updateRotation() {
  const rotation = document.getElementById('rotation-select').value;
  await fetch('api/settings', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ rotation }) });
  showToast('轮询策略已更新', 'success');
}

async function updateRefreshInterval() {
  const quota_refresh_interval = parseInt(document.getElementById('refresh-interval').value) || 60;
  await fetch('api/settings', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ quota_refresh_interval }) });
  showToast('刷新间隔已更新', 'success');
}

async function updateCoolingSeconds() {
  const cooling_seconds = parseInt(document.getElementById('cooling-seconds').value) || 300;
  await fetch('api/settings', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ cooling_seconds }) });
  showToast('冷却时间已更新', 'success');
}

loadAccounts();
loadSettings();
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
  try {
    const { refreshAllQuota } = await import("./account-manager.js");
    const result = await refreshAllQuota();
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
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

// ─── Import/Export Handlers ───────────────────────────────────────────────────

async function handleExportAccounts(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get("format") || "json";

    const accounts = listAccounts();
    const exportData = accounts.map((a) => ({
      email: a.email,
      zcode_jwt: a.zcode_jwt,
      user_id: a.user_id,
      label: a.label,
      status: a.status,
      plan_expires_at: a.plan_expires_at,
      quota_details: a.quota_details,
    }));

    if (format === "csv") {
      const header = "email,zcode_jwt,status";
      const rows = exportData.map((a) => `${a.email || ""},${a.zcode_jwt || ""},${a.status || ""}`);
      const csv = [header, ...rows].join("\n");
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="zcode-accounts.csv"',
        },
      });
    }

    return new Response(JSON.stringify({ accounts: exportData }, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="zcode-accounts.json"',
      },
    });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

async function handleImportAccounts(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    let imported = 0;
    const errors: string[] = [];

    let accountList: any[] = [];

    if (Array.isArray(body)) {
      accountList = body;
    } else if (body.accounts && Array.isArray(body.accounts)) {
      accountList = body.accounts;
    } else {
      accountList = [body];
    }

    for (const item of accountList) {
      if (!item.zcode_jwt) {
        errors.push(`missing zcode_jwt: ${item.email || "unknown"}`);
        continue;
      }

      try {
        // Activate plan
        let planExpiresAt: number | null = null;
        try {
          const planData = await activatePlan(item.zcode_jwt);
          const plan = planData?.plans?.[0];
          if (plan?.ends_at) planExpiresAt = plan.ends_at;
        } catch {
          // Activation failure doesn't block import
        }

        addAccount({
          zcode_jwt: item.zcode_jwt,
          email: item.email || null,
          label: item.label || item.email || "imported",
          plan_expires_at: planExpiresAt,
        });
        imported++;
      } catch (e) {
        errors.push(`import failed for ${item.email || "unknown"}: ${(e as Error).message}`);
      }
    }

    return jsonResponse(200, {
      ok: true,
      imported,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

// ─── Batch Operations ─────────────────────────────────────────────────────────

async function handleBatchAccounts(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any;
    const { action, ids } = body;

    if (!action || !ids || !Array.isArray(ids)) {
      return jsonResponse(400, { error: "需要 action 和 ids 参数" });
    }

    const results: any[] = [];

    switch (action) {
      case "delete":
        for (const id of ids) {
          try {
            deleteAccount(id);
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: (e as Error).message });
          }
        }
        break;

      case "pause":
        for (const id of ids) {
          try {
            updateAccount(id, { status: "paused" });
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: (e as Error).message });
          }
        }
        break;

      case "activate":
        for (const id of ids) {
          try {
            updateAccount(id, { status: "active", cooling_until: undefined });
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: (e as Error).message });
          }
        }
        break;

      default:
        return jsonResponse(400, { error: "无效的 action，使用: delete, pause, activate" });
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return jsonResponse(200, {
      ok: true,
      action,
      results,
      summary: { succeeded, failed, total: ids.length },
    });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
}

// ─── Start Quota Monitor ──────────────────────────────────────────────────────

import { startQuotaMonitor } from "./account-manager.js";

// 启动定时刷新额度
startQuotaMonitor();
