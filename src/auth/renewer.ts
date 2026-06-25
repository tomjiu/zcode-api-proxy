/**
 * JWT auto-renewal for start-plan.
 *
 * Strategy: When the primary JWT in credentials.json expires, fallback to
 * another valid JWT from accounts.json (multi-account pool).
 */
import type { Credential } from "./types.js";
import { loadCredential, saveCredential } from "./store.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RenewalContext {
  /** Storage path for credentials.json */
  credentialPath?: string;
}

/**
 * Attempt to renew an expired JWT by rotating to another account from accounts.json.
 *
 * @param expired The expired credential
 * @param context Renewal context (credential path)
 * @returns Fresh credential with valid JWT from account pool, or null if renewal failed
 */
export async function renewJWT(
  expired: Credential,
  context: RenewalContext,
): Promise<Credential | null> {
  if (!expired.jwt) {
    console.error("[renewer] Cannot renew: no JWT in expired credential");
    return null;
  }

  try {
    console.log("[renewer] Primary JWT expired, searching for valid account in pool...");

    // Load accounts.json
    const accountsPath = join(homedir(), ".zcode-proxy", "accounts.json");
    if (!existsSync(accountsPath)) {
      console.error("[renewer] No accounts.json found");
      return null;
    }

    const raw = readFileSync(accountsPath, "utf-8");
    const store = JSON.parse(raw) as { accounts: Array<{ zcode_jwt?: string; status?: string; plan_expires_at?: number }> };

    if (!store.accounts || store.accounts.length === 0) {
      console.error("[renewer] No accounts in pool");
      return null;
    }

    // Find a valid account (not the expired one, not paused/error, not expired)
    const now = Date.now();
    for (const acc of store.accounts) {
      if (!acc.zcode_jwt) continue;
      if (acc.zcode_jwt === expired.jwt) continue; // Skip the expired one
      if (acc.status && acc.status !== "active") continue; // Skip paused/error accounts

      // Check plan_expires_at (JWT validity is tied to plan expiry for start-plan)
      if (acc.plan_expires_at && now >= acc.plan_expires_at * 1000) continue;

      // Found a valid JWT!
      const planExpiryDate = acc.plan_expires_at ? new Date(acc.plan_expires_at * 1000).toISOString() : 'unknown';
      console.log(`[renewer] Found valid JWT from account pool (plan expires: ${planExpiryDate})`);

      const fresh: Credential = {
        ...expired,
        jwt: acc.zcode_jwt,
        expiresAt: acc.plan_expires_at ? acc.plan_expires_at * 1000 : undefined,
      };

      // Persist to credentials.json
      await saveCredential(fresh, context.credentialPath);
      console.log("[renewer] JWT renewed successfully from account pool");

      return fresh;
    }

    console.error("[renewer] No valid JWT found in account pool");
    return null;
  } catch (err) {
    console.error("[renewer] Renewal failed:", (err as Error).message);
    return null;
  }
}
