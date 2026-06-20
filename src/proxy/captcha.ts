/**
 * Aliyun Captcha V3 headless solver for start-plan tier.
 *
 * Captcha config (prefix/sceneId/region) is auto-fetched from
 * https://zcode.z.ai/api/v1/client/configs — no user configuration needed.
 *
 * When zcode.z.ai returns a captcha challenge (response header
 * `x-aliyun-captcha-verify-param`), this module solves it headlessly via
 * Playwright + the official AliyunCaptcha.js SDK, then returns the solved token.
 *
 * @see _reverse/zcode.cjs `o5r()` / `createZcodePlanCaptchaEmptyStreamBusinessError`
 */

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const ALIYUN_CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

interface FetchedCaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchCaptchaConfig(): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }
  try {
    const url = `${CONFIGS_API}?app_version=3.1.1&platform=win32-x64`;
    const resp = await fetch(url);
    const json = (await resp.json()) as { code?: number; data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch {
    return null;
  }
}

/**
 * Solve an Aliyun captcha challenge headlessly.
 *
 * Fetches captcha config from ZCode API, launches Chromium, loads
 * AliyunCaptcha.js, and waits for the SDK success callback.
 *
 * @returns Object with verifyParam and region for the retry request headers
 * @throws Error if config unavailable, Playwright missing, or solve times out
 */
export async function solveCaptcha(challenge: string): Promise<{ verifyParam: string; region: string }> {
  const cfg = await fetchCaptchaConfig();
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) {
    throw new Error("Captcha config unavailable from ZCode API");
  }

  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(buildSolverHtml(cfg), { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ url: ALIYUN_CAPTCHA_SDK_URL });

    const verifyParam = await page.evaluate(
      (args: { prefix: string; sceneId: string; region: string }): Promise<string> => {
        const { prefix, sceneId, region } = args;
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("captcha solve timeout after 30s")), 30000);
          const w = window as unknown as {
            AliyunCaptchaConfig?: { region: string; prefix: string };
            initAliyunCaptcha?: (opts: Record<string, unknown>) => void;
          };
          w.AliyunCaptchaConfig = { region, prefix };
          if (!w.initAliyunCaptcha) {
            clearTimeout(timeout);
            reject(new Error("AliyunCaptcha.js failed to load"));
            return;
          }
          w.initAliyunCaptcha({
            SceneId: sceneId,
            prefix,
            mode: "popup",
            language: "cn",
            showErrorTip: false,
            element: "#captcha-element",
            button: "#captcha-button",
            getInstance: () => {},
            success: (param: string) => {
              clearTimeout(timeout);
              resolve(param);
            },
            fail: (err: unknown) => {
              clearTimeout(timeout);
              reject(new Error(`Aliyun SDK fail: ${JSON.stringify(err)}`));
            },
            onError: (err: unknown) => {
              clearTimeout(timeout);
              reject(new Error(`Aliyun SDK error: ${JSON.stringify(err)}`));
            },
          });
        });
      },
      { prefix: cfg.prefix, sceneId: cfg.sceneId, region: cfg.region },
    );

    void challenge;
    return { verifyParam, region: cfg.region };
  } finally {
    await browser.close();
  }
}

function buildSolverHtml(cfg: FetchedCaptchaConfig): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>captcha-solver</title>
<script>window.AliyunCaptchaConfig = { region: "${cfg.region}", prefix: "${cfg.prefix}" };</script>
</head>
<body>
<div id="captcha-element"></div>
<button id="captcha-button">verify</button>
</body>
</html>`;
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };

async function loadPlaywright(): Promise<PlaywrightModule> {
  const moduleName = "playwright";
  try {
    const mod = await import(/* @vite-ignore */ moduleName);
    return mod as unknown as PlaywrightModule;
  } catch {
    throw new Error(
      "playwright is not installed. Install with: bun add -d playwright && bunx playwright install chromium",
    );
  }
}

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  setContent(html: string, opts: { waitUntil: string }): Promise<void>;
  addScriptTag(opts: { url: string }): Promise<void>;
  evaluate<T>(fn: (args: { prefix: string; sceneId: string; region: string }) => Promise<T>, args: { prefix: string; sceneId: string; region: string }): Promise<T>;
}
