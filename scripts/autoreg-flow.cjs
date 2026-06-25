const { chromium } = require("playwright");
const fs = require("fs");
const { PNG } = require("pngjs");
const dm = require("./duckmail.cjs");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const CHROMIUM =
  "C:\\Users\\yezi6\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe";
const ZCODE_API_ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── CV: Sobel edge detection + gap detection ──────────────────────────────────

function grayAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
  const i = (y * img.width + x) * 4;
  return (
    0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
  );
}

function sobelMap(img) {
  const m = new Float32Array(img.width * img.height);
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const gx =
        grayAt(img, x + 1, y - 1) +
        2 * grayAt(img, x + 1, y) +
        grayAt(img, x + 1, y + 1) -
        (grayAt(img, x - 1, y - 1) +
          2 * grayAt(img, x - 1, y) +
          grayAt(img, x - 1, y + 1));
      const gy =
        grayAt(img, x - 1, y + 1) +
        2 * grayAt(img, x, y + 1) +
        grayAt(img, x + 1, y + 1) -
        (grayAt(img, x - 1, y - 1) +
          2 * grayAt(img, x, y - 1) +
          grayAt(img, x + 1, y - 1));
      m[y * img.width + x] = Math.hypot(gx, gy);
    }
  }
  return m;
}

function pieceBBox(puzzle) {
  let minX = puzzle.width,
    maxX = 0,
    minY = puzzle.height,
    maxY = 0;
  for (let y = 0; y < puzzle.height; y++)
    for (let x = 0; x < puzzle.width; x++)
      if (puzzle.data[(y * puzzle.width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function detectGap(bg, puzzle) {
  const bb = pieceBBox(puzzle);
  const fallback = { offset: 0, pieceMinX: bb.minX, pieceWidth: bb.w };
  if (bg.width - bb.w <= 0) return fallback;

  const bgEdge = sobelMap(bg);
  const gray = new Float32Array(bg.width * bg.height);
  for (let y = 0; y < bg.height; y++)
    for (let x = 0; x < bg.width; x++)
      gray[y * bg.width + x] =
        (bg.data[(y * bg.width + x) * 4] +
          bg.data[(y * bg.width + x) * 4 + 1] +
          bg.data[(y * bg.width + x) * 4 + 2]) /
        3;

  const inShape = (x, y) =>
    x >= 0 &&
    y >= 0 &&
    x < puzzle.width &&
    y < puzzle.height &&
    puzzle.data[(y * puzzle.width + x) * 4 + 3] > 40;
  const shape = [],
    edge = [];
  for (let py = bb.minY; py <= bb.maxY; py++)
    for (let px = bb.minX; px <= bb.maxX; px++) {
      if (!inShape(px, py)) continue;
      shape.push([px - bb.minX, py]);
      if (
        !inShape(px - 1, py) ||
        !inShape(px + 1, py) ||
        !inShape(px, py - 1) ||
        !inShape(px, py + 1)
      )
        edge.push([px - bb.minX, py]);
    }
  if (!shape.length || !edge.length) return fallback;

  const bright = [],
    edges = [];
  for (let x = 0; x <= bg.width - bb.w; x++) {
    let inSum = 0;
    for (const [dx, dy] of shape) inSum += gray[dy * bg.width + (x + dx)];
    const lx = Math.max(0, x - bb.w),
      rx = Math.min(bg.width - bb.w, x + bb.w);
    let lSum = 0,
      rSum = 0;
    for (const [dx, dy] of shape) {
      lSum += gray[dy * bg.width + (lx + dx)];
      rSum += gray[dy * bg.width + (rx + dx)];
    }
    bright.push(inSum / shape.length - (lSum + rSum) / (2 * shape.length));
    let es = 0;
    for (const [dx, dy] of edge) es += bgEdge[dy * bg.width + (x + dx)];
    edges.push(es / edge.length);
  }

  const norm = (arr) => {
    const mn = Math.min(...arr),
      mx = Math.max(...arr);
    return arr.map((v) => (mx > mn ? (v - mn) / (mx - mn) : 0));
  };
  const nb = norm(bright),
    ne = norm(edges);
  let bestX = 0,
    bestScore = -1;
  for (let x = 0; x < nb.length; x++) {
    const s = nb[x] * 0.6 + ne[x] * 0.4;
    if (s > bestScore) {
      bestScore = s;
      bestX = x;
    }
  }
  return { offset: bestX, pieceMinX: bb.minX, pieceWidth: bb.w };
}

// ─── Slider: two-phase closed-loop (from debug-solve.js — proven working) ───────

async function slideTo(page, targetLeft) {
  const info = await page.evaluate(() => {
    const s = document.getElementById("aliyunCaptcha-sliding-slider");
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!info) return -1;

  const readLeft = () =>
    page.evaluate(() => {
      const p = document.getElementById("aliyunCaptcha-puzzle");
      return p ? parseFloat(p.style.left) || 0 : 0;
    });

  // If the visual landing is consistently short/long on this machine, set e.g.
  // DEBUG_FLOW_SLIDE_BIAS=2 or DEBUG_FLOW_SLIDE_BIAS=-2 before running.
  const bias = Number(process.env.DEBUG_FLOW_SLIDE_BIAS || 0);
  const target = targetLeft + (Number.isFinite(bias) ? bias : 0);
  const startX = info.x + info.w / 2;
  const startY = info.y + info.h / 2;

  // Human-like pre-hover: avoids jumping straight to the handle and makes the
  // SDK animation start more consistently.
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      startX - 18 + Math.random() * 36,
      startY - 6 + Math.random() * 12,
      { steps: 3 },
    );
    await sleep(35 + Math.random() * 45);
  }
  await page.mouse.move(startX, startY, { steps: 6 });
  await sleep(140 + Math.random() * 80);
  await page.mouse.down();
  await sleep(120 + Math.random() * 80);

  let offsetX = 0;
  const maxDrag = Math.max(target + 50, 280);

  // Coarse phase: move in small variable increments while reading the real
  // puzzle position. Do not stop based on mouse offset; stop based on puzzle left.
  for (let iter = 0; iter < 90; iter++) {
    const left = await readLeft();
    const remain = target - left;
    if (Math.abs(remain) <= 1.2) {
      console.log(
        `  [slideTo] coarse arrived iter=${iter} left=${left.toFixed(1)} target=${target.toFixed(1)}`,
      );
      break;
    }
    const step = Math.max(1.5, Math.min(18, Math.abs(remain) * 0.55));
    offsetX += Math.sign(remain || 1) * step;
    offsetX = Math.max(0, Math.min(maxDrag, offsetX));
    await page.mouse.move(
      startX + offsetX,
      startY + (Math.random() - 0.5) * 2.2,
      { steps: 3 + Math.floor(Math.random() * 3) },
    );
    await sleep(55 + Math.random() * 45);
  }

  // Let Aliyun's eased puzzle animation settle before final correction.
  await sleep(260 + Math.random() * 160);

  // Fine phase: this is the key for the "always off by the same distance" case.
  // We keep the mouse down and compensate the measured residual directly.
  for (let k = 0; k < 10; k++) {
    const left = await readLeft();
    const remain = target - left;
    if (Math.abs(remain) <= 0.65) {
      console.log(
        `  [slideTo] fine settled k=${k} left=${left.toFixed(1)} target=${target.toFixed(1)}`,
      );
      break;
    }
    offsetX += remain;
    offsetX = Math.max(0, Math.min(maxDrag, offsetX));
    await page.mouse.move(
      startX + offsetX,
      startY + (Math.random() - 0.5) * 0.8,
      { steps: 2 },
    );
    await sleep(170 + Math.random() * 80);
  }

  const beforeUp = await readLeft();
  console.log(
    `  [slideTo] beforeUp=${beforeUp.toFixed(1)} target=${target.toFixed(1)} err=${(beforeUp - target).toFixed(1)} bias=${bias}`,
  );
  await sleep(280 + Math.random() * 180);
  await page.mouse.up();
  await sleep(450);

  const finalLeft = await readLeft();
  console.log(
    `  [slideTo] final=${finalLeft.toFixed(1)} target=${target.toFixed(1)} err=${(finalLeft - target).toFixed(1)}`,
  );
  return finalLeft;
}
// ─── Captcha: self-hosted widget + direct image download ───────────────────────

function fixCaptchaImageUrl(url) {
  if (!url) return url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  return "https://static-captcha-sgp.aliyuncs.com/" + url.replace(/^\//, "");
}

function downloadCaptchaImage(url) {
  return new Promise((resolve, reject) => {
    const fullUrl = fixCaptchaImageUrl(url);
    https
      .get(
        fullUrl,
        { timeout: 15000, headers: { referer: "https://chat.z.ai/" } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      )
      .on("error", reject);
  });
}

async function solveCaptcha(page) {
  // Mount self-hosted widget
  await page.evaluate(() => {
    const old = document.getElementById("zai-captcha-mount");
    if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.id = "zai-captcha-mount";
    wrap.innerHTML =
      '<div id="captcha-element"></div><div id="captcha-button" type="button">Verify</div>';
    wrap.style.cssText =
      "position:fixed;top:0;left:0;width:400px;height:300px;z-index:99999;background:#fff;";
    document.body.prepend(wrap);
  });

  // Load Aliyun SDK
  await page.addScriptTag({
    url: "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
  });
  await page.waitForFunction('typeof window.initAliyunCaptcha==="function"', {
    timeout: 30000,
  });
  await sleep(500);

  // Init widget with captchaVerifyCallback
  await page.evaluate(() => {
    window.__zaiCaptcha = {
      param: null,
      error: null,
      ready: false,
      callbackFired: false,
    };
    window.initAliyunCaptcha({
      SceneId: "36qgs6xb",
      prefix: "no8xfe",
      region: "sgp",
      language: "en",
      mode: "embed",
      element: "#captcha-element",
      button: "#captcha-button",
      slideStyle: { width: 320, height: 40 },
      getInstance(inst) {
        window.__zaiCaptchaInstance = inst;
      },
      captchaVerifyCallback: async function (captchaVerifyParam) {
        const raw = captchaVerifyParam;
        let p =
          typeof raw === "string"
            ? raw
            : (raw && (raw.captchaVerifyParam || raw.captcha_verify_param)) ||
              "";
        window.__zaiCaptcha.param = String(p || "").trim();
        window.__zaiCaptcha.callbackFired = true;
        console.log("[callback] param len:", window.__zaiCaptcha.param.length);
        return { captchaResult: Boolean(window.__zaiCaptcha.param) };
      },
      onError(e) {
        window.__zaiCaptcha.error = JSON.stringify(e);
      },
    });
    window.__zaiCaptcha.ready = true;
  });
  await sleep(800);

  // Click button to trigger captcha open
  console.log("[captcha] Triggering widget...");
  const btn = await page.$("#captcha-button");
  const btnBox = await btn.boundingBox();
  await page.mouse.click(
    btnBox.x + btnBox.width / 2,
    btnBox.y + btnBox.height / 2,
  );
  await sleep(4000);

  // Capture init payload from captcha-open API
  let initPayload = null;
  const initResolve = (() => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  })();

  const onResponse = async (response) => {
    const url = response.url();
    if (
      url.includes("captcha-open") &&
      !url.includes("verify") &&
      !/\.(js|png|jpg|css|svg)/i.test(url)
    ) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        const candidates = [data, data.Result, data.Data, data.data];
        for (const c of candidates) {
          if (c?.Image && c?.PuzzleImage) {
            initPayload = c;
            console.log(
              "[captcha] Init captured, CertifyId:",
              c.CertifyId?.slice(0, 8),
            );
            initResolve.resolve(c);
            return;
          }
        }
      } catch {}
    }
  };

  page.on("response", onResponse);

  // Try refresh if needed
  if (!initPayload) {
    const ref = await page.$("#aliyunCaptcha-btn-refresh");
    if (ref) {
      await ref.click();
      await sleep(3000);
    }
  }

  await Promise.race([initResolve.promise, sleep(10000)]).catch(() => {});

  // Fallback: DOM scraping
  if (!initPayload) {
    initPayload = await page.evaluate(() => {
      const srcs = [...document.querySelectorAll("img")]
        .map((i) => i.src)
        .filter(Boolean);
      const back = srcs.find((s) => /back\.png/i.test(s));
      const puzzle = srcs.find((s) => /shadow\.png|puzzle\.png/i.test(s));
      if (back && puzzle) return { Image: back, PuzzleImage: puzzle };
      const imgs = document.querySelectorAll(
        "#aliyunCaptcha-img, #aliyunCaptcha-puzzle",
      );
      if (imgs.length === 2)
        return { Image: imgs[0].src, PuzzleImage: imgs[1].src };
      return null;
    });
  }

  if (!initPayload?.Image) {
    console.log("[captcha] ERROR: no captcha init payload");
    page.off("response", onResponse);
    return null;
  }

  // Download images via HTTPS (direct, bypasses CORS)
  console.log("[captcha] Downloading images...");
  let backBuf, puzzleBuf;
  try {
    [backBuf, puzzleBuf] = await Promise.all([
      downloadCaptchaImage(initPayload.Image),
      downloadCaptchaImage(initPayload.PuzzleImage),
    ]);
    console.log(`  HTTPS: bg=${backBuf.length} puzzle=${puzzleBuf.length}`);
  } catch (e) {
    console.log("  HTTPS failed, trying page fetch...");
    [backBuf, puzzleBuf] = await Promise.all([
      page.evaluate(async (url) => {
        const r = await fetch(url);
        const ab = await r.arrayBuffer();
        return [...new Uint8Array(ab)];
      }, fixCaptchaImageUrl(initPayload.Image)),
      page.evaluate(async (url) => {
        const r = await fetch(url);
        const ab = await r.arrayBuffer();
        return [...new Uint8Array(ab)];
      }, fixCaptchaImageUrl(initPayload.PuzzleImage)),
    ]);
    backBuf = Buffer.from(backBuf);
    puzzleBuf = Buffer.from(puzzleBuf);
  }
  console.log(`  Final: bg=${backBuf.length}px puzzle=${puzzleBuf.length}px`);

  const bgPng = PNG.sync.read(Buffer.from(backBuf));
  const pzPng = PNG.sync.read(Buffer.from(puzzleBuf));
  console.log(
    `[captcha] Images: bg=${bgPng.width}x${bgPng.height} puzzle=${pzPng.width}x${pzPng.height}`,
  );

  // Detect gap with Sobel
  const gap = detectGap(
    { width: bgPng.width, height: bgPng.height, data: bgPng.data },
    { width: pzPng.width, height: pzPng.height, data: pzPng.data },
  );
  const effectiveGap = gap.offset - gap.pieceMinX;
  console.log(
    `[captcha] Gap: ${gap.offset}px, pieceMinX: ${gap.pieceMinX}, effectiveGap: ${effectiveGap}px`,
  );

  // Scale to rendered size
  const renderedBgW = await page.evaluate(() => {
    const sel = "#aliyunCaptcha-img-box, img.puzzle, #aliyunCaptcha-img";
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().width : bgPng.width * 0.72;
  });
  const scale = renderedBgW / bgPng.width;
  const targetLeft = effectiveGap * scale;
  console.log(
    `[captcha] Rendered BG: ${renderedBgW.toFixed(1)}px, scale: ${scale.toFixed(3)}, targetLeft: ${targetLeft.toFixed(1)}`,
  );

  // Slide to target
  console.log("[captcha] Sliding...");
  const finalLeft = await slideTo(page, targetLeft);
  console.log(
    `[captcha] Slide done: final=${finalLeft.toFixed(1)} target=${targetLeft.toFixed(1)} err=${(finalLeft - targetLeft).toFixed(1)}`,
  );

  // Capture verify API response to see if SDK auto-submits
  let verifyApiResponse = null;
  let verifyCertifyId = null;
  const verifyHandler = async (resp) => {
    const url = resp.url();
    if (
      url.includes("captcha") &&
      url.includes("verify") &&
      !url.includes("init")
    ) {
      try {
        const json = await resp.json();
        verifyApiResponse = json;
        verifyCertifyId = json.Result?.certifyId || json.certifyId;
        console.log(
          `[verify-api] code=${json.Result?.VerifyCode} result=${json.Result?.VerifyResult} certifyId=${verifyCertifyId?.slice(0, 12)}`,
        );
        console.log(`[verify-api] FULL: ${JSON.stringify(json).slice(0, 300)}`);
      } catch (e) {
        console.log(`[verify-api] parse error: ${e.message}`);
      }
    }
  };
  page.on("response", verifyHandler);

  // Wait for SDK to potentially auto-submit
  await sleep(2000);

  if (verifyApiResponse) {
    console.log("[captcha] SDK auto-submitted verify!");
  }

  // If SDK didn't auto-submit, click verify button
  if (!verifyApiResponse) {
    console.log("[captcha] No auto-verify, clicking verify button...");
    const verifyBtn = await page.$("#captcha-button");
    if (verifyBtn) {
      const vBox = await verifyBtn.boundingBox();
      await page.mouse.click(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
    }
  }

  // Poll for captchaVerifyCallback result
  let fullParam = null;
  for (let i = 0; i < 20; i++) {
    const state = await page.evaluate(() => {
      const s = window.__zaiCaptcha;
      return {
        param: s?.param,
        paramLen: s?.param?.length || 0,
        callbackFired: s?.callbackFired,
      };
    });
    if (state.paramLen > 20) {
      fullParam = state.param;
      console.log(`[captcha] SOLVED! paramLen=${state.paramLen}`);
      try {
        const obj = JSON.parse(fullParam);
        console.log(`  certifyId: ${obj.certifyId}`);
        console.log(`  deviceToken: ${obj.deviceToken?.slice(0, 30)}`);
      } catch {}
      break;
    }
    // Also check if puzzle reset (SDK rejected our slide position)
    if (i === 2) {
      const puzzlePos = await page.evaluate(() => {
        const p = document.getElementById("aliyunCaptcha-puzzle");
        return p ? parseFloat(p.style.left) || 0 : 0;
      });
      if (puzzlePos < 1 && finalLeft > 10) {
        console.log(
          `[captcha] Puzzle RESET detected! finalLeft was ${finalLeft.toFixed(1)} but now at ${puzzlePos}`,
        );
      }
    }
    console.log(
      `[captcha] Waiting... paramLen=${state.paramLen} fired=${state.callbackFired} verifyApi=${verifyApiResponse ? "yes" : "no"} (${i + 1}/20)`,
    );
    await sleep(1000);
  }

  page.off("response", onResponse);
  page.off("response", verifyHandler);
  return fullParam;
}

async function findCaptchaFrame(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await frame
        .locator("#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider")
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (found) return frame;
    }
    await sleep(350);
  }
  return null;
}

async function scrapeCaptchaInitFromFrame(frame) {
  return frame.evaluate(() => {
    const srcs = [...document.querySelectorAll("img")]
      .map((i) => i.src)
      .filter(Boolean);
    const back = srcs.find((s) => /back\.png/i.test(s));
    const puzzle = srcs.find((s) => /shadow\.png|puzzle\.png/i.test(s));
    if (back && puzzle) return { Image: back, PuzzleImage: puzzle };
    const imgs = document.querySelectorAll(
      "#aliyunCaptcha-img, #aliyunCaptcha-puzzle",
    );
    if (imgs.length === 2)
      return { Image: imgs[0].src, PuzzleImage: imgs[1].src };
    return null;
  });
}

async function slideToFrame(page, frame, targetLeft) {
  const handle = frame
    .locator("#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider")
    .first();
  const box = await handle.boundingBox({ timeout: 10000 }).catch(() => null);
  if (!box) return -1;

  const readLeft = () =>
    frame.evaluate(() => {
      const p = document.querySelector(
        "#aliyunCaptcha-puzzle, .aliyunCaptcha-puzzle",
      );
      return p ? parseFloat(p.style.left) || 0 : 0;
    });

  const bias = Number(process.env.DEBUG_FLOW_SLIDE_BIAS || 0);
  const target = targetLeft + (Number.isFinite(bias) ? bias : 0);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      startX - 18 + Math.random() * 36,
      startY - 6 + Math.random() * 12,
      { steps: 3 },
    );
    await sleep(35 + Math.random() * 45);
  }
  await page.mouse.move(startX, startY, { steps: 6 });
  await sleep(140 + Math.random() * 80);
  await page.mouse.down();
  await sleep(120 + Math.random() * 80);

  let offsetX = 0;
  const maxDrag = Math.max(target + 50, 280);
  for (let iter = 0; iter < 90; iter++) {
    const left = await readLeft();
    const remain = target - left;
    if (Math.abs(remain) <= 1.2) {
      console.log(
        `  [oauth-slide] coarse arrived iter=${iter} left=${left.toFixed(1)} target=${target.toFixed(1)}`,
      );
      break;
    }
    const step = Math.max(1.5, Math.min(18, Math.abs(remain) * 0.55));
    offsetX += Math.sign(remain || 1) * step;
    offsetX = Math.max(0, Math.min(maxDrag, offsetX));
    await page.mouse.move(
      startX + offsetX,
      startY + (Math.random() - 0.5) * 2.2,
      { steps: 3 + Math.floor(Math.random() * 3) },
    );
    await sleep(55 + Math.random() * 45);
  }

  await sleep(260 + Math.random() * 160);
  for (let k = 0; k < 10; k++) {
    const left = await readLeft();
    const remain = target - left;
    if (Math.abs(remain) <= 0.65) {
      console.log(
        `  [oauth-slide] fine settled k=${k} left=${left.toFixed(1)} target=${target.toFixed(1)}`,
      );
      break;
    }
    offsetX += remain;
    offsetX = Math.max(0, Math.min(maxDrag, offsetX));
    await page.mouse.move(
      startX + offsetX,
      startY + (Math.random() - 0.5) * 0.8,
      { steps: 2 },
    );
    await sleep(170 + Math.random() * 80);
  }

  const beforeUp = await readLeft();
  console.log(
    `  [oauth-slide] beforeUp=${beforeUp.toFixed(1)} target=${target.toFixed(1)} err=${(beforeUp - target).toFixed(1)} bias=${bias}`,
  );
  await sleep(280 + Math.random() * 180);
  await page.mouse.up();
  await sleep(650);
  const finalLeft = await readLeft();
  console.log(
    `  [oauth-slide] final=${finalLeft.toFixed(1)} target=${target.toFixed(1)} err=${(finalLeft - target).toFixed(1)}`,
  );
  return finalLeft;
}

async function hasVerificationPassed(page) {
  const pageText = await page
    .evaluate(() => document.body.innerText)
    .catch(() => "");
  if (/verification passed|验证通过|校验通过/i.test(pageText)) return true;
  for (const frame of page.frames()) {
    const text = await frame
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    if (/verification passed|验证通过|校验通过/i.test(text)) return true;
  }
  return false;
}

async function solveOAuthLoginCaptcha(page) {
  if (await hasVerificationPassed(page)) return true;

  let initPayload = null;
  const initResolve = (() => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  })();
  const onResponse = async (response) => {
    const url = response.url();
    if (
      url.includes("captcha-open") &&
      !url.includes("verify") &&
      !/\.(js|png|jpg|css|svg)/i.test(url)
    ) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        const candidates = [data, data.Result, data.Data, data.data];
        for (const c of candidates) {
          if (c?.Image && c?.PuzzleImage) {
            initPayload = c;
            console.log("  [oauth-captcha] Init captured");
            initResolve.resolve(c);
            return;
          }
        }
      } catch {}
    }
  };
  page.on("response", onResponse);

  try {
    const triggered = await clickFirstVisible(
      page,
      [
        "#captcha-button",
        'button:has-text("Click to start verification")',
        "text=/Click to start verification/i",
        "text=/start verification/i",
        "text=/verification/i",
        "text=/验证/i",
      ],
      8000,
    );
    if (!triggered) {
      await page
        .evaluate(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              st.visibility !== "hidden" &&
              st.display !== "none"
            );
          };
          const el = [
            ...document.querySelectorAll("button, [role=button], div, span"),
          ].find(
            (n) =>
              visible(n) &&
              /click to start verification|start verification|verification|验证/i.test(
                n.textContent || "",
              ),
          );
          if (el) el.click();
        })
        .catch(() => {});
    }

    await Promise.race([initResolve.promise, sleep(6000)]).catch(() => {});
    const frame = await findCaptchaFrame(page, 15000);
    if (!frame) {
      console.log(
        "  [oauth-captcha] No slider frame found; assuming no captcha is required",
      );
      return true;
    }
    if (!initPayload)
      initPayload = await scrapeCaptchaInitFromFrame(frame).catch(() => null);
    if (!initPayload?.Image || !initPayload?.PuzzleImage) {
      console.log("  [oauth-captcha] No captcha images found");
      return false;
    }

    console.log("  [oauth-captcha] Downloading images...");
    let backBuf, puzzleBuf;
    try {
      [backBuf, puzzleBuf] = await Promise.all([
        downloadCaptchaImage(initPayload.Image),
        downloadCaptchaImage(initPayload.PuzzleImage),
      ]);
    } catch {
      [backBuf, puzzleBuf] = await Promise.all([
        frame.evaluate(async (url) => {
          const r = await fetch(url);
          const ab = await r.arrayBuffer();
          return [...new Uint8Array(ab)];
        }, fixCaptchaImageUrl(initPayload.Image)),
        frame.evaluate(async (url) => {
          const r = await fetch(url);
          const ab = await r.arrayBuffer();
          return [...new Uint8Array(ab)];
        }, fixCaptchaImageUrl(initPayload.PuzzleImage)),
      ]);
      backBuf = Buffer.from(backBuf);
      puzzleBuf = Buffer.from(puzzleBuf);
    }

    const bgPng = PNG.sync.read(Buffer.from(backBuf));
    const pzPng = PNG.sync.read(Buffer.from(puzzleBuf));
    const gap = detectGap(
      { width: bgPng.width, height: bgPng.height, data: bgPng.data },
      { width: pzPng.width, height: pzPng.height, data: pzPng.data },
    );
    const effectiveGap = gap.offset - gap.pieceMinX;
    const renderedBgW = await frame
      .evaluate(() => {
        const el = document.querySelector(
          "#aliyunCaptcha-img-box, img.puzzle, #aliyunCaptcha-img",
        );
        return el ? el.getBoundingClientRect().width : 0;
      })
      .catch(() => 0);
    const scale = (renderedBgW || bgPng.width * 0.72) / bgPng.width;
    const targetLeft = effectiveGap * scale;
    console.log(
      `  [oauth-captcha] gap=${gap.offset}px pieceMinX=${gap.pieceMinX} rendered=${(renderedBgW || bgPng.width * 0.72).toFixed(1)} target=${targetLeft.toFixed(1)}`,
    );

    const finalLeft = await slideToFrame(page, frame, targetLeft);
    console.log(
      `  [oauth-captcha] Slide done: final=${finalLeft.toFixed(1)} target=${targetLeft.toFixed(1)} err=${(finalLeft - targetLeft).toFixed(1)}`,
    );

    for (let i = 0; i < 15; i++) {
      if (await hasVerificationPassed(page)) {
        console.log("  [oauth-captcha] Verification Passed");
        return true;
      }
      await sleep(700);
    }
    const stillVisible = await findCaptchaFrame(page, 1000);
    return !stillVisible;
  } finally {
    page.off("response", onResponse);
  }
}

async function clickOAuthSignIn(page) {
  const selectors = [
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("登录")',
    'button[type="submit"]',
  ];
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        if (
          (await item.isVisible().catch(() => false)) &&
          (await item.isEnabled().catch(() => false))
        ) {
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item
            .click({ timeout: 8000 })
            .catch(() => item.click({ force: true, timeout: 8000 }));
          console.log("  OAuth Sign in clicked");
          return true;
        }
      }
    }
    await sleep(700);
  }
  return false;
}

async function clickOAuthConsent(page) {
  const buttonSelectors = [
    'button:has-text("Continue")',
    'button:has-text("Authorize")',
    'button:has-text("Approve")',
    'button:has-text("Allow")',
    'button:has-text("Confirm")',
    'button:has-text("Agree")',
    'button:has-text("Accept")',
    'button:has-text("同意")',
    'button:has-text("授权")',
    'button:has-text("确认")',
    'button:has-text("继续")',
    'button[type="submit"]',
  ];
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (/\/oauth\/callback\/zai/i.test(page.url())) return true;
    const text = await page
      .evaluate(() => document.body.innerText.replace(/\s+/g, " "))
      .catch(() => "");
    const looksLikeConsent =
      /would like to access|access your Z\.ai account|authorize|authorization|allow|continue|terms|privacy|agreement|用户协议|服务条款|隐私|授权|同意|继续|确认/i.test(
        text,
      ) || /\/(api|auth)\/oauth\/authorize/i.test(page.url());

    if (looksLikeConsent) {
      const boxes = page.locator('input[type="checkbox"]');
      const count = await boxes.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const box = boxes.nth(i);
        if (await box.isVisible().catch(() => false)) {
          await box
            .check({ timeout: 3000 })
            .catch(() =>
              box.click({ force: true, timeout: 3000 }).catch(() => {}),
            );
        }
      }
      await page
        .evaluate(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              st.visibility !== "hidden" &&
              st.display !== "none"
            );
          };
          for (const el of document.querySelectorAll(
            "label, [role=checkbox], .checkbox, span, div",
          )) {
            if (
              visible(el) &&
              /terms|privacy|agreement|用户协议|服务条款|隐私|同意/i.test(
                el.textContent || "",
              )
            ) {
              el.click();
              break;
            }
          }
        })
        .catch(() => {});

      if (await clickFirstVisible(page, buttonSelectors, 8000)) {
        console.log("  OAuth consent button clicked");
        await page
          .waitForLoadState("domcontentloaded", { timeout: 20000 })
          .catch(() => {});
        await sleep(1500);
        return true;
      }
      const clicked = await page
        .evaluate(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return (
              r.width > 0 &&
              r.height > 0 &&
              st.visibility !== "hidden" &&
              st.display !== "none"
            );
          };
          const btn = [
            ...document.querySelectorAll("button, [role=button]"),
          ].find(
            (b) =>
              visible(b) &&
              !b.disabled &&
              /continue|authorize|approve|allow|confirm|agree|accept|同意|授权|确认|继续/i.test(
                b.textContent || "",
              ),
          );
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (clicked) {
        console.log("  OAuth consent button clicked by fallback");
        await page
          .waitForLoadState("domcontentloaded", { timeout: 20000 })
          .catch(() => {});
        await sleep(1500);
        return true;
      }
    }
    await sleep(1000);
  }
  return false;
}

// ─── Browser setup ─────────────────────────────────────────────────────────────

async function launchBrowser() {
  const userDataDir =
    process.env.DEBUG_FLOW_USER_DATA_DIR ||
    path.join(ZCODE_API_ROOT, ".playwright-user-data");
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`  Browser profile: ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-CN", "zh", "en"],
    });
    window.chrome = { runtime: {}, app: { isInstalled: false } };
  });
  const page = context.pages()[0] || (await context.newPage());
  return { browser: context, page };
}

// ─── HTTP helpers for API calls ────────────────────────────────────────────────

function httpsRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, data: safeJsonParse(text) };
}

function waitForMatchingResponse(page, matcher, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off("response", onResponse);
      resolve(null);
    }, timeoutMs);
    const onResponse = async (response) => {
      if (!matcher(response.url())) return;
      clearTimeout(timer);
      page.off("response", onResponse);
      const body = await response.text().catch(() => "");
      resolve({ status: response.status(), ok: response.ok(), body });
    };
    page.on("response", onResponse);
  });
}

async function fillVisible(locator, value, timeout = 8000) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.fill(value, { timeout });
      return true;
    }
  }
  return false;
}

async function clickFirstVisible(page, selectors, timeout = 8000) {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.scrollIntoViewIfNeeded().catch(() => {});
        await item
          .click({ timeout })
          .catch(async () => item.click({ force: true, timeout }));
        return true;
      }
    }
  }
  return false;
}

async function finishSignupInBrowser(
  page,
  { verifyToken, verifyCode, email, username, password },
) {
  if (!verifyToken && !verifyCode) return null;
  const tokenForUrl = verifyToken || verifyCode;
  const verifyUrl = `https://chat.z.ai/auth/verify_email?token=${encodeURIComponent(tokenForUrl)}&email=${encodeURIComponent(email)}&username=${encodeURIComponent(username)}&language=en`;

  console.log("  Opening verify_email page and submitting password form...");
  const autoFinish = waitForMatchingResponse(
    page,
    (url) => url.includes("/api/v1/auths/finish_signup"),
    20000,
  );
  await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2500);
  console.log(`  verify_email page URL: ${page.url()}`);
  console.log(
    `  verify_email text: ${(await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 200)}`,
  );

  let result = await Promise.race([autoFinish, sleep(1200).then(() => null)]);
  if (result?.ok && result.body.includes('"success"')) return result;

  const formFilled = await page.evaluate(
    ({ username, email, password }) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          st.visibility !== "hidden" &&
          st.display !== "none"
        );
      };
      const inputs = [...document.querySelectorAll("input")].filter(visible);
      const textInputs = inputs.filter(
        (i) => (i.type || "text").toLowerCase() !== "password",
      );
      const passInputs = inputs.filter(
        (i) => (i.type || "").toLowerCase() === "password",
      );
      const emailInput =
        textInputs.find(
          (i) =>
            (i.type || "").toLowerCase() === "email" ||
            /email|邮箱/i.test(i.placeholder || i.name || i.autocomplete || ""),
        ) || textInputs[1];
      const userInput =
        textInputs.find(
          (i) =>
            i !== emailInput &&
            /user|name|用户名/i.test(
              i.placeholder || i.name || i.autocomplete || "",
            ),
        ) || textInputs[0];
      const setValue = (el, value) => {
        if (!el) return false;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      return {
        user: setValue(userInput, username),
        email: setValue(emailInput, email),
        pass1: setValue(passInputs[0], password),
        pass2: setValue(passInputs[1], password),
        inputCount: inputs.length,
        passCount: passInputs.length,
      };
    },
    { username, email, password },
  );
  console.log(`  form fill: ${JSON.stringify(formFilled)}`);

  const finishResponse = waitForMatchingResponse(
    page,
    (url) => url.includes("/api/v1/auths/finish_signup"),
    30000,
  );
  const clicked = await clickFirstVisible(
    page,
    [
      'button:has-text("完成注册")',
      'button:has-text("Complete")',
      'button:has-text("Finish")',
      'button:has-text("Sign up")',
      'button[type="submit"]',
    ],
    10000,
  );
  if (!clicked) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button")];
      const btn =
        buttons.find(
          (b) =>
            !b.disabled &&
            /完成注册|complete|finish|sign up|注册/i.test(
              (b.textContent || "").trim(),
            ),
        ) || buttons.find((b) => !b.disabled);
      if (btn) btn.click();
    });
  }
  result = await finishResponse;
  if (!result) {
    console.log(
      "  No browser finish response captured; trying browser fetch fallback...",
    );
    result = await page.evaluate(
      async ({ username, email, password, token, verifyUrl }) => {
        const res = await fetch(
          "https://chat.z.ai/api/v1/auths/finish_signup",
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "x-region": "overseas",
              Referer: verifyUrl,
            },
            body: JSON.stringify({
              username,
              email,
              password,
              token,
              profile_image_url:
                "https://api.dicebear.com/7.x/bottts/svg?seed=" + username,
              sso_redirect: null,
            }),
          },
        );
        return { status: res.status, ok: res.ok, body: await res.text() };
      },
      { username, email, password, token: tokenForUrl, verifyUrl },
    );
  }
  console.log(
    `  browser finish_signup: status=${result.status} body=${result.body.slice(0, 300)}`,
  );
  return result;
}

async function platformLogin(chatToken) {
  return requestJson("https://api.z.ai/api/auth/z/login", {
    method: "POST",
    headers: { Origin: "https://z.ai", Referer: "https://z.ai/" },
    body: JSON.stringify({ token: chatToken }),
  });
}

async function getCustomerInfo(platformToken) {
  return requestJson("https://api.z.ai/api/biz/customer/getCustomerInfo", {
    method: "GET",
    headers: { Authorization: `Bearer ${platformToken}` },
  });
}

async function createPlatformApiKey(platformToken, orgId, projectId, keyName) {
  return requestJson(
    `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${platformToken}` },
      body: JSON.stringify({ name: keyName }),
    },
  );
}

async function copyPlatformApiKeySecret(
  platformToken,
  orgId,
  projectId,
  apiKey,
) {
  return requestJson(
    `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${platformToken}` },
    },
  );
}

async function resolvePlatformApiKey(chatToken, username) {
  console.log("\n[8] Platform login + Open Platform API key...");
  const login = await platformLogin(chatToken);
  console.log(
    `  platform login: status=${login.status} body=${login.text.slice(0, 200)}`,
  );
  const platformToken =
    login.data?.data?.access_token || login.data?.access_token;
  if (!login.ok || !platformToken) throw new Error("platform login failed");

  const info = await getCustomerInfo(platformToken);
  console.log(`  customer info: status=${info.status}`);
  const orgs = info.data?.data?.organizations || info.data?.organizations || [];
  if (!orgs.length) throw new Error("no organizations in getCustomerInfo");
  const org = orgs[0];
  const project = org.projects?.[0];
  if (!org.organizationId || !project?.projectId)
    throw new Error("missing organization/project id");

  const keyName = `zcode_${username.slice(0, 8)}_${Date.now().toString(36)}`;
  const created = await createPlatformApiKey(
    platformToken,
    org.organizationId,
    project.projectId,
    keyName,
  );
  console.log(
    `  create api key: status=${created.status} body=${created.text.slice(0, 200)}`,
  );
  const apiKeyId = created.data?.data?.apiKey || created.data?.apiKey;
  if (!created.ok || !apiKeyId) throw new Error("createApiKey failed");

  const copied = await copyPlatformApiKeySecret(
    platformToken,
    org.organizationId,
    project.projectId,
    apiKeyId,
  );
  console.log(
    `  copy api key secret: status=${copied.status} body=${copied.text.slice(0, 200)}`,
  );
  const secret =
    copied.data?.data?.secretKey ||
    copied.data?.secretKey ||
    copied.data?.secret_key;
  if (!copied.ok || !secret || String(secret).includes("***"))
    throw new Error("copy secret failed");

  return {
    platformToken,
    orgId: org.organizationId,
    projectId: project.projectId,
    apiKey: `${apiKeyId}.${secret}`,
    apiKeyId,
    secret,
  };
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function initZcodeCliOAuth() {
  const pollToken = randomHex(32);
  const res = await requestJson("https://zcode.z.ai/api/v1/oauth/cli/init", {
    method: "POST",
    headers: { Authorization: `Bearer ${pollToken}` },
    body: JSON.stringify({ provider: "zai" }),
  });
  if (!res.ok || res.data?.code !== 0 || !res.data?.data)
    throw new Error(
      `ZCode OAuth init failed: ${res.status} ${res.text.slice(0, 200)}`,
    );
  return res.data.data;
}

async function pollZcodeCliOAuth(flowId, pollToken) {
  const res = await requestJson(
    `https://zcode.z.ai/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${pollToken}` },
    },
  );
  if (!res.ok || res.data?.code !== 0)
    throw new Error(
      `ZCode OAuth poll failed: ${res.status} ${res.text.slice(0, 200)}`,
    );
  const data = res.data?.data;
  if (!data) throw new Error("ZCode OAuth poll empty data");
  if (data.status === "pending" || data.status === "failed")
    return { status: data.status };
  if (
    data.status === "ready" &&
    data.token &&
    data.user?.user_id &&
    data.zai?.access_token
  ) {
    return {
      status: "ready",
      jwt: data.token,
      oauth_access_token: data.zai.access_token,
      user_id: data.user.user_id,
      email: data.user.email,
      name: data.user.name,
    };
  }
  throw new Error(
    `ZCode OAuth poll unexpected payload: ${JSON.stringify(data).slice(0, 200)}`,
  );
}

async function waitZcodeOAuthReady(flowId, pollToken, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    const result = await pollZcodeCliOAuth(flowId, pollToken);
    if (result.status === "ready") return result;
    if (result.status === "failed")
      throw new Error("ZCode OAuth authorization failed");
    tick++;
    if (tick % 3 === 0) console.log("  OAuth poll pending...");
    await sleep(2000);
  }
  throw new Error("ZCode OAuth poll timeout");
}

async function completeZcodeOAuth(page, email, password) {
  console.log("\n[9] ZCode OAuth auth-code flow...");
  const state = randomHex(32);
  const callbackPath = "/oauth/callback/zai";
  const callback = await new Promise((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => {
      server.close(() => {});
      reject(new Error("OAuth callback timeout"));
    }, 300000);
    server.on("request", (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      const gotState = url.searchParams.get("state") || "";
      const code =
        url.searchParams.get("authCode") || url.searchParams.get("code") || "";
      if (gotState !== state || !code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Authorization failed: state mismatch or missing code.");
        clearTimeout(timer);
        server.close(() =>
          reject(new Error("OAuth callback state mismatch or missing code")),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Authorization successful! You may close this window.");
      clearTimeout(timer);
      server.close(() => resolve({ code, callbackUrl }));
    });
    server.on("error", reject);
    let callbackUrl = "";
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("Failed to bind OAuth callback server"));
        return;
      }
      callbackUrl = `http://127.0.0.1:${addr.port}${callbackPath}`;
      resolve({ server, callbackUrl, wait: true });
    });
  });

  // The first resolution is the server-ready marker; keep a second promise for the real callback.
  let callbackUrl;
  let authCodePromise;
  if (callback.wait) {
    callbackUrl = callback.callbackUrl;
    authCodePromise = new Promise((resolve, reject) => {
      const server = callback.server;
      const timer = setTimeout(() => {
        server.close(() => {});
        reject(new Error("OAuth callback timeout"));
      }, 300000);
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }
        const gotState = url.searchParams.get("state") || "";
        const code =
          url.searchParams.get("authCode") ||
          url.searchParams.get("code") ||
          "";
        if (gotState !== state || !code) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Authorization failed: state mismatch or missing code.");
          clearTimeout(timer);
          server.close(() =>
            reject(new Error("OAuth callback state mismatch or missing code")),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("Authorization successful! You may close this window.");
        clearTimeout(timer);
        server.close(() => resolve(code));
      });
    });
  } else {
    throw new Error("OAuth callback server failed to start");
  }

  const authorizeUrl =
    "https://chat.z.ai/api/oauth/authorize?" +
    new URLSearchParams({
      redirect_uri: callbackUrl,
      response_type: "code",
      client_id: "client_P8X5CMWmlaRO9gyO-KSqtg",
      state,
    }).toString();
  console.log(`  authorize_url: ${authorizeUrl}`);

  await page.goto(authorizeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await sleep(2500);
  console.log(`  OAuth page: ${page.url()}`);

  const bodyText = await page
    .evaluate(() => document.body.innerText)
    .catch(() => "");
  if (
    /continue with email|enter your email|sign in|log in|登录|邮箱/i.test(
      bodyText,
    )
  ) {
    let emailVisible = await fillVisible(
      page.locator(
        'input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]',
      ),
      email,
    ).catch(() => false);
    if (!emailVisible) {
      await clickFirstVisible(
        page,
        ['button:has-text("Continue with Email")', "text=Continue with Email"],
        30000,
      ).catch(() => {});
      emailVisible = await fillVisible(
        page.locator(
          'input[type="email"], input[placeholder*="email" i], input[placeholder*="Email" i]',
        ),
        email,
        30000,
      );
    }
    await fillVisible(
      page.locator(
        'input[type="password"], input[placeholder*="password" i], input[placeholder*="Password" i]',
      ),
      password,
      15000,
    );
    console.log(`  OAuth login form filled email=${emailVisible}`);

    const captchaOk = await solveOAuthLoginCaptcha(page).catch((e) => {
      console.log(`  OAuth captcha error: ${e.message}`);
      return false;
    });
    console.log(`  OAuth captcha ok=${captchaOk}`);

    const signInClicked = await clickOAuthSignIn(page);
    if (!signInClicked) throw new Error("OAuth Sign in button not clickable");
    await page
      .waitForLoadState("domcontentloaded", { timeout: 45000 })
      .catch(() => {});
    await sleep(3500);
    console.log(`  OAuth after login page: ${page.url()}`);
  }

  await Promise.race([
    authCodePromise.then(() => true),
    clickOAuthConsent(page),
    sleep(90000).then(() => false),
  ]).catch(() => false);

  const authCode = await authCodePromise;
  console.log(`  OAuth authCode: ${String(authCode).slice(0, 12)}...`);
  const exchange = await requestJson("https://zcode.z.ai/api/v1/oauth/token", {
    method: "POST",
    body: JSON.stringify({
      provider: "zai",
      code: authCode,
      redirect_uri: callbackUrl,
      state,
    }),
  });
  console.log(
    `  token exchange: status=${exchange.status} body=${exchange.text.slice(0, 200)}`,
  );
  if (
    !exchange.ok ||
    (typeof exchange.data?.code === "number" && exchange.data.code !== 0)
  ) {
    throw new Error(
      `OAuth token exchange failed: ${exchange.status} ${exchange.text.slice(0, 200)}`,
    );
  }
  const data = exchange.data?.data || {};
  const accessToken = data.zai?.access_token;
  const jwt = data.token;
  const userId = data.user?.user_id;
  if (!accessToken || !jwt)
    throw new Error("OAuth token response missing access token or jwt");
  console.log(
    `  ZCode JWT OK user=${userId || "(unknown)"} jwt=${jwt.slice(0, 16)}...`,
  );
  return { jwt, oauth_access_token: accessToken, user_id: userId };
}

function parseJwtUserId(jwt) {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    );
    return json.user_id || json.sub || null;
  } catch {
    return null;
  }
}

function upsertAccountPool(account) {
  const storePath = path.join(os.homedir(), ".zcode-proxy", "accounts.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  let store = { accounts: [] };
  if (fs.existsSync(storePath)) {
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch {}
  }
  if (!Array.isArray(store.accounts)) store.accounts = [];
  const existing = store.accounts.find(
    (a) => a.zcode_jwt === account.zcode_jwt || a.email === account.email,
  );
  if (existing)
    Object.assign(existing, account, { updated_at: new Date().toISOString() });
  else
    store.accounts.push({
      id: crypto.randomUUID(),
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...account,
    });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  return storePath;
}

function saveZcodeApiCredentials(bundle) {
  const credential = {
    provider: "zai",
    apiKey: bundle.platformApiKeyId || "",
    secret: bundle.platformSecret || undefined,
    userId: bundle.zcodeUserId || parseJwtUserId(bundle.zcodeJwt) || undefined,
    jwt: bundle.zcodeJwt,
  };
  const credPath = path.join(os.homedir(), ".zcode-proxy", "credentials.json");
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(credential, null, 2), {
    mode: 0o600,
  });

  const zcodeApiData =
    path.join(ZCODE_API_ROOT, "data", "zcode-config.json");
  fs.mkdirSync(path.dirname(zcodeApiData), { recursive: true });
  fs.writeFileSync(
    zcodeApiData,
    JSON.stringify({
      provider: {
        "builtin:zai-coding-plan": {
          name: "Z.ai - Coding Plan",
          kind: "anthropic",
          options: {
            apiKey: bundle.zcodeJwt,
            baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
          },
          enabled: true,
        },
        "builtin:zai-start-plan": {
          name: "Z.ai - Start Plan",
          kind: "anthropic",
          options: {
            apiKey: bundle.zcodeJwt,
            baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
          },
          enabled: true,
        },
      },
    }),
  );

  const accountPoolPath = upsertAccountPool({
    email: bundle.email,
    username: bundle.username,
    password: bundle.password,
    chat_token: bundle.chatToken,
    platform_api_key: bundle.platformApiKey,
    zcode_jwt: bundle.zcodeJwt,
    zcode_oauth_access_token: bundle.zcodeOAuthAccessToken,
    zcode_user_id: bundle.zcodeUserId || parseJwtUserId(bundle.zcodeJwt),
    zcode_session_id: crypto.randomUUID(),
  });

  const runRecordPath =
    path.join(ZCODE_API_ROOT, "data", "latest-autoreg-credential.json");
  fs.writeFileSync(
    runRecordPath,
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        email: bundle.email,
        username: bundle.username,
        password: bundle.password,
        chat_token: bundle.chatToken,
        platform_api_key: bundle.platformApiKey,
        zcode_jwt: bundle.zcodeJwt,
        zcode_oauth_access_token: bundle.zcodeOAuthAccessToken,
        zcode_user_id: bundle.zcodeUserId || parseJwtUserId(bundle.zcodeJwt),
        credentials_path: credPath,
        zcode_config_path: zcodeApiData,
        accounts_path: accountPoolPath,
      },
      null,
      2,
    ),
  );

  return { credPath, zcodeApiData, accountPoolPath, runRecordPath };
}

// ─── Main flow ─────────────────────────────────────────────────────────────────

async function runOneFlow(attempt = 1) {
  console.log(`
================ Attempt ${attempt} ================`);
  console.log("[0] Create DuckMail account...");
  let account;
  try {
    account = await dm.createAccount({ domain: "duckmail.sbs" });
  } catch (e) {
    console.log("  Domain failed, using default:", e.message);
    account = await dm.createAccount();
  }
  const email = account.address;
  const token = account.token;
  const password = "TestPass" + Math.random().toString(36).slice(2, 8) + "!1A";
  const username = "testuser" + Math.floor(Math.random() * 10000);
  console.log(`  Email: ${email}`);
  console.log(`  User: ${username}`);
  console.log(`  Pass: ${password}`);

  console.log("\n[1] Launch browser...");
  const { browser, page } = await launchBrowser();

  // Capture signup API response
  let signupResponse = null;
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/v1/auths/signup")) {
      signupResponse = await resp.text();
      console.log(`[signup] ${signupResponse.slice(0, 300)}`);
    }
  });

  console.log("\n[2] Navigate to /auth/signup...");
  await page.goto("https://chat.z.ai/auth/signup", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(4000);
  console.log(`  URL: ${page.url()}`);

  console.log("\n[3] Solve captcha...");
  const captchaParam = await solveCaptcha(page);

  if (!captchaParam) {
    console.log("\nFAIL: captcha not solved");
    await page.screenshot({
      path: "C:/Users/yezi6/Downloads/zocde/fail-captcha.png",
      fullPage: true,
    });
    await browser.close().catch(() => {});
    throw new Error("captcha not solved");
  }
  console.log(`\nCaptcha SOLVED! param length: ${captchaParam.length}`);
  console.log(
    `  certifyId: ${captchaParam.match(/"certifyId":"([^"]+)"/)?.[1]}`,
  );
  console.log(
    `  deviceToken: ${captchaParam.match(/"deviceToken":"([^"]+)"/)?.[1]?.slice(0, 30)}`,
  );
  console.log(`  sceneId: ${captchaParam.match(/"sceneId":"([^"]+)"/)?.[1]}`);
  console.log(`  fullParamFirst200: ${captchaParam.slice(0, 200)}`);
  console.log(`  fullParamLast100: ${captchaParam.slice(-100)}`);

  // Remove the self-hosted widget (cleanup)
  await page
    .evaluate(() => {
      const mount = document.getElementById("zai-captcha-mount");
      if (mount) mount.remove();
      window.__zaiCaptcha = null;
    })
    .catch(() => {});

  console.log("\n[4] Submit signup via API...");
  console.log(`  Using browser fetch with cookies preserved`);

  // Try with browser fetch first (preserves captcha session cookies)
  const signupResult = await page.evaluate(
    async (data) => {
      const r = await fetch("https://chat.z.ai/api/v1/auths/signup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-region": "overseas" },
        body: data,
      });
      const body = await r.text();
      return { status: r.status, body };
    },
    JSON.stringify({
      name: username,
      email,
      password,
      captcha_verify_param: captchaParam,
      profile_image_url:
        "https://api.dicebear.com/7.x/bottts/svg?seed=" + username,
      sso_redirect: null,
    }),
  );

  console.log(`  Status: ${signupResult.status}`);
  console.log(`  Body: ${signupResult.body.slice(0, 300)}`);

  const signupOk =
    signupResult.body.includes('"success":true') ||
    signupResult.body.includes('"Success":true') ||
    signupResult.status === 200;
  if (!signupOk) {
    console.log(
      "Signup FAILED for this email; closing this browser and starting a fresh account on next attempt.",
    );
    await page
      .screenshot({
        path: `C:/Users/yezi6/Downloads/zocde/fail-signup-attempt-${attempt}.png`,
        fullPage: true,
      })
      .catch(() => {});
    await browser.close().catch(() => {});
    throw new Error(
      `signup failed status=${signupResult.status} body=${signupResult.body.slice(0, 200)}`,
    );
  }
  console.log("Signup SUCCESS!");

  // Poll DuckMail for verification email
  console.log("\n[5] Waiting for verification email...");
  let verifyCode = null;
  let verifyToken = null;
  let emailDumped = false;
  for (let i = 0; i < 25; i++) {
    try {
      const { messages } = await dm.getMessages(token);
      for (const msg of messages) {
        const mid = String(msg.id || msg.msgid || "");
        const detail = await dm.getMessageDetail(token, mid);
        const textContent =
          detail.text || detail.content || detail.body || detail.message || "";
        const htmlContent = Array.isArray(detail.html)
          ? detail.html.join(" ")
          : typeof detail.html === "string"
            ? detail.html
            : "";
        const allText = textContent + " " + htmlContent;
        console.log(
          `  [email] subject="${detail.subject}" text_len=${textContent.length} html_len=${htmlContent.length}`,
        );

        // Try 6-digit code first
        let match = allText.match(/\b(\d{6})\b/);
        if (match) {
          verifyCode = match[1];
          console.log(`  Got 6-digit code: ${verifyCode}`);
          break;
        }

        // Try token from verification link
        const tokenMatch = allText.match(/token=([a-zA-Z0-9_-]+)/);
        if (tokenMatch) {
          verifyToken = tokenMatch[1];
          console.log(`  Got verify token: ${verifyToken}`);
        }
      }
    } catch (e) {
      console.log(`  Poll error: ${e.message}`);
    }
    if (verifyCode || verifyToken) break;
    console.log(`  Poll attempt ${i + 1}/25...`);
    await sleep(5000);
  }

  if (!verifyCode && !verifyToken) {
    console.log("No verification code or token found, checking messages...");
    const { messages } = await dm.getMessages(token);
    console.log(`  Messages: ${messages.length}`);
  }

  // finish_signup via verify_email browser form.
  let finishOk = false;
  let chatToken = null;
  if (verifyToken || verifyCode) {
    console.log("\n[6] Complete verify_email form...");
    const finishRes = await finishSignupInBrowser(page, {
      verifyToken,
      verifyCode,
      email,
      username,
      password,
    });
    if (finishRes) {
      const finishData = safeJsonParse(finishRes.body);
      chatToken = finishData?.user?.token || finishData?.token || null;
      finishOk =
        finishRes.ok && Boolean(finishData?.success) && Boolean(chatToken);
      console.log(
        `  finishOk=${finishOk} chatToken=${chatToken ? chatToken.slice(0, 20) + "..." : "(none)"}`,
      );
    }
  }

  if (!finishOk || !chatToken) {
    console.log(
      "\nFAIL: verify_email/finish_signup did not produce chat token",
    );
    await page
      .screenshot({
        path: "C:/Users/yezi6/Downloads/zocde/fail-finish-signup.png",
        fullPage: true,
      })
      .catch(() => {});
    await sleep(5000);
    await browser.close().catch(() => {});
    throw new Error("finish_signup did not produce chat token");
  }

  console.log("\n[7] Chat account completed");
  console.log(`  Email: ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Chat token: ${chatToken.slice(0, 24)}...`);

  let platform = null;
  try {
    platform = await resolvePlatformApiKey(chatToken, username);
    console.log(`  Platform API key: ${platform.apiKeyId.slice(0, 12)}...`);
  } catch (e) {
    console.log(`  WARN: platform API key step failed: ${e.message}`);
  }

  let oauth = null;
  try {
    oauth = await completeZcodeOAuth(page, email, password);
  } catch (e) {
    console.log(`  WARN: ZCode OAuth failed: ${e.message}`);
  }

  if (oauth?.jwt) {
    const saved = saveZcodeApiCredentials({
      email,
      username,
      password,
      chatToken,
      platformApiKey: platform?.apiKey || null,
      platformApiKeyId: platform?.apiKeyId || "",
      platformSecret: platform?.secret || undefined,
      zcodeJwt: oauth.jwt,
      zcodeOAuthAccessToken: oauth.oauth_access_token,
      zcodeUserId: oauth.user_id,
    });
    console.log("\n[10] Saved zcode-api credentials");
    console.log(`  credentials.json: ${saved.credPath}`);
    console.log(`  zcode-config.json: ${saved.zcodeApiData}`);
    console.log(`  accounts.json: ${saved.accountPoolPath}`);
    console.log(`  run record: ${saved.runRecordPath}`);
  } else {
    console.log(
      "\n[10] No ZCode JWT captured; zcode-api credentials were not written",
    );
  }

  console.log("\n=== Flow complete ===");
  const keepOpenMs = Number(process.env.DEBUG_FLOW_KEEP_OPEN_MS || 5000);
  if (keepOpenMs > 0) {
    console.log(`Browser stays open ${Math.round(keepOpenMs / 1000)}s...`);
    await sleep(keepOpenMs);
  }
  await browser.close();
}

async function resumeOAuthOnly() {
  const email = process.env.DEBUG_FLOW_RESUME_EMAIL;
  const password = process.env.DEBUG_FLOW_RESUME_PASSWORD;
  const username =
    process.env.DEBUG_FLOW_RESUME_USERNAME ||
    (email ? email.split("@")[0] : "zai-user");
  const chatToken = process.env.DEBUG_FLOW_RESUME_CHAT_TOKEN || null;
  const platformApiKey = process.env.DEBUG_FLOW_RESUME_PLATFORM_API_KEY || null;
  if (!email || !password) return false;

  console.log("\n================ Resume OAuth Only ================");
  console.log(`  Email: ${email}`);
  console.log(`  User: ${username}`);
  console.log("[resume] Launch browser...");
  const { browser, page } = await launchBrowser();
  try {
    const oauth = await completeZcodeOAuth(page, email, password);
    const saved = saveZcodeApiCredentials({
      email,
      username,
      password,
      chatToken,
      platformApiKey,
      platformApiKeyId: "",
      platformSecret: undefined,
      zcodeJwt: oauth.jwt,
      zcodeOAuthAccessToken: oauth.oauth_access_token,
      zcodeUserId: oauth.user_id,
    });
    console.log("\n[resume] Saved zcode-api credentials");
    console.log(`  credentials.json: ${saved.credPath}`);
    console.log(`  zcode-config.json: ${saved.zcodeApiData}`);
    console.log(`  accounts.json: ${saved.accountPoolPath}`);
    console.log(`  run record: ${saved.runRecordPath}`);
  } finally {
    const keepOpenMs = Number(process.env.DEBUG_FLOW_KEEP_OPEN_MS || 5000);
    if (keepOpenMs > 0) {
      console.log(
        `[resume] Browser stays open ${Math.round(keepOpenMs / 1000)}s...`,
      );
      await sleep(keepOpenMs);
    }
    await browser.close().catch(() => {});
  }
  return true;
}

async function main() {
  if (await resumeOAuthOnly()) return;
  const maxAttempts = Number(process.env.DEBUG_FLOW_MAX_ATTEMPTS || 4);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runOneFlow(attempt);
      return;
    } catch (e) {
      lastError = e;
      console.log(`\n[attempt ${attempt}] ${e.message}`);
      if (attempt >= maxAttempts) break;
      const waitMs = 8000 + attempt * 4000;
      console.log(
        `[attempt ${attempt}] Retrying with a fresh DuckMail account in ${Math.round(waitMs / 1000)}s...`,
      );
      await sleep(waitMs);
    }
  }
  throw lastError || new Error("all attempts failed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
