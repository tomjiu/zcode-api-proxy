/**
 * Account manager — manages OAuth credentials and quota tracking
 * Migrated from appserver-probe
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface Account {
  id: string;
  email?: string;
  zcode_jwt?: string;
  oauth_access_token?: string;
  user_id?: string;
  label?: string;
  status: "active" | "paused" | "error";
  plan_expires_at?: number;
  quota_details?: Array<{
    model: string;
    remaining: number;
    total: number;
    used: number;
  }>;
  requests: number;
  errors: number;
  last_used_at?: string;
  last_error?: string;
  created_at: string;
}

interface Store {
  accounts: Account[];
  settings: {
    rotation: "least_used" | "round_robin" | "by_quota";
  };
}

const STORE_DIR = join(homedir(), ".zcode-proxy");
const STORE_FILE = join(STORE_DIR, "accounts.json");

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    if (existsSync(STORE_FILE)) {
      store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {}
  if (!store) {
    store = { accounts: [], settings: { rotation: "least_used" } };
  }
  return store;
}

function save(): void {
  if (!store) return;
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export function listAccounts(): Account[] {
  return load().accounts;
}

export function getAccount(id: string): Account | undefined {
  return load().accounts.find((a) => a.id === id);
}

export function addAccount(input: Partial<Account>): Account {
  const s = load();

  // 检查重复
  const exists = s.accounts.find(
    (a) => (input.zcode_jwt && a.zcode_jwt === input.zcode_jwt) || (input.email && a.email === input.email)
  );
  if (exists) return exists;

  const account: Account = {
    id: input.id || crypto.randomUUID().slice(0, 12),
    email: input.email,
    zcode_jwt: input.zcode_jwt,
    oauth_access_token: input.oauth_access_token,
    user_id: input.user_id,
    label: input.label || input.email || "unnamed",
    status: input.status || "active",
    plan_expires_at: input.plan_expires_at,
    quota_details: input.quota_details,
    requests: 0,
    errors: 0,
    created_at: new Date().toISOString(),
  };

  s.accounts.push(account);
  save();
  return account;
}

export function updateAccount(id: string, fields: Partial<Account>): Account | undefined {
  const s = load();
  const idx = s.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return undefined;
  Object.assign(s.accounts[idx], fields);
  save();
  return s.accounts[idx];
}

export function deleteAccount(id: string): boolean {
  const s = load();
  const idx = s.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  s.accounts.splice(idx, 1);
  save();
  return true;
}

export function getSettings() {
  return load().settings;
}

export function updateSettings(patch: Partial<Store["settings"]>) {
  Object.assign(load().settings, patch);
  save();
}

export function getStats() {
  const accounts = load().accounts;
  return {
    total: accounts.length,
    active: accounts.filter((a) => a.status === "active").length,
    paused: accounts.filter((a) => a.status === "paused").length,
    error: accounts.filter((a) => a.status === "error").length,
  };
}

export function getNextAccount(): Account | null {
  const s = load();
  const eligible = s.accounts.filter((a) => a.status === "active");
  if (eligible.length === 0) return null;

  if (s.settings.rotation === "by_quota") {
    // 按剩余额度排序
    eligible.sort((a, b) => {
      const quotaA = a.quota_details?.reduce((sum, q) => sum + q.remaining, 0) ?? Infinity;
      const quotaB = b.quota_details?.reduce((sum, q) => sum + q.remaining, 0) ?? Infinity;
      return quotaB - quotaA;
    });
  } else if (s.settings.rotation === "round_robin") {
    // 按最后使用时间排序
    eligible.sort((a, b) => {
      const ta = a.last_used_at || "0";
      const tb = b.last_used_at || "0";
      return ta.localeCompare(tb);
    });
  } else {
    // least_used - 按请求数排序
    eligible.sort((a, b) => a.requests - b.requests);
  }

  return eligible[0];
}

export function recordRequest(id: string, success: boolean, error?: string) {
  const account = getAccount(id);
  if (!account) return;
  account.requests++;
  if (!success) account.errors++;
  account.last_used_at = new Date().toISOString();
  if (error) account.last_error = error;
  save();
}
