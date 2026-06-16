/**
 * CLI login command — starts OAuth flow and saves credentials.
 * @see .omo/plans/zcode-proxy.md Task 14
 * Usage:
 *   bun run src/cli/login.ts [--provider zai|bigmodel] [--import]
 *
 * --import: Read API key directly from ~/.zcode/v2/config.json instead of OAuth.
 *           This is the recommended path for Bigmodel coding-plan.
 *
 * Z.AI: device/poll flow via zcode.z.ai
 * Bigmodel: auth-code/callback flow via bigmodel.cn (localhost callback server)
 */
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { saveCredential, getStorePath } from "../auth/store.js";
import type { Credential } from "../auth/types.js";
import type { ProviderId } from "../provider/types.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const providerIdx = args.indexOf("--provider");
  const provider: ProviderId = (providerIdx >= 0 ? args[providerIdx + 1] : "zai") as ProviderId;
  const importMode = args.includes("--import");

  if (provider !== "zai" && provider !== "bigmodel") {
    console.error(`Unknown provider: ${provider}. Use 'zai' or 'bigmodel'.`);
    process.exit(1);
  }

  console.log(`Starting ${importMode ? "config import" : "OAuth login"} for provider: ${provider}\n`);

  let cred: Credential;

  if (importMode) {
    cred = importFromZCodeConfig(provider);
  } else {
    const { accessToken, userId } = await runOAuthFlow(provider);
    console.log("\nAuthorization received. Resolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
  }

  await saveCredential(cred);

  console.log(`\nCredential saved to: ${getStorePath()}`);
  console.log(`  Provider: ${cred.provider}`);
  console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log("\nYou can now start the proxy in oauth mode.");
}

function importFromZCodeConfig(provider: ProviderId): Credential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ZCode config at ${configPath}.`);
    console.error("Make sure ZCode is installed and you have logged in at least once.");
    process.exit(1);
  }

  const config = JSON.parse(raw) as {
    provider?: Record<string, {
      options?: { apiKey?: string };
      enabled?: boolean;
    }>;
  };

  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();

  if (!apiKey) {
    console.error(`No API key found for ${providerKey} in ZCode config.`);
    console.error("Log in via the ZCode desktop app first, then retry.");
    process.exit(1);
  }

  if (!entry?.enabled) {
    console.error(`Warning: ${providerKey} is not enabled in ZCode config.`);
  }

  console.log(`Imported API key from ${configPath}`);
  return { apiKey, provider };
}

async function runOAuthFlow(provider: ProviderId): Promise<{ accessToken: string; userId?: string }> {
  if (provider === "bigmodel") {
    const oauth = new BigmodelOAuthClient();
    const result = await oauth.authorize((url) => {
      console.log("Please open this URL in your browser to authorize:\n");
      console.log(`  ${url}\n`);
      console.log("Waiting for authorization... (expires in 300s)\n");
      openBrowser(url);
    });
    return { accessToken: result.accessToken, userId: result.userId };
  }

  const oauth = new ZaiOAuthClient();
  const init = await oauth.init("zai");

  console.log("Please open this URL in your browser to authorize:\n");
  console.log(`  ${init.authorizeUrl}\n`);
  console.log(`Waiting for authorization... (expires in ${Math.floor((init.expiresAt - Date.now()) / 1000)}s)\n`);

  openBrowser(init.authorizeUrl);

  const result = await oauth.waitForAuth(init);
  return { accessToken: result.accessToken, userId: result.userId };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort — user can copy URL manually
  }
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
