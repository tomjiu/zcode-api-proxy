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
  .endpoint{background:#1e293b;border-radius:8px;padding:12px 16px;margin-bottom:8px;font-family:monospace;font-size:13px}
  .endpoint .method{color:#38bdf8;font-weight:bold}
  button{background:#38bdf8;color:#0f172a;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px}
  button:hover{background:#7dd3fc}
</style>
</head><body>
<h1>ZCode Proxy Dashboard</h1>

<div class="grid">
  <div class="card"><div class="label">Uptime</div><div class="value">${formatUptime(stats.uptime)}</div></div>
  <div class="card"><div class="label">Requests</div><div class="value">${stats.totalRequests}</div></div>
  <div class="card"><div class="label">Success Rate</div><div class="value good">${stats.successRate}</div></div>
  <div class="card"><div class="label">Provider</div><div class="value">${config.provider}</div></div>
</div>

<h2>Configuration</h2>
<div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px">
  <p style="margin-bottom:8px"><strong>Plan:</strong> ${config.plan}</p>
  <p style="margin-bottom:8px"><strong>Provider:</strong> ${config.provider}</p>
  <p style="margin-bottom:8px"><strong>Auth Mode:</strong> ${config.auth.mode}</p>
  <p><strong>Default Model:</strong> ${config.defaultModel}</p>
</div>

<h2>Available Models</h2>
<table>
  <tr><th>Model ID</th><th>Context Window</th><th>Max Output</th></tr>
  ${MODELS.map(m => `<tr>
    <td>${m.id}</td>
    <td>${(m.contextWindow / 1000).toFixed(0)}k</td>
    <td>${((m.maxOutputTokens || 128000) / 1000).toFixed(0)}k</td>
  </tr>`).join('')}
</table>

<h2>API Endpoints</h2>
<div class="endpoint"><span class="method">POST</span> /v1/chat/completions — OpenAI Chat</div>
<div class="endpoint"><span class="method">POST</span> /v1/messages — Anthropic Messages</div>
<div class="endpoint"><span class="method">GET</span> /v1/models — Model List</div>
<div class="endpoint"><span class="method">GET</span> /health — Health Check</div>
<div class="endpoint"><span class="method">GET</span> /api/status — API Status</div>

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

<script>
setTimeout(() => location.reload(), 10000);
</script>
</body></html>`;
}
