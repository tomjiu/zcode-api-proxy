import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";

const DEFAULT_STORE = join(homedir(), ".zcode-proxy", "credentials.json");

export async function saveCredential(cred: Credential, path?: string): Promise<void> {
  const target = path ?? DEFAULT_STORE;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(cred, null, 2), { mode: 0o600 });
}

export async function loadCredential(path?: string): Promise<Credential | null> {
  const target = path ?? DEFAULT_STORE;
  if (!existsSync(target)) return null;
  const raw = readFileSync(target, "utf-8");
  const parsed = JSON.parse(raw) as Partial<Credential>;

  console.log(`[store] loadCredential from ${target}: hasJWT=${!!parsed.jwt}, provider=${parsed.provider}`);

  // For start-plan mode: credentials.json may only have {jwt, provider, expiresAt}
  // but Credential interface requires apiKey. Provide a placeholder for JWT-only mode.
  if (parsed.jwt && !parsed.apiKey) {
    const cred = {
      provider: parsed.provider || "zai",
      apiKey: "", // Placeholder — start-plan uses JWT, not apiKey
      jwt: parsed.jwt,
      expiresAt: parsed.expiresAt,
      userId: parsed.userId,
    } as Credential;
    console.log(`[store] Built JWT-only credential: provider=${cred.provider}, hasJWT=${!!cred.jwt}`);
    return cred;
  }

  return parsed as Credential;
}

export function clearCredential(path?: string): void {
  const target = path ?? DEFAULT_STORE;
  if (existsSync(target)) {
    unlinkSync(target);
  }
}

export function getStorePath(): string {
  return DEFAULT_STORE;
}
