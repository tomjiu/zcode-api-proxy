/**
 * Account manager — manages OAuth credentials and quota tracking
 * Migrated from appserver-probe and zcode2api
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getBalance, activatePlan } from "./oauth.js";

export interface Account {
  id: string;
  email?: string;
  zcode_jwt?: string;
  oauth_access_token?: string;
  user_id?: string;
  label?: string;
  status: "active" | "paused" | "error" | "exhausted" | "cooling";
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
  cooling_until?: number;
  created_at: string;
}

interface Store {
  accounts: Account[];
  settings: {
    rotation: "least_used" | "round_robin" | "by_quota";
    quota_refresh_interval: number; // seconds, 0 = disabled
    cooling_seconds: number; // seconds for rate limit cooling
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
    store = { accounts: [], settings: { rotation: "least_used", quota_refresh_interval: 60, cooling_seconds: 300 } };
  }
  // 确保 settings 字段完整
  if (!store.settings) store.settings = { rotation: "least_used", quota_refresh_interval: 60, cooling_seconds: 300 };
  if (store.settings.quota_refresh_interval === undefined) store.settings.quota_refresh_interval = 60;
  if (store.settings.cooling_seconds === undefined) store.settings.cooling_seconds = 300;
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

  // 限流检测
  if (error && (error.includes("429") || error.includes("rate_limit"))) {
    const coolingSeconds = load().settings.cooling_seconds || 300;
    account.status = "cooling";
    account.cooling_until = Date.now() + coolingSeconds * 1000;
    account.last_error = `限流冷却 ${coolingSeconds}秒`;
  }

  save();
}

// ─── Quota Refresh ────────────────────────────────────────────────────────────

let quotaTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 刷新单个账户的额度
 */
export async function refreshAccountQuota(account: Account): Promise<boolean> {
  if (!account.zcode_jwt) return false;

  try {
    // 激活计划
    try {
      const planData = await activatePlan(account.zcode_jwt);
      const plan = planData?.plans?.[0];
      if (plan?.ends_at) {
        account.plan_expires_at = plan.ends_at;
      }
    } catch {
      // 激活失败不影响余额查询
    }

    // 获取余额
    const balances = await getBalance(account.zcode_jwt);
    const quotaInfo = balances.map((b: any) => ({
      model: b.show_name,
      remaining: b.remaining_units,
      total: b.total_units,
      used: b.used_units,
    }));

    if (quotaInfo.length > 0) {
      account.quota_details = quotaInfo;

      // 额度用完判定
      const allExhausted = quotaInfo.every((q) => q.remaining <= 0);
      if (allExhausted && account.status === "active") {
        account.status = "exhausted";
        account.last_error = "额度已用完";
      } else if (!allExhausted && account.status === "exhausted") {
        // 额度恢复
        account.status = "active";
        account.last_error = undefined;
      }
    }

    save();
    return true;
  } catch (e) {
    console.error(`[quota] refresh failed for ${account.email || account.id}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 刷新所有活跃账户的额度
 */
export async function refreshAllQuota(): Promise<{ ok: number; fail: number }> {
  const accounts = load().accounts.filter(
    (a) => a.zcode_jwt && a.status !== "paused" && a.status !== "error"
  );

  let ok = 0;
  let fail = 0;

  for (const account of accounts) {
    const success = await refreshAccountQuota(account);
    if (success) ok++;
    else fail++;
  }

  return { ok, fail };
}

/**
 * 检查并恢复冷却中的账户
 */
function checkCoolingAccounts() {
  const s = load();
  const now = Date.now();
  let changed = false;

  for (const account of s.accounts) {
    if (account.status === "cooling" && account.cooling_until && now >= account.cooling_until) {
      account.status = "active";
      account.cooling_until = undefined;
      account.last_error = undefined;
      changed = true;
      console.log(`[quota] account ${account.email || account.id} cooling ended, reactivated`);
    }
  }

  if (changed) save();
}

/**
 * 启动定时刷新额度
 */
export function startQuotaMonitor() {
  if (quotaTimer) return;

  const interval = load().settings.quota_refresh_interval || 60;
  if (interval <= 0) {
    console.log("[quota] quota refresh disabled (interval=0)");
    return;
  }

  console.log(`[quota] starting quota monitor, interval=${interval}s`);

  // 启动后延迟 5 秒，避免与服务启动争抢
  setTimeout(async () => {
    while (true) {
      const currentInterval = load().settings.quota_refresh_interval || 60;
      if (currentInterval <= 0) {
        // 关闭：仍周期性检查设置，便于随时启用
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }

      // 检查冷却账户
      checkCoolingAccounts();

      // 刷新额度
      try {
        const accounts = load().accounts.filter(
          (a) => a.zcode_jwt && a.status !== "paused" && a.status !== "error"
        );
        if (accounts.length > 0) {
          const result = await refreshAllQuota();
          console.log(`[quota] refresh done: ${result.ok} ok, ${result.fail} fail`);
        }
      } catch (e) {
        console.error(`[quota] refresh error: ${(e as Error).message}`);
      }

      await new Promise((r) => setTimeout(r, currentInterval * 1000));
    }
  }, 5000);
}

/**
 * 停止定时刷新额度
 */
export function stopQuotaMonitor() {
  if (quotaTimer) {
    clearInterval(quotaTimer);
    quotaTimer = null;
  }
}
