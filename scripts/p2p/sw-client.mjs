import { MODULE_ID, MODULE_PATH, log, warn, isOptimizedPath } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { normalizePath } from "../library.mjs";
import { networkStatus } from "../net/scheduler.mjs";
import { fetchFromPeers, swarmStatus, noteCached, noteEvicted } from "./swarm.mjs";

/**
 * Page side of the Service Worker.
 *
 * Registration order: an existing registration's script first, then the Data-root copy
 * (`/optimal-foundry-sw.js`, works without any header), then the module copy (needs `Service-Worker-Allowed: /`).
 * Scope is always the route root so the SW sees every media request of the game page.
 *
 * P2P: the SW asks this page with `p2p-get`; the page fetches the file from peers (swarm.mjs verifies SHA-256)
 * and answers with the Blob. The SW stores that Blob in Cache Storage itself (single writer of the LRU metadata)
 * and broadcasts `cached`, which this page forwards to the swarm as a P2P_HAVE announcement.
 * The message listener is attached when this module is imported, long before `ready`, so a `p2p-get` sent while
 * the first scene draws gets an immediate "no" (the swarm is not enabled yet) instead of a timeout.
 *
 * Mutable media: the SW also stores and revalidates non-optimized media (see sw.js). That is the SW config field
 * `revalidateMutable`, default true; this page does not send it, so the default applies.
 */

const CACHE = "optimal-foundry-v1";
const CACHE_PREFIX = "optimal-foundry-";
/** Must equal VERSION in sw.js. A different running version means a stale Data-root copy. */
const SW_VERSION = "0.2.0";
const DATA_ROOT_SCRIPT = "optimal-foundry-sw.js";
const SW_SCRIPTS = [DATA_ROOT_SCRIPT, `${MODULE_PATH}/sw.js`];
const READY_TIMEOUT_MS = 10_000;
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
  persisted: null
};
let registration = null;
let initialized = false;
let statsTimer = null;
let statsBusy = false;
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

/** `{supported, registered, scope, controlling, cachedBytes, cachedFiles, reason?, script, version, outdated, persisted}` */
export function swStatus() {
  return { ...state, controlling: !!globalThis.navigator?.serviceWorker?.controller && state.registered };
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
      if (url.endsWith(`/${DATA_ROOT_SCRIPT}`) || url.endsWith(`/${MODULE_PATH}/sw.js`)) {
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

/** Push quota, timeout and P2P on/off to the SW. Called on init, on controller change and by the swarm. */
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

  const scope = foundry.utils.getRoute("/");
  const scripts = SW_SCRIPTS.map(p => foundry.utils.getRoute(p));
  try {
    const existing = await container.getRegistration(scope);
    const current = existing && (existing.active ?? existing.waiting ?? existing.installing)?.scriptURL;
    if (current) {
      const path = new URL(current).pathname;
      const i = scripts.indexOf(path);
      if (i > 0) scripts.unshift(...scripts.splice(i, 1));
    }
  } catch {}

  let denied = false;
  for (const script of scripts) {
    try {
      registration = await container.register(script, { scope, updateViaCache: "none" });
      state.script = script;
      break;
    } catch (err) {
      if (err?.name === "SecurityError") denied = true;
    }
  }
  if (!registration) {
    state.reason = denied ? "scopeDenied" : "notFound";
    warn(`Service Worker unavailable (${state.reason}). Serve ${scripts.at(-1)} with "Service-Worker-Allowed: /" or copy sw.js to the Data root as ${DATA_ROOT_SCRIPT}.`);
    return;
  }

  state.registered = true;
  state.scope = registration.scope;
  registration.addEventListener("updatefound", () => {
    const next = registration.installing;
    log("Service Worker update found");
    next?.addEventListener("statechange", () => { if (next.state === "activated") { sendSwConfig(); refreshStats(); } });
  });

  const ready = await Promise.race([
    container.ready.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), READY_TIMEOUT_MS))
  ]);
  if (!ready) {
    state.reason = "notActive";
    warn("Service Worker registered but did not activate in time");
  } else state.reason = undefined;

  // A hard reload leaves the page uncontrolled while the SW is active; ask it to claim this client.
  if (!container.controller && activeWorker()) await ask(activeWorker(), { type: "claim" }, 3000);

  await sendSwConfig();
  refreshStats();
  statsTimer ??= setInterval(refreshStats, STATS_EVERY_MS);
  requestPersistence();

  Hooks.on(`${MODULE_ID}.settingChanged`, key => {
    if (key === "cacheQuotaMB" || key === "p2pTimeoutSec") sendSwConfig();
  });
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

/* ---------------------------------------- Stats ---------------------------------------- */

async function refreshStats() {
  if (statsBusy) return;
  statsBusy = true;
  try {
    const worker = activeWorker();
    const res = worker ? await ask(worker, { type: "stats" }, 3000) : null;
    if (res?.ok) {
      state.cachedBytes = Number(res.cachedBytes) || 0;
      state.cachedFiles = Number(res.cachedFiles) || 0;
      state.version = res.version ?? null;
      checkVersion();
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
  } finally {
    statsBusy = false;
  }
}

/**
 * A running SW of another version means a stale copy: the module copy updates itself (updateViaCache "none"),
 * the Data-root copy only when someone copies it again. Tell the GM once in that case.
 */
function checkVersion() {
  state.outdated = !!state.version && state.version !== SW_VERSION;
  if (!state.outdated || outdatedWarned || !state.script?.endsWith(`/${DATA_ROOT_SCRIPT}`)) return;
  outdatedWarned = true;
  warn(`${DATA_ROOT_SCRIPT} is outdated (v${state.version}, expected v${SW_VERSION}); copy ${MODULE_PATH}/sw.js to the Data root again.`);
  if (game.user?.isGM) {
    ui.notifications?.warn(game.i18n.format("OPTIMALFOUNDRY.Sw.Outdated", { version: state.version, expected: SW_VERSION }));
  }
}
