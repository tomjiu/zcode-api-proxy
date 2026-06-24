/**
 * OAuth login flow — migrated from appserver-probe
 * Supports Z.AI CLI OAuth flow for getting JWT tokens
 */
import { randomBytes } from "node:crypto";

const ZCODE_BASE_URL = "https://zcode.z.ai";
const OAUTH_CLI_PROVIDER = "zai";
const POLL_TOKEN_BYTES = 32;

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

function createPollToken(): string {
  return randomBytes(POLL_TOKEN_BYTES).toString("hex");
}

/**
 * Initialize CLI OAuth flow
 */
export async function initCliOAuth(): Promise<OAuthInitResult> {
  const pollToken = createPollToken();
  const res = await fetch(`${ZCODE_BASE_URL}/api/v1/oauth/cli/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pollToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider: OAUTH_CLI_PROVIDER }),
  });

  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OAuth init invalid response HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok || body.code !== 0 || !body.data) {
    throw new Error(`OAuth init failed: ${body.msg || res.status} (code ${body.code || "?"})`);
  }

  return {
    flow_id: body.data.flow_id,
    poll_token: pollToken,
    authorize_url: body.data.authorize_url,
    expires_at: body.data.expires_at,
    poll_interval_sec: body.data.poll_interval_sec,
  };
}

/**
 * Poll OAuth status
 */
export async function pollCliOAuth(flowId: string, pollToken: string): Promise<OAuthPollResult> {
  const res = await fetch(
    `${ZCODE_BASE_URL}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
    { headers: { Authorization: `Bearer ${pollToken}` } }
  );

  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OAuth poll invalid response HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`OAuth poll failed: ${body.msg || res.status}`);
  }

  const data = body.data || body;

  if (data.status === "pending" || data.status === "failed") {
    return { status: data.status };
  }

  if (data.status === "ready") {
    const user = data.user || {};
    return {
      status: "ready",
      jwt: data.token || data.jwt || null,
      oauth_access_token: data.zai?.access_token || data.oauth_access_token || null,
      user_id: user.user_id || data.user_id || null,
      email: user.email || data.email || null,
      name: user.name || data.name || null,
    };
  }

  return { status: "pending" };
}

/**
 * Activate start-plan and get quota
 */
export async function activatePlan(jwt: string): Promise<any> {
  const res = await fetch(
    `${ZCODE_BASE_URL}/api/v1/zcode-plan/billing/current?app_version=3.1.2`,
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
    `${ZCODE_BASE_URL}/api/v1/zcode-plan/billing/balance?app_version=3.1.2`,
    { headers: { authorization: `Bearer ${jwt}`, "x-api-key": jwt } }
  );
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`getBalance failed: ${body.msg || body.code}`);
  }
  return body.data?.balances || [];
}
