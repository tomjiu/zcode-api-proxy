/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBody } from "./body-transformer.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Steps:
 * 1. Read client request body
 * 2. Get provider definition from config
 * 3. Get credential from auth manager
 * 4. Build upstream request (URL + headers + body)
 * 5. Fetch from upstream
 * 6. Stream the response back (body is piped for both streaming + non-streaming)
 *
 * @returns The upstream `Response`, ready to return from a Bun.serve handler.
 */
const UPSTREAM_TIMEOUT_MS = 180_000;

export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const body = await readBody(clientReq);

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  const transformedBody = transformRequestBody(body, { format, userId: cred.userId });
  const upstreamReq = buildUpstreamRequest(clientReq, format, provider, cred, transformedBody, config.identity);

  let upstreamResp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    upstreamResp = await fetchImpl(upstreamReq, { signal: controller.signal }).finally(() => clearTimeout(timer));
  } catch (err) {
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }

  return passthroughResponse(upstreamResp);
}

/** Read the request body as a string, returning undefined for empty bodies. */
async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (text.length === 0) return undefined;
  return text;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status, headers, and body stream.
 */
function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}
