/**
 * Encrypted file-based credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Credential } from "./types.js";

const STORE_DIR = join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "credentials.json");
const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

/**
 * Derive a 32-byte AES key from a seed string via cyclic XOR.
 * If ZCODE_PROXY_CREDENTIAL_SECRET env var is set, it's used as the seed;
 * Docker uses a fixed seed; local uses homedir-platform-arch.
 * Same seed → same key, enabling cross-machine credential sharing.
 */
function getEncryptionKey(): Buffer {
  const seed = process.env[ENV_SECRET]
    ?? (process.env.DOCKER_CONTAINER
      ? "zcode-proxy-docker-default-key"
      : `${homedir()}-${process.platform}-${process.arch}`);
  const hash = Buffer.alloc(32);
  const seedBytes = Buffer.from(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

async function encrypt(plaintext: string): Promise<string> {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

async function decrypt(ciphertext: string): Promise<string> {
  const key = getEncryptionKey();

  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const authTag = combined.slice(12, 28);
  const data = combined.slice(28);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}

export async function saveCredential(cred: Credential): Promise<void> {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const json = JSON.stringify(cred);
  const encrypted = await encrypt(json);
  writeFileSync(STORE_FILE, JSON.stringify({ encrypted }), { mode: 0o600 });
}

export async function loadCredential(): Promise<Credential | null> {
  if (!existsSync(STORE_FILE)) return null;
  const raw = readFileSync(STORE_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.encrypted) return null;
  const json = await decrypt(parsed.encrypted);
  return JSON.parse(json) as Credential;
}

export function clearCredential(): void {
  if (existsSync(STORE_FILE)) {
    unlinkSync(STORE_FILE);
  }
}

export function getStorePath(): string {
  return STORE_FILE;
}
