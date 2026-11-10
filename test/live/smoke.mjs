/*
 * Live smoke test: drives a real Foundry world in headless Chromium. Opt-in (`npm run smoke`), never part of
 * `npm test`, because it needs a running Foundry server with a disposable world where this module is active.
 *
 *   OF_URL       base URL of the world's server            (default http://127.0.0.1:30000)
 *   OF_GM        game master user name                     (default "Gamemaster")
 *   OF_PLAYERS   comma separated player names, in order    (default "Player2")
 *   OF_PASSWORD  password shared by those test users       (default: none)
 *   OF_SHOTS     folder for screenshots                    (default: none taken)
 *
 * It uploads two small generated files into `worlds/<world>/assets/smoke/`; nothing else in the world is changed.
 * Nothing is installed on the server beyond the module itself: the local cache must work from a plain install.
 * Exit code 0 when every check passed.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.OF_URL ?? "http://127.0.0.1:30000").replace(/\/+$/, "");
const GM = process.env.OF_GM ?? "Gamemaster";
const PLAYERS = (process.env.OF_PLAYERS ?? "Player2").split(",").map(s => s.trim()).filter(Boolean);
const PASSWORD = process.env.OF_PASSWORD ?? "";
const SHOTS = process.env.OF_SHOTS ?? null;
const MODULE_ID = "optimal-foundry";

/** Console noise that is not the module's doing. */
const IGNORED = [
  /unsupported on Chromium version/i,          // Playwright's Chromium is older than Foundry recommends
  /Failed to load resource.*favicon/i
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
}

/** Log a user into the world; resolves once Foundry reports ready. Every GET the page sends is recorded. */
async function join(browser, userName) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (!IGNORED.some(re => re.test(text))) errors.push(text.slice(0, 300));
  });
  page.on("request", r => { if (r.method() === "GET") requests.push(decodeURIComponent(new URL(r.url()).pathname)); });
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[name="userId"]');
  await page.selectOption('select[name="userId"]', { label: userName });
  if (PASSWORD) await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[name="join"]');
  await page.waitForURL("**/game", { timeout: 30_000 });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 });
  return { context, page, errors, requests, userName };
}

/** How many GET requests for `filePath` left the page while `fn` ran, and what `fn` returned. */
async function requestsDuring(session, filePath, fn) {
  const wanted = "/" + filePath.replace(/^\/+/, "");
  const before = session.requests.filter(p => p === wanted).length;
  const value = await fn();
  await session.page.waitForTimeout(300);
  return { count: session.requests.filter(p => p === wanted).length - before, value };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Errors the module itself logged or threw (its console prefix, its files in a stack). */
const moduleErrors = session => session.errors.filter(e => /optimal-foundry/i.test(e));

const cacheStatus = session => session.page.evaluate(id => game.modules.get(id).api.cacheStatus(), MODULE_ID);

/* ---------------------------------------- Checks ---------------------------------------- */

async function checkModuleReady(gm) {
  const info = await gm.page.evaluate(id => {
    const m = game.modules.get(id);
    return { active: !!m?.active, version: m?.version, isGM: game.user.isGM, world: game.world.id, api: Object.keys(m?.api ?? {}) };
  }, MODULE_ID);
  check("module is active for the game master", info.active && info.isGM, `v${info.version}, world ${info.world}`);
  check("module API is exposed at ready", ["backfill", "cacheStatus", "networkStatus", "openDashboard"].every(k => info.api.includes(k)), info.api.join(","));
  return info;
}

async function checkCacheActive(session, label) {
  const status = await cacheStatus(session);
  const workers = await session.page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.() ?? []).length);
  check(`${label}: the local cache is on with nothing installed on the server`, status.active === true && workers === 0,
    JSON.stringify({ active: status.active, reason: status.reason, files: status.cachedFiles, serviceWorkers: workers }));
}

/** Upload a generated PNG and WAV through Foundry's own upload path; the module must store optimized copies. */
async function checkUploads(gm, worldId) {
  const out = await gm.page.evaluate(async ({ dir }) => {
    const FP = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
    await FP.createDirectory("data", dir).catch(() => {});
    const stamp = Date.now();

    const cv = document.createElement("canvas");
    cv.width = 1600; cv.height = 1200;
    const g = cv.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1600, 1200);
    grad.addColorStop(0, "#27406b"); grad.addColorStop(1, "#c98a3a");
    g.fillStyle = grad; g.fillRect(0, 0, 1600, 1200);
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 7 % 360} 60% 50% / 0.5)`; g.fillRect((i * 97) % 1600, (i * 53) % 1200, 60, 40); }
    const png = await new Promise(r => cv.toBlob(r, "image/png"));

    const rate = 44100, seconds = 3, n = rate * seconds;
    const wav = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, s) => [...s].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
    text(0, "RIFF"); wav.setUint32(4, 36 + n * 2, true); text(8, "WAVEfmt "); wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true);
    wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); text(36, "data"); wav.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) wav.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 12000), true);

    const files = [
      new File([png], `smoke-${stamp}.png`, { type: "image/png" }),
      new File([wav.buffer], `smoke-${stamp}.wav`, { type: "audio/wav" })
    ];
    const done = [];
    for (const file of files) {
      // The canvas must stay responsive while the file converts: count animation frames during the upload.
      let frames = 0, running = true;
      const tick = () => { frames++; if (running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      let res = null, error = null;
      try { res = await FP.upload("data", dir, file, {}, { notify: false }); }
      catch (err) { error = String(err?.message ?? err); }
      running = false;
      const ms = performance.now() - t0;
      let stored = null;
      if (res?.path) {
        const head = await fetch(foundry.utils.getRoute(res.path), { method: "HEAD", cache: "no-store" });
        stored = { status: head.status, bytes: Number(head.headers.get("content-length")) };
      }
      done.push({ name: file.name, size: file.size, path: res?.path ?? null, error, ms: Math.round(ms), frames, stored });
    }
    return done;
  }, { dir: `worlds/${worldId}/assets/smoke` });

  for (const f of out) {
    const optimized = /\.of-[0-9a-f]{8}\.(webp|ogg)$/i.test(f.path ?? "");
    check(`upload of ${f.name.replace(/-\d+/, "")} stores only the optimized copy`, optimized && f.stored?.status === 200 && f.stored.bytes > 0 && f.stored.bytes < f.size,
      `${f.path ?? f.error} ${f.size} -> ${f.stored?.bytes} bytes in ${f.ms} ms`);
    // A blocked main thread would starve requestAnimationFrame: expect at least ~10 frames per second on average.
    check(`page stays responsive while ${f.name.replace(/-\d+/, "")} converts`, f.frames >= Math.max(3, f.ms / 100), `${f.frames} frames in ${f.ms} ms`);
  }
  return out;
}

/** What the game loads through fetch, the canvas loader and audio elements must leave the server alone the second time. */
async function checkCache(gm, uploads) {
  const image = uploads.find(u => /\.webp$/.test(u.path ?? ""))?.path;
  const sound = uploads.find(u => /\.ogg$/.test(u.path ?? ""))?.path;
  if (image) {
    const read = () => gm.page.evaluate(async p => (await (await fetch(foundry.utils.getRoute(p))).blob()).size, image);
    const first = await requestsDuring(gm, image, read);
    const second = await requestsDuring(gm, image, read);
    check("an optimized image is downloaded from the server once", first.count <= 1 && second.count === 0 && second.value === first.value && second.value > 0,
      `requests: ${first.count} then ${second.count}, ${second.value} bytes`);
    // The way the canvas loads it: PIXI's own loader.
    const pixi = await requestsDuring(gm, image, () => gm.page.evaluate(async p => {
      const src = foundry.utils.getRoute(p);
      const texture = await PIXI.Assets.load(src);
      const size = { w: texture?.baseTexture?.width ?? 0, valid: !!texture?.baseTexture?.valid };
      await PIXI.Assets.unload(src);
      return size;
    }, image));
    check("the canvas loader gets that image from the local cache", pixi.count === 0 && pixi.value.valid && pixi.value.w > 0, `requests: ${pixi.count}, ${pixi.value.w}px wide`);
  }
  // A scene video the world already has: PIXI downloads it whole, so the second load must not touch the server.
  const video = await gm.page.evaluate(id => Object.values(game.modules.get(id).api.getLibrary())
    .find(e => e.status === "done" && /\.of-[0-9a-f]{8}\.webm$/i.test(e.optimized ?? "") && Number(e.bytes) > 50_000)?.optimized ?? null, MODULE_ID);
  if (video) {
    const load = () => gm.page.evaluate(async p => {
      const src = foundry.utils.getRoute(p);
      const texture = await PIXI.Assets.load(src);
      const ok = !!texture?.baseTexture?.valid;
      await PIXI.Assets.unload(src);
      return ok;
    }, video);
    const first = await requestsDuring(gm, video, load);
    const second = await requestsDuring(gm, video, load);
    check("a scene video is downloaded once and then played from the local cache", first.value && second.value && first.count <= 1 && second.count === 0,
      `${video.split("/").pop()}: requests ${first.count} then ${second.count}`);
  }
  if (sound) {
    await gm.page.evaluate(async p => (await fetch(foundry.utils.getRoute(p))).arrayBuffer(), sound);
    await gm.page.waitForTimeout(800);
    const audio = await requestsDuring(gm, sound, () => gm.page.evaluate(p => new Promise(resolve => {
      const element = new Audio();
      const answer = extra => resolve({ blob: element.src.startsWith("blob:"), duration: element.duration || null, ...extra });
      element.preload = "metadata";
      element.onloadedmetadata = () => answer({});
      element.onerror = () => answer({ error: true });
      element.src = foundry.utils.getRoute(p);
      setTimeout(() => answer({ timedOut: true }), 8000);
    }), sound));
    check("an audio element plays a kept sound from the local cache", audio.value.blob && audio.value.duration > 0 && audio.count === 0,
      `requests: ${audio.count}, duration ${audio.value.duration}`);
  }
}

async function checkWindows(gm) {
  const opened = await gm.page.evaluate(async id => {
    const api = game.modules.get(id).api;
    await api.openDashboard();
    await new Promise(r => setTimeout(r, 800));
    const el = [...document.querySelectorAll(".application.optimal-foundry")].find(e => e.querySelector("[data-action='tab']"));
    const tabs = [...(el?.querySelectorAll("[data-action='tab']") ?? [])].map(t => t.dataset.tab);
    const seen = [];
    for (const tab of tabs) {
      el.querySelector(`[data-action='tab'][data-tab='${tab}']`).click();
      await new Promise(r => setTimeout(r, 500));
      const part = el.querySelector(`.tab[data-tab='${tab}'], [data-application-part='${tab}']`);
      seen.push({ tab, chars: (part?.textContent ?? "").trim().length });
    }
    return { rendered: !!el, tabs: seen, title: el?.querySelector(".window-title")?.textContent ?? null };
  }, MODULE_ID);
  check("dashboard opens", opened.rendered, opened.title ?? "");
  check("every dashboard tab renders content", opened.tabs.length >= 4 && opened.tabs.every(t => t.chars > 20), opened.tabs.map(t => `${t.tab}:${t.chars}`).join(" "));
  await shot(gm.page, "gm-dashboard");
}

/* ---------------------------------------- Run ---------------------------------------- */

const browser = await chromium.launch();
try {
  const gm = await join(browser, GM);
  const info = await checkModuleReady(gm);
  await checkCacheActive(gm, "game master");
  const uploads = await checkUploads(gm, info.world);
  await checkCache(gm, uploads);
  await checkWindows(gm);
  check("game master: no module errors", moduleErrors(gm).length === 0, moduleErrors(gm).slice(0, 3).join(" | "));
  await shot(gm.page, "gm-final");

  for (const name of PLAYERS) {
    const player = await join(browser, name);
    await checkCacheActive(player, name);
    // Downloading ahead fills the cache while the player does nothing.
    let files = 0;
    for (let i = 0; i < 20 && !files; i++) { await player.page.waitForTimeout(2000); files = (await cacheStatus(player)).cachedFiles; }
    check(`${name}: downloading ahead fills the local cache`, files > 0, `${files} files kept`);
    check(`${name}: no module errors`, moduleErrors(player).length === 0, moduleErrors(player).slice(0, 3).join(" | "));
    await shot(player.page, `player-${name}`);
    await player.context.close();
  }
  await gm.context.close();
} catch (err) {
  check("smoke test ran to the end", false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
