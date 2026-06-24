/**
 * File-based credential store (no encryption — run behind trusted network).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";

const STORE_DIR = join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");

export async function saveCredential(cred: Credential): Promise<void> {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
}

export async function loadCredential(): Promise<Credential | null> {
  if (!existsSync(STORE_FILE)) return null;
  const raw = readFileSync(STORE_FILE, "utf-8");
  return JSON.parse(raw) as Credential;
}

export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    unlinkSync(STORE_FILE);
  }
}

export function getStorePath(): string {
  return STORE_FILE;
}
