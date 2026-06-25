/**
 * Token exchange and plan utilities for ZCode.
 *
 * Contains activatePlan() and getBalance() for start-plan quota management.
 * OAuth token exchange logic lives in src/auth/oauth.ts (AuthCodeOAuthClient).
 */
const ZCODE_OAUTH_BASE = "https://zcode.z.ai/api/v1";

export async function activatePlan(jwt: string): Promise<any> {
  const res = await fetch(
    `${ZCODE_OAUTH_BASE}/zcode-plan/billing/current?app_version=3.14`,
    { headers: { authorization: `Bearer ${jwt}`, "x-api-key": jwt } }
  );
  if (!res.ok) throw new Error(`activatePlan failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.code !== "number" || body.code !== 0) {
    throw new Error(`activatePlan failed: ${body?.msg || body?.code || "invalid response"}`);
  }
  console.log("[oauth] activatePlan response:", JSON.stringify(body).substring(0, 200));
  return body.data;
}

export async function getBalance(jwt: string): Promise<any[]> {
  const res = await fetch(
    `${ZCODE_OAUTH_BASE}/zcode-plan/billing/balance?app_version=3.14`,
    { headers: { authorization: `Bearer ${jwt}`, "x-api-key": jwt } }
  );
  if (!res.ok) throw new Error(`getBalance failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.code !== "number" || body.code !== 0) {
    throw new Error(`getBalance failed: ${body?.msg || body?.code || "invalid response"}`);
  }
  return body.data?.balances || [];
}
