import { MODULE_ID, MODULE_PATH, log, warn, isOptimizedPath } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { normalizePath } from "../library.mjs";
import { networkStatus } from "./scheduler.mjs";
import { fetchFromPeers, swarmStatus, noteCached, noteEvicted } from "../p2p/swarm.mjs";

/**
 * The local media cache, run by the page itself (no Service Worker, nothing for the game master to install).
 *
 * The global `fetch` is wrapped when this module is installed (main.mjs, at import, before Foundry draws anything)
 * and stays inert until `startLocalCache()` turns the cache on. Foundry and PIXI fetch media with the global
 * `fetch` at call time (PIXI only while its worker loading is off, see scheduler.mjs), so the wrapper sees them.
 * It takes over only same-origin GET requests for media extensions without a `Range` header and without
 * `cache: "no-store"` / `"reload"`; everything else goes to the native `fetch` untouched, and so does any request
 * whose cache code fails.
 *
 * Optimized files (`<stem>.of-<hash8>.<ext>`, immutable): Cache Storage first. On a miss, other players when the
 * swarm is on and the file is eligible, else the network; the full answer is stored (the caller gets the network
 * response, the cache a clone). A second request for a file already downloading waits for that download.
 *
 * Mutable media (any other media path; Foundry overwrites same-name files): stored too, and a stored copy is
 * revalidated with its ETag / Last-Modified at most once per 30 s before it is used. Never fetched over P2P.
 *
 * Storage: Cache Storage `optimal-foundry-v1` (the name 0.2.0's worker used, so players keep their files) and, for
 * LRU metadata, the IndexedDB database `optimal-foundry-cache`. Several tabs of one origin share both, so an
 * eviction is decided from the stored metadata, under a Web Lock, never from one tab's memory.
 *
 * Long sounds: Foundry's `Sound` learns a track's length through an `<audio>` element and plays tracks over 10
 * minutes from that same element. An optimized audio file that is kept whole is handed to such an element as a blob
 * URL instead of its network URL (a narrow override of the `src` setter, see `audioSource`).
 */

const MIB = 1_048_576;
const CACHE = "optimal-foundry-v1";
const CACHE_PREFIX = "optimal-foundry-";
const DB_NAME = "optimal-foundry-cache";
const OLD_DB_NAME = "optimal-foundry-sw"; // the metadata of 0.1.0 / 0.2.0's worker
const OLD_WORKER_SCRIPTS = ["/optimal-foundry-sw.js", `/${MODULE_PATH}/sw.js`];
const OPTIMIZED_EXT_RE = /\.of-[0-9a-f]{8}\.([a-z0-9]+)$/i;
const MEDIA_EXT = new Set(["png", "jpg", "jpeg", "bmp", "gif", "webp", "avif", "tif", "tiff",
  "mp4", "m4v", "mov", "webm", "ogv", "wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"]);
/** Audio only: `.webm` and `.mp4` may be video, which an `<audio>` element override must never touch. */
const AUDIO_EXT = new Set(["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"]);
const MIME = {
  webp: "image/webp", avif: "image/avif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4",
  mov: "video/quicktime", ogv: "video/ogg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac"
};
const MAX_SHARE_OF_QUOTA = 0.5; // a single file may use at most half of the quota
const TOUCH_EVERY_MS = 60_000;
const REVALIDATE_EVERY_MS = 30_000;
const DEFAULT_QUOTA = 4096 * MIB;
const DEFAULT_P2P_TIMEOUT_MS = 8000;
const CONDITIONAL_HEADERS = ["range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"];

/** `on`: the cache is active in this browser. `reason` (when not): "off" | "insecure" | "unsupported" | "error". */
const state = { on: false, reason: "off", quotaBytes: DEFAULT_QUOTA, persisted: null };
let installed = false;
let nativeFetch = null;      // the browser's own fetch, captured before the wrapper replaced it
const meta = new Map();      // key -> {key, bytes, lastAccess}: this tab's copy of the stored metadata
let metaLoading = null;
let quotaChain = Promise.resolve();
let quotaQueued = false;
const inflight = new Map();  // key -> {done: Promise<Blob|null>, ctl, refs, settled}: a download in progress
const validatedAt = new Map(); // mutable key -> ms of the last successful revalidation
const audioBlobs = new Map();  // canonical key of a kept optimized audio file -> blob: URL
/** Errors thrown by the network itself: the caller gets them as they are, they are not a cache failure. */
const networkErrors = new WeakSet();

/* ---------------------------------------- Public API ---------------------------------------- */

/** Called once from main.mjs at module import: wraps the global fetch and the audio-element source. Inert until started. */
export function installLocalCache() {
  if (installed) return;
  installed = true;
  try {
    if (typeof globalThis.fetch === "function") {
      nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = function fetch(...args) { return takeOver(args); };
    }
    wrapAudioSource();
  } catch (err) {
    warn("local cache could not be installed", err);
  }
}

/** Called at `init`, after the settings are registered: decides whether the cache is on for this browser and starts it. */
export function startLocalCache() {
  try {
    if (!getSetting("localCache")) return stop("off");
    if (!globalThis.isSecureContext) return stop("insecure");
    if (!installed || !nativeFetch || !("caches" in globalThis)) return stop("unsupported");
    state.quotaBytes = quotaFromSettings();
    setActive(true);
    Hooks.on(`${MODULE_ID}.settingChanged`, key => { if (key === "cacheQuotaMB") enforceQuota(); });
  } catch (err) {
    stop("error");
    warn("local cache disabled", err);
  }
}

/**
 * Called at `ready`: unregisters the Service Worker of 0.1.0 / 0.2.0 (also while the cache is off, a worker left
 * behind would keep intercepting) and brings the metadata in line with the stored files.
 */
export async function readyLocalCache() {
  await retireOldWorker();
  if (!state.on) return;
  try {
    await reconcile();
    keepAudio().catch(err => warn("kept sounds not indexed", err));
    requestPersistence();
  } catch (err) {
    stop("error");
    warn("local cache disabled", err);
  }
}

/**
 * What the UI shows. `reason` only when not active: "off" (world setting), "insecure" (not HTTPS/localhost),
 * "unsupported", "error".
 * @returns {{active: boolean, reason?: string, cachedBytes: number, cachedFiles: number, quotaBytes: number, persisted: boolean|null}}
 */
export function cacheStatus() {
  let cachedBytes = 0;
  for (const e of meta.values()) cachedBytes += e.bytes || 0;
  const status = { active: state.on, cachedBytes, cachedFiles: meta.size, quotaBytes: state.quotaBytes, persisted: state.persisted };
  if (!state.on) status.reason = state.reason;
  return status;
}

/**
 * The preloader's entry: fetch one media file through the cache. `source` says what it cost: "cache" (nothing),
 * "p2p" (other players) or "net" (the server); `edge` is the `cf-cache-status` of a "net" answer, else null.
 * Aborting `signal` ends this call; the download itself goes on while another caller still waits for it, and stores
 * nothing when nobody does.
 * @param {string} url  absolute, or relative to the page
 * @param {{signal?: AbortSignal, preload?: boolean}} [options]  preload: background warming (low priority, no P2P urgency)
 * @returns {Promise<{response: Response, source: "cache"|"p2p"|"net", edge: string|null}>}
 */
export async function fetchMedia(url, { signal, preload = false } = {}) {
  const u = new URL(url, baseHref());
  const plan = state.on ? classify(u) : null;
  const direct = () => rawFetch(u.href, { credentials: "same-origin", signal, ...(preload ? { priority: "low" } : {}) });
  if (!plan) {
    const response = await direct();
    return { response, source: "net", edge: response.headers.get("cf-cache-status") };
  }
  return viaCache({ ...plan, url: u, signal, preload }, direct);
}

/**
 * Delete every file this browser keeps and tell the swarm.
 * @returns {Promise<{freedBytes: number}>}
 */
export async function clearDeviceCache() {
  const paths = await cachedOptimizedPaths();
  await quotaChain.catch(() => {});
  const m = await syncMeta();
  let freedBytes = 0;
  for (const e of m.values()) freedBytes += e.bytes || 0;
  if ("caches" in globalThis) {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith(CACHE_PREFIX)).map(n => caches.delete(n)));
  }
  m.clear();
  validatedAt.clear();
  for (const key of [...audioBlobs.keys()]) dropAudio(key);
  await idb("entries", "readwrite", s => s.clear()).catch(err => warn("metadata reset failed", err));
  noteEvicted(paths);
  log(`device cache cleared (${paths.length} optimized files, ${freedBytes} bytes)`);
  return { freedBytes };
}

/** Library-form paths (e.g. `maps/x.of-1a2b3c4d.webp`) of every optimized file kept: what the swarm announces. */
export async function cachedOptimizedPaths() {
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

/**
 * A kept file as a Blob (what the swarm serves to other players), or null.
 * @param {string} path  library path or same-origin URL
 */
export async function readCached(path) {
  const key = keyForPath(path);
  if (!key || !("caches" in globalThis)) return null;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(key);
    return res ? await res.blob() : null;
  } catch (err) {
    warn("cache read failed", path, err);
    return null;
  }
}

/* ---------------------------------------- Taking requests over ---------------------------------------- */

const rawFetch = (...args) => (nativeFetch ? nativeFetch(...args) : globalThis.fetch(...args));

/** The network, with its own errors marked so a cache failure is never confused with a failed download. */
async function netFetch(...args) {
  try { return await rawFetch(...args); }
  catch (err) {
    if (err && typeof err === "object") networkErrors.add(err);
    throw err;
  }
}

const baseHref = () => globalThis.document?.baseURI ?? globalThis.location?.href;

function takeOver(args) {
  let plan = null;
  if (state.on) {
    try { plan = planFor(args[0], args[1]); } catch { plan = null; }
  }
  if (!plan) return nativeFetch(...args);
  return viaCache(plan, () => nativeFetch(...args)).then(r => r.response);
}

/** The request as the cache needs it, or null when it is not one the cache takes over. */
function planFor(input, init) {
  const isRequest = typeof Request === "function" && input instanceof Request;
  const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return null;
  const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
  if (CONDITIONAL_HEADERS.some(h => headers.has(h))) return null;
  const mode = init?.cache ?? (isRequest ? input.cache : "default");
  if (mode === "no-store" || mode === "reload") return null;
  const raw = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  const url = new URL(raw, baseHref());
  const plan = classify(url);
  if (!plan) return null;
  return { ...plan, url, signal: init?.signal ?? (isRequest ? input.signal : undefined) ?? undefined, preload: false };
}

/** `{key, ext, mutable}` for a same-origin media URL, else null. */
function classify(url) {
  if (url.origin !== globalThis.location?.origin) return null;
  const path = decodePath(url.pathname);
  const optimized = OPTIMIZED_EXT_RE.exec(path);
  const ext = optimized ? optimized[1].toLowerCase() : extOfPath(path);
  if (!MEDIA_EXT.has(ext)) return null;
  return { key: canonicalKey(url), ext, mutable: !optimized };
}

/** Serve through the cache; a failure inside the cache code (not the network, not the caller's abort) falls back. */
async function viaCache(plan, fallback) {
  try {
    return await serve(plan);
  } catch (err) {
    if (plan.signal?.aborted || networkErrors.has(err)) throw err;
    warn("serving from the network after a cache error", err);
    const response = await fallback();
    return { response, source: "net", edge: response.headers.get("cf-cache-status") };
  }
}

const abortReason = signal => signal.reason ?? new DOMException("This operation was aborted", "AbortError");

/** `handle`, ending as soon as the caller's signal aborts, whatever the cache is doing meanwhile. */
function serve(plan) {
  const { signal } = plan;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const work = handle(plan);
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(result => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) result.response.body?.cancel().catch(() => {});
      else resolve(result);
    }, err => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

async function handle(plan) {
  const { key, ext, mutable, signal } = plan;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) {
    if (mutable) return revalidate(plan, hit);
    touch(key);
    return { response: hit, source: "cache", edge: null };
  }
  for (let download; (download = inflight.get(key));) {
    const blob = await waitFor(download, signal);
    if (blob) return { response: blobResponse(blob, ext), source: "cache", edge: null };
    if (signal?.aborted) throw abortReason(signal);
    // The download failed (or every caller of it gave up): this caller starts over, as the next leader.
  }
  return lead(plan);
}

/** A download stays alive while any caller wants it; when the last one gives up it is aborted and stores nothing. */
function release(download) {
  if (--download.refs <= 0 && !download.settled) download.ctl.abort();
}

/** Wait for a download that someone else started. This caller's abort leaves that download, and its other callers, alone. */
function waitFor(download, signal) {
  download.refs++;
  return new Promise((resolve, reject) => {
    const onAbort = () => { release(download); reject(abortReason(signal)); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    download.done.then(blob => {
      signal?.removeEventListener("abort", onAbort);
      resolve(blob);
    });
  });
}

/** First whole-body request for a missing file: P2P (immutable files only), else the network; stores the result. */
async function lead({ url, key, ext, mutable, signal, preload }) {
  let settle;
  const download = { done: new Promise(resolve => { settle = resolve; }), ctl: new AbortController(), refs: 1, settled: false };
  inflight.set(key, download);
  const onAbort = () => release(download);
  signal?.addEventListener("abort", onAbort, { once: true });
  const finish = blob => {
    if (download.settled) return;
    download.settled = true;
    if (inflight.get(key) === download) inflight.delete(key);
    signal?.removeEventListener("abort", onAbort);
    settle(blob ?? null);
  };
  try {
    if (!mutable && isOptimizedKey(key) && swarmStatus().enabled) {
      const blob = await fromPeers(key, download.ctl.signal, !preload && urgentNow());
      if (blob && blob.size > 0) {
        const typed = blob.type ? blob : new Blob([blob], { type: MIME[ext] ?? "application/octet-stream" });
        storeBlob(key, typed, ext).catch(err => warn("store failed", err));
        finish(typed);
        return { response: blobResponse(typed, ext), source: "p2p", edge: null };
      }
    }
    // Default cache mode: a copy already in the browser's HTTP cache (fresh, or revalidated with a 304) is reused.
    const net = await netFetch(url.href, {
      credentials: "same-origin", redirect: "follow", signal: download.ctl.signal, ...(preload ? { priority: "low" } : {})
    });
    if (mutable && net.status === 200) validatedAt.set(key, Date.now()); // the copy is current right now
    return storeNetwork(key, ext, net, { finish, signal });
  } catch (err) {
    finish(null);
    throw err;
  }
}

/** Ask other players for the file. `p2pTimeoutSec` is an inactivity timeout: every sign of progress starts it over. */
async function fromPeers(key, signal, urgent) {
  const seconds = Number(getSetting("p2pTimeoutSec"));
  const timeoutMs = seconds > 0 ? seconds * 1000 : DEFAULT_P2P_TIMEOUT_MS;
  const silence = new AbortController();
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => silence.abort(), timeoutMs);
  };
  arm();
  try {
    return await fetchFromPeers(key, { signal: AbortSignal.any([signal, silence.signal]), onProgress: arm, urgent });
  } catch (err) {
    warn("P2P fetch failed", key, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True while the game itself waits on media (a scene draw or counted urgent loads): P2P must not add latency. */
function urgentNow() {
  if (globalThis.canvas?.loading) return true;
  try { return networkStatus().urgent > 0; } catch { return false; }
}

/**
 * Give the caller a full 200 network response and store a clone of it; anything not cacheable passes through as it
 * is. A body that fails (an abort, a dropped connection) leaves nothing stored.
 */
function storeNetwork(key, ext, net, { finish = () => {}, signal } = {}) {
  const total = parseLength(net.headers.get("content-length"));
  const edge = net.headers.get("cf-cache-status");
  const cacheable = net.status === 200 && !!net.body && (net.type === "basic" || net.type === "default")
    && (total === null || total <= maxFileBytes());
  if (!cacheable) {
    finish(null);
    return { response: net, source: "net", edge };
  }
  const headers = responseHeaders(net.headers, ext, total);
  const [forCache, forClient] = net.body.tee();
  (async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(key, new Response(forCache, { status: 200, headers }));
      finish(await afterStore(cache, key, total));
    } catch (err) {
      finish(null);
      await forget(key); // nothing partial stays behind
      if (!signal?.aborted && !(err?.name === "AbortError")) warn("cache store failed", key, err);
    }
  })();
  return { response: new Response(endWith(forClient, signal), { status: 200, headers }), source: "net", edge };
}

/**
 * Hit on a mutable file: confirm the stored copy is current before serving it (304 serves it, 200 replaces it,
 * 404/410 drops it, a network error or 5xx serves it).
 */
async function revalidate({ url, key, ext, signal, preload }, hit) {
  const serveHit = () => {
    touch(key);
    return { response: hit, source: "cache", edge: null };
  };
  if (Date.now() - (validatedAt.get(key) ?? 0) < REVALIDATE_EVERY_MS) return serveHit();
  const headers = new Headers();
  const etag = hit.headers.get("etag");
  const lm = hit.headers.get("last-modified");
  if (etag) headers.set("If-None-Match", etag);
  if (lm) headers.set("If-Modified-Since", lm);
  let net;
  try {
    net = await netFetch(url.href, {
      cache: "no-store", credentials: "same-origin", redirect: "follow", headers, signal, ...(preload ? { priority: "low" } : {})
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return serveHit(); // offline or a tunnel blip: serve the stored copy
  }
  if (net.status === 200) {
    validatedAt.set(key, Date.now());
    return storeNetwork(key, ext, net, { signal });
  }
  if (net.status === 304) {
    validatedAt.set(key, Date.now());
    return serveHit();
  }
  if (net.status >= 500) return serveHit();
  // Deleted: drop the old copy; the next whole fetch stores whatever is there then.
  if (net.status === 404 || net.status === 410) await forget(key);
  return { response: net, source: "net", edge: net.headers.get("cf-cache-status") };
}

/**
 * The client's end of a body that is also being stored: it fails when the caller's own signal aborts, even though
 * the download goes on for another caller that still waits for it.
 */
function endWith(body, signal) {
  if (!signal) return body;
  const reader = body.getReader();
  let onAbort = null;
  const detach = () => signal.removeEventListener("abort", onAbort);
  return new ReadableStream({
    start(controller) {
      onAbort = () => {
        controller.error(abortReason(signal));
        reader.cancel().catch(() => {});
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        detach();
        controller.close();
      } catch (err) {
        detach();
        controller.error(err);
      }
    },
    cancel(reason) {
      detach();
      return reader.cancel(reason);
    }
  });
}

/* ---------------------------------------- Keys, headers, responses ---------------------------------------- */

function decodePath(pathname) {
  try { return decodeURIComponent(pathname); } catch { return pathname; }
}

function extOfPath(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Cache Storage key: origin + each path segment decoded then re-encoded, no query or hash. */
function canonicalKey(url) {
  const segments = url.pathname.split("/").map(s => {
    try { return encodeURIComponent(decodeURIComponent(s)); } catch { return s; }
  });
  return url.origin + segments.join("/");
}

/** The key of a library path or same-origin URL (what `readCached` takes), or null for another host. */
function keyForPath(path) {
  const p = normalizePath(path);
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  try {
    const encoded = p.split("/").map(s => encodeURIComponent(s)).join("/");
    return canonicalKey(new URL(foundry.utils.getRoute(encoded), globalThis.location.origin));
  } catch {
    return null;
  }
}

const isOptimizedKey = key => OPTIMIZED_EXT_RE.test(decodePath(new URL(key).pathname));

function parseLength(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Headers of a stored copy: type, length, ranges, plus the validators mutable copies revalidate with. */
function responseHeaders(source, ext, total) {
  const h = new Headers();
  h.set("Content-Type", source.get("content-type") || MIME[ext] || "application/octet-stream");
  if (total !== null) h.set("Content-Length", String(total));
  h.set("Accept-Ranges", "bytes");
  for (const name of ["last-modified", "etag"]) {
    const v = source.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

function blobResponse(blob, ext) {
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": blob.type || MIME[ext] || "application/octet-stream",
      "Content-Length": String(blob.size),
      "Accept-Ranges": "bytes"
    }
  });
}

/* ---------------------------------------- State ---------------------------------------- */

const stop = reason => setActive(false, reason);

/** The swarm only works through this cache, so it hears when the cache turns on or off. */
function setActive(on, reason) {
  const was = state.on;
  state.on = on;
  state.reason = on ? undefined : reason;
  if (was !== on) Hooks.callAll(`${MODULE_ID}.localCacheChanged`);
}

function quotaFromSettings() {
  const bytes = Number(getSetting("cacheQuotaMB")) * MIB;
  return bytes > 0 ? bytes : DEFAULT_QUOTA;
}

/** The quota in force: the setting, capped at 60% of what the browser offers. */
async function refreshQuota() {
  let bytes = quotaFromSettings();
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) bytes = Math.min(bytes, Math.floor(est.quota * 0.6));
  } catch { /* the setting alone */ }
  state.quotaBytes = bytes;
}

const maxFileBytes = () => state.quotaBytes * MAX_SHARE_OF_QUOTA;

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

/** The Service Worker of 0.1.0 / 0.2.0 and its metadata. The Cache Storage stays: it is this cache's too. */
async function retireOldWorker() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const reg of regs) {
      const script = (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL ?? "";
      if (OLD_WORKER_SCRIPTS.some(s => script.endsWith(s)) && await reg.unregister()) log("old Service Worker unregistered");
    }
  } catch (err) {
    warn("old Service Worker cleanup failed", err);
  }
  // Not awaited: the old worker may still hold the database open (it keeps controlling this page until it reloads),
  // and the deletion then completes by itself when it lets go.
  try { globalThis.indexedDB?.deleteDatabase(OLD_DB_NAME); } catch { /* nothing to delete */ }
}

/* ---------------------------------------- IndexedDB metadata ---------------------------------------- */

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("entries")) req.result.createObjectStore("entries", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch(err => { dbPromise = null; throw err; });
  return dbPromise;
}

async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Replace this tab's metadata with what is stored (other tabs write it too). Without IndexedDB it stays as it is. */
async function syncMeta() {
  try {
    const all = await idb("entries", "readonly", s => s.getAll());
    meta.clear();
    for (const e of all ?? []) if (e?.key) meta.set(e.key, e);
  } catch (err) {
    warn("LRU metadata unavailable, using memory only", err);
  }
  return meta;
}

async function loadMeta() {
  metaLoading ??= syncMeta();
  await metaLoading;
  return meta;
}

function saveMeta(entry) {
  idb("entries", "readwrite", s => s.put(entry)).catch(() => {});
}

function deleteMeta(keys) {
  if (!keys.length) return Promise.resolve();
  return idb("entries", "readwrite", s => { for (const k of keys) s.delete(k); }).catch(() => {});
}

/* ---------------------------------------- Storage and LRU ---------------------------------------- */

async function storeBlob(key, blob, ext) {
  if (blob.size > maxFileBytes()) return null;
  const cache = await caches.open(CACHE);
  await cache.put(key, new Response(blob, {
    status: 200,
    headers: { "Content-Type": blob.type || MIME[ext] || "application/octet-stream", "Content-Length": String(blob.size), "Accept-Ranges": "bytes" }
  }));
  return afterStore(cache, key, blob.size);
}

/** Validate what landed in the cache, record it for LRU, announce optimized files, then enforce the quota. */
async function afterStore(cache, key, expected) {
  const res = await cache.match(key);
  if (!res) return null;
  const blob = await res.blob();
  if (expected !== null && expected !== undefined && blob.size !== expected) {
    await forget(key);
    warn("truncated response discarded", key);
    return null;
  }
  if (blob.size > maxFileBytes()) {
    await forget(key);
    return null;
  }
  const entries = await loadMeta();
  const entry = { key, bytes: blob.size, lastAccess: Date.now() };
  entries.set(key, entry);
  saveMeta(entry);
  if (isOptimizedKey(key)) {
    noteCached([key]);
    offerAudio(key, blob);
  }
  enforceQuota();
  return blob;
}

function touch(key) {
  loadMeta().then(entries => {
    const e = entries.get(key);
    const now = Date.now();
    if (!e || now - e.lastAccess < TOUCH_EVERY_MS) return;
    e.lastAccess = now;
    saveMeta(e);
  }).catch(() => {});
}

/** Remove one stored file and its metadata. */
async function forget(key) {
  validatedAt.delete(key);
  dropAudio(key);
  await caches.open(CACHE).then(c => c.delete(key)).catch(() => {});
  const entries = await loadMeta();
  if (entries.delete(key)) await deleteMeta([key]);
}

/**
 * LRU eviction down to 90% of the quota, one at a time (a Web Lock also keeps tabs from evicting at once). The
 * decision reads the stored metadata, not this tab's copy. A file being downloaded here is never evicted.
 */
function enforceQuota() {
  if (quotaQueued) return quotaChain;
  quotaQueued = true;
  quotaChain = quotaChain.then(() => {
    quotaQueued = false;
    return withLock(evictOverQuota);
  }).catch(err => warn("quota enforcement failed", err));
  return quotaChain;
}

const withLock = fn => (globalThis.navigator?.locks ? navigator.locks.request(`${CACHE}-quota`, fn) : fn());

async function evictOverQuota() {
  await refreshQuota();
  const entries = await syncMeta();
  let total = 0;
  for (const e of entries.values()) total += e.bytes || 0;
  if (total <= state.quotaBytes) return;
  const target = state.quotaBytes * 0.9;
  const cache = await caches.open(CACHE);
  const evicted = [];
  for (const e of [...entries.values()].sort((a, b) => a.lastAccess - b.lastAccess)) {
    if (total <= target) break;
    if (inflight.has(e.key)) continue;
    await cache.delete(e.key).catch(() => {});
    entries.delete(e.key);
    validatedAt.delete(e.key);
    dropAudio(e.key);
    evicted.push(e.key);
    total -= e.bytes || 0;
  }
  await deleteMeta(evicted);
  const urls = evicted.filter(isOptimizedKey);
  if (urls.length) noteEvicted(urls);
}

/** Bring the metadata in line with the cache (files written by 0.2.0's worker, lost or stale metadata). */
async function reconcile() {
  const cache = await caches.open(CACHE);
  const entries = await syncMeta();
  const keys = (await cache.keys()).map(r => r.url);
  const present = new Set(keys);
  const now = Date.now();
  for (const key of keys) {
    if (entries.has(key)) continue;
    const res = await cache.match(key);
    if (!res) continue;
    const bytes = parseLength(res.headers.get("content-length")) ?? (await res.blob()).size;
    const entry = { key, bytes, lastAccess: now };
    entries.set(key, entry);
    saveMeta(entry);
  }
  const stale = [...entries.keys()].filter(k => !present.has(k));
  for (const k of stale) entries.delete(k);
  await deleteMeta(stale);
  await enforceQuota();
}

/* ---------------------------------------- Long sounds ---------------------------------------- */

/** A kept optimized audio file becomes playable from memory-backed storage: remember a blob URL for it. */
function offerAudio(key, blob) {
  if (!state.on || audioBlobs.has(key) || !AUDIO_EXT.has(extOfPath(decodePath(new URL(key).pathname)))) return;
  audioBlobs.set(key, URL.createObjectURL(blob));
}

function dropAudio(key) {
  const url = audioBlobs.get(key);
  if (!url) return;
  audioBlobs.delete(key);
  try { URL.revokeObjectURL(url); } catch { /* already gone */ }
}

/** At start: the kept audio files, one at a time so it never competes with the scene that is drawing. */
async function keepAudio() {
  const cache = await caches.open(CACHE);
  for (const request of await cache.keys()) {
    const key = request.url;
    if (audioBlobs.has(key) || !isOptimizedKey(key)) continue;
    const res = await cache.match(key);
    if (res) offerAudio(key, await res.blob());
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * The `src` a new `<audio>` element gets: a kept optimized file's blob URL, else exactly what was asked for. Only
 * `<audio>` elements and only URLs in `audioBlobs` are touched (so `src = ""`, a `<video>` and every other URL pass).
 */
function audioSource(element, value) {
  if (!audioBlobs.size || typeof value !== "string" || !value || !(element instanceof globalThis.HTMLAudioElement)) return value;
  try { return audioBlobs.get(canonicalKey(new URL(value, baseHref()))) ?? value; }
  catch { return value; }
}

function wrapAudioSource() {
  const proto = globalThis.HTMLMediaElement?.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "src");
  if (!desc?.set || !desc.configurable) return;
  Object.defineProperty(proto, "src", { ...desc, set(value) { desc.set.call(this, audioSource(this, value)); } });
}
