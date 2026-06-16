/**
 * Upstream request builder — constructs the forwarded HTTP request.
 * @see .omo/plans/zcode-proxy.md Task 6
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildIdentityHeaders } from "./identity.js";

const ANTHROPIC_VERSION = "2023-06-01";
const SESSION_ROTATE_MS = 10 * 60 * 1000;

const STRIP_HEADERS = new Set([
  "host",
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id",
]);

let currentSessionId = crypto.randomUUID();
let sessionRotateAt = Date.now() + SESSION_ROTATE_MS;

function getSessionId(): string {
  const now = Date.now();
  if (now >= sessionRotateAt) {
    currentSessionId = crypto.randomUUID();
    sessionRotateAt = now + SESSION_ROTATE_MS;
  }
  return currentSessionId;
}

export function buildUpstreamURL(format: Format, provider: ProviderDef): string {
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}

export function buildAuthHeaders(format: Format, cred: Credential, identity: ProxyIdentity): Record<string, string> {
  const credStr = credentialString(cred);
  const base: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
    "x-query-id": `query_${crypto.randomUUID()}`,
    "x-session-id": getSessionId(),
  };

  if (format === "anthropic") {
    base["x-api-key"] = credStr;
    base["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    base["authorization"] = `Bearer ${credStr}`;
  }

  return base;
}

function collectPassthroughHeaders(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIP_HEADERS.has(lower)) continue;
    if (lower === "anthropic-beta") {
      result[lower] = value;
    }
  }
  return result;
}

export function buildUpstreamRequest(
  clientReq: Request,
  format: Format,
  provider: ProviderDef,
  cred: Credential,
  body: string | undefined,
  identity: ProxyIdentity,
): Request {
  const url = buildUpstreamURL(format, provider);
  const authHeaders = buildAuthHeaders(format, cred, identity);
  const passthrough = collectPassthroughHeaders(clientReq);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...passthrough,
    ...authHeaders,
  };

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
