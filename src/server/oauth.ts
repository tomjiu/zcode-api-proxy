/**
 * OAuth login flow — synced from TriDefender/zcode-api
 * Supports Z.AI CLI OAuth flow for getting JWT tokens
 */
import { randomBytes } from "node:crypto";

const ZCODE_OAUTH_BASE = "https://zcode.z.ai/api/v1";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface ZaiEnvelope {
  code: number;
  data?: Record<string, unknown>;
  msg?: string;
}

function unwrapZaiEnvelope(raw: unknown, httpStatus: number): Record<string, unknown> {
  const env = raw as ZaiEnvelope;
  if (typeof env?.code !== "number") {
    throw new Error(`Invalid OAuth response envelope (httpStatus=${httpStatus}): missing numeric code field`);
  }
  if (env.code !== 0) {
    throw new Error(env.msg ?? `OAuth business error: code=${env.code}`);
  }
  return env.data ?? {};
}

function generatePollToken(): string {
  return randomBytes(32).toString("hex");
}

export interface OAuthInitResult {
  flow_id: string;
  poll_token: string;
  authorize_url: string;
  expires_at: number;
  poll_interval_sec: number;
}

export interface OAuthPollResult {
  status: "pending" | "ready" | "failed";
  jwt?: string;
  oauth_access_token?: string;
  user_id?: string;
  email?: string;
  name?: string;
}

/**
 * Initialize CLI OAuth flow
 */
export async function initCliOAuth(): Promise<OAuthInitResult> {
  const pollToken = generatePollToken();

  const resp = await fetch(`${ZCODE_OAUTH_BASE}/oauth/cli/init`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pollToken}`,
    },
    body: JSON.stringify({ provider: "zai" }),
  });

  const raw = safeJsonParse(await resp.text());
  if (!resp.ok) {
    const env = raw as ZaiEnvelope | null;
    throw new Error(`OAuth init failed: ${resp.status} ${env?.msg ?? ""}`.trim());
  }
  if (!raw) {
    throw new Error(`OAuth init failed: invalid JSON response (status ${resp.status})`);
  }

  const data = unwrapZaiEnvelope(raw, resp.status);

  if (
    typeof data.flow_id !== "string" ||
    typeof data.authorize_url !== "string" ||
    typeof data.expires_at !== "number" ||
    typeof data.poll_interval_sec !== "number"
  ) {
    throw new Error(`Invalid OAuth init data: ${JSON.stringify(data).substring(0, 200)}`);
  }

  return {
    flow_id: data.flow_id,
    poll_token: pollToken,
    authorize_url: data.authorize_url,
    expires_at: data.expires_at,
    poll_interval_sec: data.poll_interval_sec,
  };
}

/**
 * Poll OAuth status
 */
export async function pollCliOAuth(flowId: string, pollToken: string): Promise<OAuthPollResult> {
  const resp = await fetch(
    `${ZCODE_OAUTH_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
    { headers: { authorization: `Bearer ${pollToken}` } }
  );

  const raw = safeJsonParse(await resp.text());
  if (!resp.ok) {
    if (resp.status === 400 || resp.status === 408 || resp.status === 404) {
      return { status: "failed" };
    }
    const env = raw as ZaiEnvelope | null;
    throw new Error(`OAuth poll failed: ${resp.status} ${env?.msg ?? ""}`.trim());
  }
  if (!raw) {
    throw new Error(`OAuth poll failed: invalid JSON response (status ${resp.status})`);
  }

  const data = unwrapZaiEnvelope(raw, resp.status);
  const status = data.status as string;

  if (status === "pending" || status === "failed") {
    return { status };
  }

  if (status === "ready") {
    const user = data.user as { user_id?: string; email?: string; name?: string } | undefined;
    return {
      status: "ready",
      jwt: (data.token as string) || null,
      oauth_access_token: (data.zai as { access_token?: string })?.access_token || null,
      user_id: user?.user_id || null,
      email: user?.email || null,
      name: user?.name || null,
    };
  }

  return { status: "pending" };
}

/**
 * Activate start-plan and get quota
 */
export async function activatePlan(jwt: string): Promise<any> {
  const res = await fetch(
    `${ZCODE_OAUTH_BASE}/zcode-plan/billing/current?app_version=3.1.2`,
    { headers: { authorization: `Bearer ${jwt}`, "x-api-key": jwt } }
  );
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`activatePlan failed: ${body.msg || body.code}`);
  }
  return body.data;
}

/**
 * Get account balance/quota
 */
export async function getBalance(jwt: string): Promise<any[]> {
  const res = await fetch(
    `${ZCODE_OAUTH_BASE}/zcode-plan/billing/balance?app_version=3.1.2`,
    { headers: { authorization: `Bearer ${jwt}`, "x-api-key": jwt } }
  );
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`getBalance failed: ${body.msg || body.code}`);
  }
  return body.data?.balances || [];
}
