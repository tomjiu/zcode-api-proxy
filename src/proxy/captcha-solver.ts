/**
 * Standalone Aliyun captcha solver — spawned as a Bun subprocess.
 *
 * Must be runnable independently: `bun captcha-solver.ts <sceneId> <region> <prefix>`
 * Outputs: `VERIFY_PARAM=<token>` on stdout (success), or exits non-zero (failure).
 *
 * Ported from TriDefender/zcode-api PR #4 captcha_node/solver.js.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { existsSync } from "node:fs";

const SCENE = process.argv[2] || "11xygtvd";
const REGION = process.argv[3] || "sgp";
const PREFIX = process.argv[4] || "no8xfe";

const vc = new VirtualConsole();
vc.on("error", (...a: unknown[]) => process.stderr.write("[jsdom] " + a.join(" ") + "\n"));
vc.on("warn", (...a: unknown[]) => process.stderr.write("[jsdom warn] " + a.join(" ") + "\n"));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function applyPolyfills(window: any): void {
  window.matchMedia = () => ({
    matches: false, media: "", onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });

  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type: string) {
    if (/webgl/i.test(type)) {
      return {
        canvas: this, getParameter: () => "Intel Inc.", getExtension: () => null,
        getSupportedExtensions: () => ["WEBGL_debug_renderer_info"],
        getContextAttributes: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      };
    }
    return {
      canvas: this, fillRect() {}, clearRect() {},
      getImageData: (x: number, y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      setTransform() {}, transform() {}, drawImage() {}, save() {}, restore() {},
      beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
      closePath() {}, clip() {}, stroke() {}, fill() {}, arc() {}, rect() {}, ellipse() {},
      translate() {}, scale() {}, rotate() {}, fillText() {}, strokeText() {},
      measureText: (t: string) => ({ width: ("" + t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}), isPointInPath: () => false,
      font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start",
      fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "",
    };
  };
  proto.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb: any) => cb && cb(null);

  window.Worker = class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; onerror = null; };
  window.OffscreenCanvas = class { width = 0; height = 0; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return proto.getContext.call(this); } };

  try {
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  } catch {}

  const nav = window.navigator;
  const navPatch: Record<string, unknown> = {
    userAgent: USER_AGENT, platform: "Win32", language: "en-US", languages: ["en-US", "en"],
    vendor: "Google Inc.", webdriver: false, hardwareConcurrency: 8, deviceMemory: 8,
    maxTouchPoints: 0, cookieEnabled: true,
    plugins: { length: 3, item: () => null, namedItem: () => null, refresh() {} },
    mimeTypes: { length: 0, item: () => null, namedItem: () => null },
  };
  for (const [k, v] of Object.entries(navPatch)) {
    try { Object.defineProperty(nav, k, { value: v, configurable: true }); } catch {}
  }

  window.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920; window.outerHeight = 1080;
  window.innerWidth = 1280; window.innerHeight = 720;
  window.devicePixelRatio = 1;
}

const html = `<!DOCTYPE html><html><head></head><body>
<div id="captcha-element"></div><button id="captcha-button"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

const dom = new JSDOM(html, {
  url: "https://zcode.z.ai/",
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window: any) {
    applyPolyfills(window);
    window.AliyunCaptchaConfig = { region: REGION, prefix: PREFIX };
  },
});
const { window } = dom;

void existsSync;

function waitFor(cond: () => boolean, t = 12000): Promise<void> {
  return new Promise((res, rej) => {
    const s = Date.now();
    const i = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch {}
      if (ok) { clearInterval(i); res(); }
      else if (Date.now() - s > t) { clearInterval(i); rej(new Error("timeout")); }
    }, 80);
  });
}

(async () => {
  await waitFor(() => typeof (window as any).initAliyunCaptcha === "function");
  (window as any).initAliyunCaptcha({
    SceneId: SCENE,
    mode: "popup",
    region: REGION,
    prefix: PREFIX,
    language: "en",
    element: "#captcha-element",
    button: "#captcha-button",
    captchaLogoImg: "",
    showErrorTip: false,
    getInstance: (inst: any) => {
      try { (inst.startTracelessVerification || inst.show).call(inst); } catch (e: any) { console.error("start", e.message); }
    },
    success: (param: string) => {
      console.log("VERIFY_PARAM=" + param);
      process.exit(0);
    },
    fail: (err: unknown) => {
      process.stderr.write("fail=" + JSON.stringify(err) + "\n");
      process.exit(4);
    },
    onError: (err: unknown) => {
      process.stderr.write("onError=" + JSON.stringify(err) + "\n");
      process.exit(5);
    },
  });
  setTimeout(() => process.exit(2), 25000);
})().catch(() => process.exit(3));
