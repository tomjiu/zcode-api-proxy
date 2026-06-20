/**
 * Aliyun Captcha V3 solver — in-process jsdom (single binary).
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
const TOKEN_TTL_MS = 45_000;
const ALIYUN_SDK_CDN = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let cachedToken: { verifyParam: string; region: string; expiresAt: number } | null = null;

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}

export function invalidateCaptchaToken(): void { cachedToken = null; }

async function fetchCaptchaConfig(): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=3.1.1&platform=win32-x64`);
    const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch { return null; }
}

export async function getCaptchaToken(): Promise<{ verifyParam: string; region: string }> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return { verifyParam: cachedToken.verifyParam, region: cachedToken.region };
  const cfg = await fetchCaptchaConfig();
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  const verifyParam = await solveInJsdom(cfg);
  cachedToken = { verifyParam, region: cfg.region, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { verifyParam, region: cfg.region };
}

async function solveInJsdom(cfg: FetchedCaptchaConfig): Promise<string> {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const vc = new VirtualConsole();
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script src="${ALIYUN_SDK_CDN}"></script></body></html>`;
  const dom = new JSDOM(html, {
    url: "https://zcode.z.ai/", runScripts: "dangerously", resources: "usable",
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window: any) { applyPolyfills(window); window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }; },
  });
  const w = dom.window as any;
  await waitFor(() => typeof w.initAliyunCaptcha === "function", 15000);
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("captcha solve timeout after 30s")), 30000);
    w.initAliyunCaptcha({
      SceneId: cfg.sceneId, mode: "popup", region: cfg.region, prefix: cfg.prefix, language: "en",
      element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
      getInstance: (inst: any) => { try { (inst.startTracelessVerification || inst.show)?.call(inst); } catch {} },
      success: (param: string) => { clearTimeout(timeout); resolve(param); },
      fail: (err: unknown) => { clearTimeout(timeout); reject(new Error(`SDK fail: ${JSON.stringify(err)}`)); },
      onError: (err: unknown) => { clearTimeout(timeout); reject(new Error(`SDK error: ${JSON.stringify(err)}`)); },
    });
  });
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = Date.now();
    const id = setInterval(() => { let ok = false; try { ok = cond(); } catch {} if (ok) { clearInterval(id); resolve(); } else if (Date.now() - s > ms) { clearInterval(id); reject(new Error("SDK load timeout")); } }, 80);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function applyPolyfills(window: any): void {
  window.matchMedia = () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type: string) {
    if (/webgl/i.test(type)) return { canvas: this, getParameter: () => "Intel Inc.", getExtension: () => null, getSupportedExtensions: () => ["WEBGL_debug_renderer_info"], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }) };
    return { canvas: this, fillRect() {}, clearRect() {}, getImageData: (x: number, y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), setTransform() {}, transform() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, clip() {}, stroke() {}, fill() {}, arc() {}, rect() {}, ellipse() {}, translate() {}, scale() {}, rotate() {}, fillText() {}, strokeText() {}, measureText: (t: string) => ({ width: ("" + t).length * 8 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}), isPointInPath: () => false, font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start", fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "" };
  };
  proto.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb: any) => cb && cb(null);
  window.Worker = class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; onerror = null; };
  window.OffscreenCanvas = class { width = 0; height = 0; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return proto.getContext.call(this); } };
  try { Object.defineProperty(window.document, "hidden", { value: false, configurable: true }); Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true }); } catch {}
  const nav = window.navigator;
  for (const [k, v] of Object.entries({ userAgent: FAKE_UA, platform: "Win32", language: "en-US", languages: ["en-US", "en"], vendor: "Google Inc.", webdriver: false, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true, plugins: { length: 3, item: (): null => null, namedItem: (): null => null, refresh() {} }, mimeTypes: { length: 0, item: (): null => null, namedItem: (): null => null } })) { try { Object.defineProperty(nav, k, { value: v, configurable: true }); } catch {} }
  window.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  window.chrome = { runtime: {} }; window.outerWidth = 1920; window.outerHeight = 1080; window.innerWidth = 1280; window.innerHeight = 720; window.devicePixelRatio = 1;
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
