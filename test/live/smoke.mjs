/*
 * Live smoke test: drives a real Foundry world in headless Chromium. Opt-in (`npm run smoke`), never part of
 * `npm test`, because it needs a running Foundry server with a disposable world where this module is active.
 *
 *   OF_URL       base URL of the world's server            (default http://127.0.0.1:30000)
 *   OF_GM        game master user name                     (default "Gamemaster")
 *   OF_PLAYERS   comma separated player names, in order    (default "Player2")
 *   OF_PASSWORD  password shared by those test users       (default: none)
 *   OF_DATA      the server's Data folder, when this machine can reach it: the test then also puts the
 *                Service Worker bridge file in place (and restores what was there) to check both states
 *   OF_SHOTS     folder for screenshots                    (default: none taken)
 *
 * It uploads two small generated files into `worlds/<world>/assets/smoke/`; nothing else in the world is changed.
 * Exit code 0 when every check passed.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.OF_URL ?? "http://127.0.0.1:30000").replace(/\/+$/, "");
const GM = process.env.OF_GM ?? "Gamemaster";
const PLAYERS = (process.env.OF_PLAYERS ?? "Player2").split(",").map(s => s.trim()).filter(Boolean);
const PASSWORD = process.env.OF_PASSWORD ?? "";
const DATA = process.env.OF_DATA ?? null;
const SHOTS = process.env.OF_SHOTS ?? null;
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE_ID = "optimal-foundry";
const BRIDGE = "optimal-foundry-sw.js";

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

/** Log a user into the world; resolves once Foundry reports ready. */
async function join(browser, userName) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (!IGNORED.some(re => re.test(text))) errors.push(text.slice(0, 300));
  });
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[name="userId"]');
  await page.selectOption('select[name="userId"]', { label: userName });
  if (PASSWORD) await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[name="join"]');
  await page.waitForURL("**/game", { timeout: 30_000 });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120_000 });
  return { context, page, errors, userName };
}

const api = page => page.evaluate(id => Object.keys(game.modules.get(id)?.api ?? {}), MODULE_ID);

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Errors the module itself logged or threw (its console prefix, its files in a stack). */
const moduleErrors = session => session.errors.filter(e => /optimal-foundry/i.test(e));

/* ---------------------------------------- Checks ---------------------------------------- */

async function checkModuleReady(gm) {
  const info = await gm.page.evaluate(id => {
    const m = game.modules.get(id);
    return { active: !!m?.active, version: m?.version, isGM: game.user.isGM, secure: window.isSecureContext, world: game.world.id };
  }, MODULE_ID);
  check("module is active for the game master", info.active && info.isGM, `v${info.version}, world ${info.world}`);
  const keys = await api(gm.page);
  check("module API is exposed at ready", ["backfill", "swStatus", "networkStatus", "openDashboard"].every(k => keys.includes(k)), keys.join(","));
  return info;
}

/** Upload a generated PNG and WAV through Foundry's own upload path; the module must store optimized copies. */
async function checkUploads(gm, worldId) {
  const out = await gm.page.evaluate(async ({ dir }) => {
    const FP = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
    await FP.createDirectory("data", dir).catch(() => {});
    const stamp = Date.now();

    const canvas = document.createElement("canvas");
    canvas.width = 1600; canvas.height = 1200;
    const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1600, 1200);
    grad.addColorStop(0, "#27406b"); grad.addColorStop(1, "#c98a3a");
    g.fillStyle = grad; g.fillRect(0, 0, 1600, 1200);
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 7 % 360} 60% 50% / 0.5)`; g.fillRect((i * 97) % 1600, (i * 53) % 1200, 60, 40); }
    const png = await new Promise(r => canvas.toBlob(r, "image/png"));

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

async function checkWindows(gm) {
  const opened = await gm.page.evaluate(async id => {
    const api = game.modules.get(id).api;
    const app = await api.openDashboard();
    await new Promise(r => setTimeout(r, 800));
    const el = document.querySelector(".optimal-foundry.application, .application.optimal-foundry");
    const tabs = [...(el?.querySelectorAll("[data-action='tab']") ?? [])].map(t => t.dataset.tab);
    const seen = [];
    for (const tab of tabs) {
      el.querySelector(`[data-action='tab'][data-tab='${tab}']`).click();
      await new Promise(r => setTimeout(r, 500));
      const part = el.querySelector(`.tab[data-tab='${tab}'], [data-application-part='${tab}']`);
      seen.push({ tab, chars: (part?.textContent ?? "").trim().length });
    }
    return { rendered: !!el, tabs: seen, title: el?.querySelector(".window-title")?.textContent ?? null, app: !!app };
  }, MODULE_ID);
  check("dashboard opens", opened.rendered, opened.title ?? "");
  check("every dashboard tab renders content", opened.tabs.length >= 4 && opened.tabs.every(t => t.chars > 20), opened.tabs.map(t => `${t.tab}:${t.chars}`).join(" "));
  await shot(gm.page, "gm-dashboard");
}

async function checkServiceWorker(session, label, expectControlled) {
  const status = await session.page.evaluate(async id => {
    const api = game.modules.get(id).api;
    for (let i = 0; i < 40; i++) {
      const s = api.swStatus();
      if (s.controlling || s.reason) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return api.swStatus();
  }, MODULE_ID);
  if (expectControlled) check(`${label}: Service Worker controls the page`, status.controlling === true && !status.needsSetup, JSON.stringify({ script: status.script, version: status.version, reason: status.reason }));
  else check(`${label}: missing bridge file is reported as needing setup`, status.controlling === false && status.needsSetup === true, JSON.stringify({ reason: status.reason, dataRootCopy: status.dataRootCopy }));
  return status;
}

/* ---------------------------------------- Run ---------------------------------------- */

const browser = await chromium.launch();
let restoreBridge = () => {};
try {
  if (DATA) {
    // Start from the "fresh install" state: no bridge file at the Data root.
    const target = path.join(DATA, BRIDGE);
    const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
    restoreBridge = () => { if (previous) fs.writeFileSync(target, previous); else fs.rmSync(target, { force: true }); };
    fs.rmSync(target, { force: true });
  }

  let gm = await join(browser, GM);
  const info = await checkModuleReady(gm);
  if (DATA) {
    await checkServiceWorker(gm, "fresh install", false);
    await shot(gm.page, "gm-needs-setup");
    fs.copyFileSync(path.join(MODULE_ROOT, BRIDGE), path.join(DATA, BRIDGE));
    const after = await gm.page.evaluate(async id => {
      const mod = await import(foundry.utils.getRoute(`modules/${id}/scripts/p2p/sw-client.mjs`));
      return mod.recheckServiceWorker();
    }, MODULE_ID);
    check("after copying the bridge file, a re-check registers the Service Worker", after?.registered === true && after?.needsSetup === false, JSON.stringify({ script: after?.script, dataRootCopy: after?.dataRootCopy }));
    await gm.context.close();
    gm = await join(browser, GM);
  }
  await checkServiceWorker(gm, "game master", true);
  await checkUploads(gm, info.world);
  await checkWindows(gm);
  check("game master: no module errors", moduleErrors(gm).length === 0, moduleErrors(gm).slice(0, 3).join(" | "));
  await shot(gm.page, "gm-final");

  for (const name of PLAYERS) {
    const player = await join(browser, name);
    await player.page.waitForTimeout(3000);
    await checkServiceWorker(player, name, true);
    check(`${name}: no module errors`, moduleErrors(player).length === 0, moduleErrors(player).slice(0, 3).join(" | "));
    await shot(player.page, `player-${name}`);
    await player.context.close();
  }
  await gm.context.close();
} catch (err) {
  check("smoke test ran to the end", false, String(err?.stack ?? err).slice(0, 600));
} finally {
  restoreBridge();
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
