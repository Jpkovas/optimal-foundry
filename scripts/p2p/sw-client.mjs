import { MODULE_ID, MODULE_PATH, log, warn, isOptimizedPath } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { normalizePath } from "../library.mjs";
import { networkStatus } from "../net/scheduler.mjs";
import { fetchFromPeers, swarmStatus, noteCached, noteEvicted } from "./swarm.mjs";

/**
 * Page side of the Service Worker.
 *
 * Registration order: an existing registration's script first, then the bridge at the Data root
 * (`/optimal-foundry-sw.js`, one line that imports the module's sw.js; works without any header), then the module
 * script itself (needs `Service-Worker-Allowed: /`). Scope is always the route root so the SW sees every media
 * request of the game page. A module cannot put the bridge at the Data root itself (`.js` is not uploadable), so
 * until the game master copies it once `swStatus().needsSetup` is true.
 *
 * Hello: this page sends its config to the worker at start and with every stats refresh. The worker asks a page
 * for P2P only after such a message, and removes itself when game pages stop sending any (see sw.js).
 *
 * P2P: the SW asks this page with `p2p-get`; the page fetches the file from peers (swarm.mjs verifies SHA-256)
 * and answers with the Blob. The SW stores that Blob in Cache Storage itself (single writer of the LRU metadata)
 * and broadcasts `cached`, which this page forwards to the swarm as a P2P_HAVE announcement.
 * The message listener is attached when this module is imported, long before `ready`.
 *
 * Mutable media: the SW also stores and revalidates non-optimized media (see sw.js). That is the SW config field
 * `revalidateMutable`, default true; this page does not send it, so the default applies.
 */

const CACHE = "optimal-foundry-v1";
const CACHE_PREFIX = "optimal-foundry-";
/** Must equal VERSION in sw.js. */
const SW_VERSION = "0.3.0";
const BRIDGE_SCRIPT = "optimal-foundry-sw.js";
const SW_SCRIPTS = [BRIDGE_SCRIPT, `${MODULE_PATH}/sw.js`];
const BRIDGE_MAX_BYTES = 4096; // the bridge is a few hundred bytes; a full copy of sw.js is far larger
const READY_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10_000;
const STATS_EVERY_MS = 15_000;

const state = {
  supported: false,
  registered: false,
  scope: null,
  controlling: false,
  cachedBytes: 0,
  cachedFiles: 0,
  reason: undefined,
  script: null,
  version: null,
  outdated: false,
  persisted: null,
  dataRootCopy: null
};
let registration = null;
let initialized = false;
let statsTimer = null;
let statsRun = null;
let updateTried = false;
let outdatedWarned = false;

// Attached at import time: Foundry draws the first scene before `ready`, and the SW may already ask for files.
{
  const container = globalThis.navigator?.serviceWorker;
  if (globalThis.isSecureContext && container) {
    container.addEventListener("message", onWorkerMessage);
    container.startMessages?.();
  }
}

/* ---------------------------------------- Public API ---------------------------------------- */

export async function initServiceWorker() {
  if (initialized) return;
  initialized = true;
  try {
    await setup();
  } catch (err) {
    state.reason = "error";
    warn("Service Worker disabled", err);
  }
}

/**
 * `{supported, registered, scope, controlling, cachedBytes, cachedFiles, reason?, script, version, outdated,
 * persisted, needsSetup, dataRootCopy}`.
 * `dataRootCopy`: what sits at the Data root under the bridge's name: "bridge", "stale" (a full copy of an older
 * sw.js), "missing", or null when not checked.
 * `needsSetup`: the local cache waits for the game master: the bridge file is not at the Data root (and the
 * server sends no `Service-Worker-Allowed` header), or the file there is a stale full copy to replace by the bridge.
 */
export function swStatus() {
  return {
    ...state,
    controlling: !!globalThis.navigator?.serviceWorker?.controller && state.registered,
    needsSetup: state.supported && (state.dataRootCopy === "stale" || (!state.registered && state.reason === "scopeDenied"))
  };
}

/**
 * Run the registration again (the game master just put the bridge file in place): look at the Data root, register,
 * and make an existing worker pick up what changed.
 * @returns {Promise<object>} the new `swStatus()`
 */
export async function recheckServiceWorker() {
  if (!initialized) await initServiceWorker();
  else if (state.supported) {
    updateTried = false;
    try {
      await connect();
    } catch (err) {
      state.reason = "error";
      warn("Service Worker re-check failed", err);
    }
  }
  return swStatus();
}

/**
 * Tell the Service Worker to stop the preload downloads of these URLs and discard what it had of them. Only
 * requests sent with the `X-Optimal-Foundry-Preload: 1` header can be stopped, and only while nothing else
 * waits for the same file.
 * @param {string[]} urls  paths or same-origin URLs
 */
export function abortSwPreloads(urls) {
  const controller = globalThis.navigator?.serviceWorker?.controller;
  if (!controller || !Array.isArray(urls)) return;
  const keys = urls.map(cacheKey).filter(Boolean);
  if (!keys.length) return;
  try { controller.postMessage({ type: "abort-preload", urls: keys }); }
  catch (err) { warn("cannot stop preloads in the Service Worker", err); }
}

/**
 * The `serviceWorker` setting is off: a worker registered earlier would keep intercepting forever,
 * so unregister it and drop its caches. Called by main.mjs at ready.
 */
export async function cleanupServiceWorker() {
  if (!globalThis.navigator?.serviceWorker) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    let removed = false;
    for (const reg of regs) {
      const url = (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL ?? "";
      if (url.endsWith(`/${BRIDGE_SCRIPT}`) || url.endsWith(`/${MODULE_PATH}/sw.js`)) {
        removed = (await reg.unregister()) || removed;
      }
    }
    if (removed) {
      await deleteCaches();
      log("Service Worker unregistered (disabled in settings)");
    }
  } catch (err) {
    warn("Service Worker cleanup failed", err);
  }
}

/**
 * Delete this origin's optimal-foundry Cache Storage, reset the SW's LRU metadata and tell the swarm the files
 * are gone. Works with or without an active SW.
 * @returns {Promise<{freedBytes: number}>}
 */
export async function clearDeviceCache() {
  const urls = await cachedOptimizedUrls();
  const worker = activeWorker();
  const res = worker ? await ask(worker, { type: "clear" }, 30_000) : null;
  const freedBytes = res?.ok ? Number(res.freedBytes) || 0 : await deleteCaches();
  noteEvicted(urls);
  state.cachedBytes = 0;
  state.cachedFiles = 0;
  refreshStats();
  log(`device cache cleared (${urls.length} optimized files, ${freedBytes} bytes)`);
  return { freedBytes };
}

/** Normalized paths (library form, e.g. `maps/x.of-1a2b3c4d.webp`) of every optimized file in Cache Storage. */
export async function cachedOptimizedUrls() {
  if (!("caches" in globalThis)) return [];
  try {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    return keys.map(r => normalizePath(r.url)).filter(p => p && isOptimizedPath(p));
  } catch (err) {
    warn("cannot list cached files", err);
    return [];
  }
}

export async function readCached(url) {
  const key = cacheKey(url);
  if (!key || !("caches" in globalThis)) return null;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(key);
    return res ? await res.blob() : null;
  } catch (err) {
    warn("cache read failed", url, err);
    return null;
  }
}

/**
 * Canonical Cache Storage key for a path or URL (same algorithm as sw.js `canonicalKey`):
 * origin + route prefix + path segments decoded then re-encoded, without query or hash.
 * Returns null for foreign-origin URLs.
 */
function cacheKey(url) {
  const path = normalizePath(url);
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  try {
    const encoded = path.split("/").map(s => encodeURIComponent(s)).join("/");
    const u = new URL(foundry.utils.getRoute(encoded), window.location.origin);
    const segments = u.pathname.split("/").map(s => {
      try { return encodeURIComponent(decodeURIComponent(s)); } catch { return s; }
    });
    return u.origin + segments.join("/");
  } catch {
    return null;
  }
}

/**
 * Push quota, timeout and P2P on/off to the SW. It is also this page's hello. Called on init, on controller
 * change, by the swarm when it turns on or off, and with every stats refresh.
 */
export async function sendSwConfig() {
  const targets = new Set([activeWorker(), globalThis.navigator?.serviceWorker?.controller].filter(Boolean));
  if (!targets.size) return;
  let msg;
  try {
    msg = {
      type: "config",
      p2p: !!swarmStatus().enabled,
      timeoutMs: getSetting("p2pTimeoutSec") * 1000,
      quotaBytes: await quotaBytes()
    };
  } catch (err) {
    warn("cannot build SW config", err);
    return;
  }
  for (const t of targets) {
    try { t.postMessage(msg); } catch (err) { warn("cannot send SW config", err); }
  }
}

/* ---------------------------------------- Setup ---------------------------------------- */

async function setup() {
  const container = globalThis.navigator?.serviceWorker;
  if (!window.isSecureContext) { state.reason = "insecure"; return; }
  if (!container || !("caches" in globalThis)) { state.reason = "unsupported"; return; }
  state.supported = true;

  container.addEventListener("controllerchange", () => {
    log("Service Worker now controls this page");
    sendSwConfig();
    refreshStats();
  });
  Hooks.on(`${MODULE_ID}.settingChanged`, key => {
    if (key === "cacheQuotaMB" || key === "p2pTimeoutSec") sendSwConfig();
  });
  await connect();
}

/** Look at the Data root, register, wait for the worker, say hello and read its version and totals. */
async function connect() {
  const container = navigator.serviceWorker;
  state.dataRootCopy = await probeDataRoot();
  if (!(await register())) return;

  const ready = await Promise.race([
    container.ready.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), READY_TIMEOUT_MS))
  ]);
  state.reason = ready ? undefined : "notActive";
  if (!ready) warn("Service Worker registered but did not activate in time");

  // A hard reload leaves the page uncontrolled while the SW is active; ask it to claim this client.
  if (!container.controller && activeWorker()) await ask(activeWorker(), { type: "claim" }, 3000);

  if (statsRun) await statsRun; // a refresh that started before this registration says nothing about it
  await refreshStats();
  statsTimer ??= setInterval(refreshStats, STATS_EVERY_MS);
  if (state.persisted === null) requestPersistence();
}

/**
 * What sits at the Data root under the bridge's name: "missing" (404), "bridge" (a small file that imports the
 * module's worker) or "stale" (anything else: a full copy of sw.js from an older version, which a module update
 * never reaches). null when the server gave no clear answer.
 */
async function probeDataRoot() {
  try {
    const res = await fetch(foundry.utils.getRoute(BRIDGE_SCRIPT), { cache: "no-store", credentials: "same-origin" });
    if (res.status === 404) return "missing";
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    if (Number(res.headers.get("content-length")) > BRIDGE_MAX_BYTES) {
      res.body?.cancel().catch(() => {});
      return "stale";
    }
    const text = await res.text();
    return text.length <= BRIDGE_MAX_BYTES && text.includes("importScripts(") ? "bridge" : "stale";
  } catch {
    return null;
  }
}

/**
 * Does the server let this script control `scope`? A worker script may only take a scope above its own folder when
 * the response carries `Service-Worker-Allowed` with a path that contains it. An unclear answer (network error,
 * script missing) counts as yes: the registration itself then reports what is wrong.
 */
async function allowsScope(script, scope) {
  try {
    const res = await fetch(script, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return true;
    const allowed = res.headers.get("service-worker-allowed");
    return !!allowed && scope.startsWith(new URL(allowed, globalThis.location.href).pathname);
  } catch {
    return true;
  }
}

/** Register the first script the browser accepts for the route root. Sets `registration` and the state fields. */
async function register() {
  const container = navigator.serviceWorker;
  const scope = foundry.utils.getRoute("/");
  let scripts = SW_SCRIPTS.map(p => foundry.utils.getRoute(p));
  // Nothing at the Data root: skip an attempt that can only fail and that the browser logs as an error.
  if (state.dataRootCopy === "missing") scripts = scripts.slice(1);
  try {
    const existing = await container.getRegistration(scope);
    const current = existing && (existing.active ?? existing.waiting ?? existing.installing)?.scriptURL;
    if (current) {
      const i = scripts.indexOf(new URL(current).pathname);
      if (i > 0) scripts.unshift(...scripts.splice(i, 1));
    }
  } catch {}

  let found = null;
  let denied = false;
  let failure = null;
  const bridge = foundry.utils.getRoute(BRIDGE_SCRIPT);
  for (const script of scripts) {
    // The module's own copy may only take the route root when the server says so. Asking first spares a
    // registration the browser would refuse, and log as an error, on every page load of a fresh install.
    if (script !== bridge && !(await allowsScope(script, scope))) {
      denied = true;
      continue;
    }
    try {
      found = await container.register(script, { scope, updateViaCache: "none" });
      state.script = script;
      break;
    } catch (err) {
      if (err?.name === "SecurityError") denied = true;
      else failure ??= err;
    }
  }
  if (!found) {
    registration = null;
    state.registered = false;
    state.scope = null;
    state.script = null;
    // A file at the Data root that did not register is broken, not missing: copying the bridge again will not help.
    const rootFile = state.dataRootCopy === "bridge" || state.dataRootCopy === "stale";
    state.reason = !denied ? "notFound" : rootFile ? "error" : "scopeDenied";
    if (state.reason === "scopeDenied") {
      warn(`Service Worker unavailable: copy ${MODULE_PATH}/${BRIDGE_SCRIPT} to the Data root, or serve ${scripts.at(-1)} with "Service-Worker-Allowed: /".`);
    } else warn(`Service Worker unavailable (${state.reason})`, failure ?? "");
    return false;
  }

  if (found !== registration) {
    registration = found;
    found.addEventListener("updatefound", () => {
      const next = found.installing;
      log("Service Worker update found");
      next?.addEventListener("statechange", () => { if (next.state === "activated") { sendSwConfig(); refreshStats(); } });
    });
  }
  state.registered = true;
  state.scope = found.scope;
  return true;
}

/**
 * Ask the browser not to evict this origin's storage under pressure. Chromium decides silently (engagement,
 * bookmark, install); Firefox would show a permission prompt, so it is only queried there, never asked.
 */
async function requestPersistence() {
  try {
    const storage = navigator.storage;
    let persisted = await storage?.persisted?.() ?? null;
    if (persisted === false && navigator.userAgentData?.brands) persisted = await storage.persist();
    state.persisted = persisted;
  } catch {
    state.persisted = null;
  }
}

function activeWorker() {
  return registration?.active ?? null;
}

async function quotaBytes() {
  let bytes = getSetting("cacheQuotaMB") * 1_048_576;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) bytes = Math.min(bytes, Math.floor(est.quota * 0.6));
  } catch {}
  return bytes;
}

/** Delete every optimal-foundry cache of this origin directly. Returns the bytes they held (by Content-Length). */
async function deleteCaches() {
  if (!("caches" in globalThis)) return 0;
  let bytes = 0;
  try {
    for (const name of (await caches.keys()).filter(n => n.startsWith(CACHE_PREFIX))) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const r = await cache.match(req);
        bytes += Number(r?.headers.get("content-length")) || 0;
      }
      await caches.delete(name);
    }
  } catch (err) {
    warn("cache delete failed", err);
  }
  return bytes;
}

/** postMessage with a reply port; resolves with the reply or null on timeout/error. */
function ask(worker, msg, timeoutMs) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, timeoutMs);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data ?? null); };
    try { worker.postMessage(msg, [channel.port2]); }
    catch { clearTimeout(timer); resolve(null); }
  });
}

/* ---------------------------------------- Messages from the SW ---------------------------------------- */

function onWorkerMessage(event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  switch (data.type) {
    case "p2p-get":
      answerP2PGet(data, event.ports?.[0]);
      break;
    case "cached":
      if (typeof data.url === "string") {
        noteCached([data.url]);
        state.cachedFiles += 1;
        state.cachedBytes += Number(data.bytes) || 0;
      }
      break;
    case "evicted":
      if (Array.isArray(data.urls)) {
        noteEvicted(data.urls.filter(u => typeof u === "string"));
        refreshStats();
      }
      break;
  }
}

/** True while the game itself waits on media (scene draw or counted urgent loads): P2P must not add latency. */
function urgentNow() {
  if (globalThis.canvas?.loading) return true;
  try { return networkStatus().urgent > 0; } catch { return false; }
}

async function answerP2PGet({ url, id }, port) {
  if (!port) return;
  const controller = new AbortController();
  port.onmessage = ({ data }) => { if (data?.kind === "cancel") controller.abort(); };
  // Acknowledge at once: the SW gives an unresponsive page only a short first window.
  try { port.postMessage({ id, kind: "progress" }); } catch {}
  let last = performance.now();
  const onProgress = () => {
    const now = performance.now();
    if (now - last < 1000) return;
    last = now;
    try { port.postMessage({ id, kind: "progress" }); } catch {}
  };
  let blob = null;
  try {
    if (typeof url === "string" && swarmStatus().enabled) {
      blob = await fetchFromPeers(url, { signal: controller.signal, onProgress, urgent: urgentNow() });
    }
  } catch (err) {
    warn("P2P fetch failed", url, err);
  }
  try { port.postMessage({ id, kind: "done", blob: controller.signal.aborted ? null : blob }); } catch {}
  setTimeout(() => { try { port.close(); } catch {} }, 1000);
}

/* ---------------------------------------- Stats and version ---------------------------------------- */

/** One refresh at a time; a call made while one runs gets that run's promise. */
function refreshStats() {
  statsRun ??= readStats().finally(() => { statsRun = null; });
  return statsRun;
}

const askStats = () => {
  const worker = activeWorker();
  return worker ? ask(worker, { type: "stats" }, 3000) : null;
};

async function readStats() {
  try {
    await sendSwConfig(); // the hello: a worker the browser restarted has forgotten its pages
    let res = await askStats();
    if (res?.ok && res.version !== SW_VERSION && !updateTried && registration) {
      updateTried = true;
      await updateWorker(res.version);
      await sendSwConfig();
      res = await askStats();
    }
    if (res?.ok) {
      state.cachedBytes = Number(res.cachedBytes) || 0;
      state.cachedFiles = Number(res.cachedFiles) || 0;
      state.version = res.version ?? null;
      state.outdated = !!state.version && state.version !== SW_VERSION;
      if (state.outdated) warnOutdated();
    } else if ("caches" in globalThis) {
      const cache = await caches.open(CACHE);
      const keys = await cache.keys();
      let bytes = 0;
      for (const req of keys) {
        const r = await cache.match(req);
        bytes += Number(r?.headers.get("content-length")) || 0;
      }
      state.cachedFiles = keys.length;
      state.cachedBytes = bytes;
    }
  } catch (err) {
    warn("cache stats failed", err);
  }
}

/**
 * The running worker is not this module version's (the module was just updated). The browser looks for a new
 * worker by itself a moment after each page load; ask now, once per page load, and give a new worker time to take
 * over before anyone is told. The check compares the registered script and every script it imports with the
 * server's copies, so a changed sw.js behind an unchanged bridge is found. (Unregistering and registering again
 * does not do that: for a page the worker controls, browsers bring the old registration back as it was.)
 */
async function updateWorker(running) {
  try {
    log(`Service Worker v${running ?? "?"} running, v${SW_VERSION} expected: checking for the new one`);
    await registration.update();
    const next = registration.installing ?? registration.waiting;
    if (!next) return; // already active, or the server has nothing newer
    await new Promise(resolve => {
      const timer = setTimeout(resolve, UPDATE_TIMEOUT_MS);
      next.addEventListener("statechange", () => {
        if (next.state !== "activated" && next.state !== "redundant") return;
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (err) {
    warn("Service Worker update check failed", err);
  }
}

/**
 * Still another version after the update check: the server keeps handing out an old script. Tell the GM once:
 * either the Data-root file is a full copy of an older sw.js (replace it by the bridge), or something between the
 * server and the browser (a CDN rule) serves an old modules/optimal-foundry/sw.js.
 */
function warnOutdated() {
  if (outdatedWarned) return;
  outdatedWarned = true;
  const stale = state.dataRootCopy === "stale";
  warn(stale
    ? `${BRIDGE_SCRIPT} at the Data root is a full copy of sw.js v${state.version} (v${SW_VERSION} expected); replace it by ${MODULE_PATH}/${BRIDGE_SCRIPT}.`
    : `Service Worker v${state.version} is still running (v${SW_VERSION} expected); the server answers with an old ${MODULE_PATH}/sw.js.`);
  if (game.user?.isGM) {
    const key = stale ? "OPTIMALFOUNDRY.Sw.Outdated" : "OPTIMALFOUNDRY.Sw.OutdatedServer";
    ui.notifications?.warn(game.i18n.format(key, { version: state.version, expected: SW_VERSION }));
  }
}
