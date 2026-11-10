/*
 * Optimal Foundry Service Worker. One classic script with no imports of its own.
 *
 * Scope: the worker must control the route root to see the game page's media, and a worker may only control paths
 * under its own script. A server (or CDN) that sends `Service-Worker-Allowed: /` registers this file where it is,
 * /modules/optimal-foundry/sw.js. Everyone else copies the one-line bridge `optimal-foundry-sw.js` from the module
 * folder to the Data root once; the bridge loads this file with importScripts, so a module update reaches the
 * worker without a new copy. Under the bridge `self.location` is the bridge's URL, so every path here is built
 * from `self.registration.scope`.
 *
 * Same-origin GET requests for media extensions are intercepted; everything else falls through untouched.
 *
 * Immutable optimized media (`<stem>.of-<hash8>.<ext>`): Cache Storage first. On a miss, a whole-body fetch asks
 * the page that made the request for the file over P2P, but only a page that sent `config {p2p: true}` to this
 * worker instance; otherwise it fetches the whole file once (the browser HTTP cache may answer it), streams it to
 * the requester and stores the full 200 response.
 *
 * Mutable media (any other media path; Foundry overwrites same-name files): stored in the same cache, but every
 * hit is revalidated with the stored ETag / Last-Modified first (304 serves the copy, 200 replaces it, 404/410
 * drops it, a network error or 5xx serves the stored copy). At most one revalidation per file every 30 s.
 * Never fetched over P2P. Controlled by the config field `revalidateMutable` (default true; the page can send
 * `{type: "config", revalidateMutable: false}` to turn it off, which also drops the stored mutable copies).
 *
 * Range requests: a cache hit is answered by slicing the stored full body (206). A miss goes straight to the
 * network with the original Range header, never waits for P2P or for a download in flight, and is not stored;
 * media elements always send Range, so streaming starts at once. Whole files reach the cache through preload.
 *
 * Preloads: a request with the header `X-Optimal-Foundry-Preload: 1` is background warming. The header never
 * reaches the server, the download runs with `priority: "low"`, and the page can stop it with
 * `{type: "abort-preload", urls}`, which discards the partial copy. A download the game itself started waiting
 * for is no longer a preload and cannot be aborted.
 *
 * Every response built here carries `X-Optimal-Foundry-Source`, so the page can tell what a file cost:
 * `cache` (a stored copy, or a download another request had already started), `p2p` (from other players) or
 * `net` (downloaded from the server for this request). A response passed through from the network as it came
 * has no such header.
 *
 * Switching itself off: once the module is disabled or uninstalled no page code is left to remove this worker,
 * so it counts game-page loads in IndexedDB and every `config` message resets the count. A load that finds
 * MISSED_HELLOS loads without one unregisters the worker; when the module folder is gone as well (its
 * module.json answers 404) the caches and their metadata are deleted first.
 */
"use strict";

/** Must equal SW_VERSION in scripts/p2p/sw-client.mjs; bump both whenever this file changes. */
const VERSION = "0.3.0";
const CACHE = "optimal-foundry-v1";
const CACHE_PREFIX = "optimal-foundry-";
const DB_NAME = "optimal-foundry-sw";
const OPTIMIZED_RE = /\.of-[0-9a-f]{8}\.([a-z0-9]+)$/i;
const MEDIA_EXT = new Set(["png", "jpg", "jpeg", "bmp", "gif", "webp", "avif", "tif", "tiff",
  "mp4", "m4v", "mov", "webm", "ogv", "wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"]);
const MIME = {
  webp: "image/webp", avif: "image/avif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4",
  mov: "video/quicktime", ogv: "video/ogg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac"
};
const PRELOAD_HEADER = "X-Optimal-Foundry-Preload";
const SOURCE_HEADER = "X-Optimal-Foundry-Source";
const GAME_PAGE = "game";                                   // relative to the scope
const MODULE_MANIFEST = "modules/optimal-foundry/module.json"; // relative to the scope
const MISSED_HELLOS = 3;        // game-page loads without a config message before the worker removes itself
const MAX_KNOWN_PAGES = 16;     // above this, ids of pages that no longer exist are dropped from p2pPages
const TOUCH_EVERY_MS = 60_000;
const MAX_SHARE_OF_QUOTA = 0.5; // a single file may use at most half of the quota
const FIRST_REPLY_MS = 1500;    // a page that does not acknowledge a p2p-get by then is not listening
const REVALIDATE_EVERY_MS = 30_000;

let config = { timeoutMs: 8000, quotaBytes: 4096 * 1048576, revalidateMutable: true };
let missedHellos = 0;       // game-page loads since the last config message, kept in kv "missedHellos"
let stateLoading = null;
let stateLoaded = false;
let helloChain = Promise.resolve();
let meta = null;            // Map key -> {key, bytes, lastAccess}
let metaLoading = null;
let reconciled = false;
let askSeq = 0;
let quotaChain = Promise.resolve();
const inflight = new Map(); // key -> Promise<Blob|null> (resolves when the full file is stored, or null)
const validatedAt = new Map(); // mutable key -> ms of the last successful revalidation
const p2pPages = new Set(); // client ids that sent `config {p2p: true}` since this worker instance started
const preloads = new Map(); // key -> AbortController of a download that only preloads wait for

const warn = (...args) => console.warn("optimal-foundry sw |", ...args);
const isOptimizedKey = key => OPTIMIZED_RE.test(decodePath(new URL(key).pathname));
/** Past the load that unregistered the worker: it may still control an open page, and must leave it alone. */
const retired = () => missedHellos > MISSED_HELLOS;

/* ---------------------------------------- Lifecycle ---------------------------------------- */

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

// Metadata is reconciled on the first config message after any start (applyConfig), not here:
// fetch events queue until activation finishes.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n.startsWith(CACHE_PREFIX) && n !== CACHE).map(n => caches.delete(n)));
    } catch (err) { warn("old cache cleanup failed", err); }
    await self.clients.claim();
  })());
});

/* ---------------------------------------- IndexedDB ---------------------------------------- */

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "key" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
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

/** What survives a worker restart: the config and the count of game-page loads without a hello. */
function loadState() {
  stateLoading ??= Promise.all([
    idb("kv", "readonly", s => s.get("config")),
    idb("kv", "readonly", s => s.get("missedHellos"))
  ]).then(([saved, missed]) => {
    if (saved && typeof saved === "object") config = sanitizeConfig({ ...config, ...saved });
    missedHellos = Number(missed) || 0;
  }).catch(err => warn("state load failed", err))
    .finally(() => { stateLoaded = true; });
  return stateLoading;
}
loadState(); // so the fetch handler can usually decide synchronously whether a request is handled

function sanitizeConfig(c) {
  const timeoutMs = Number(c.timeoutMs);
  const quotaBytes = Number(c.quotaBytes);
  return {
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), 120_000) : 8000,
    quotaBytes: Number.isFinite(quotaBytes) && quotaBytes > 0 ? quotaBytes : 4096 * 1048576,
    revalidateMutable: c.revalidateMutable !== false
  };
}

/** Pages repeat their config every few seconds (it is also their hello), so only a change is written or acted on. */
async function applyConfig(data) {
  await loadState();
  const next = sanitizeConfig({ ...config, ...data });
  const changed = JSON.stringify(next) !== JSON.stringify(config);
  config = next;
  if (changed) await idb("kv", "readwrite", s => s.put(config, "config")).catch(err => warn("config save failed", err));
  await noteHello();
  if (!config.revalidateMutable && (changed || !reconciled)) await dropMutable().catch(err => warn("mutable cleanup failed", err));
  if (!reconciled) await reconcile().catch(err => warn("reconcile failed", err));
  else if (changed) await enforceQuota();
}

function loadMeta() {
  if (meta) return Promise.resolve(meta);
  metaLoading ??= (async () => {
    const m = new Map();
    try {
      const all = await idb("entries", "readonly", s => s.getAll());
      for (const e of all ?? []) if (e?.key) m.set(e.key, e);
    } catch (err) { warn("LRU metadata unavailable, using memory only", err); }
    meta = m;
    return m;
  })();
  return metaLoading;
}

function saveMeta(entry) {
  idb("entries", "readwrite", s => s.put(entry)).catch(() => {});
}

function deleteMeta(keys) {
  if (!keys.length) return;
  idb("entries", "readwrite", s => { for (const k of keys) s.delete(k); }).catch(() => {});
}

/* ---------------------------------------- Switching itself off ---------------------------------------- */

function scopePath() {
  try { return new URL(self.registration.scope).pathname; } catch { return "/"; }
}

function setMissedHellos(n) {
  missedHellos = n;
  return idb("kv", "readwrite", s => s.put(n, "missedHellos")).catch(err => warn("hello count not saved", err));
}

/**
 * The game page is loading. A page of the active module says hello (config) a few seconds later, which puts the
 * count back to zero; a load that finds MISSED_HELLOS loads in a row without one retires the worker.
 */
function noteGameLoad() {
  helloChain = helloChain.then(async () => {
    await loadState();
    const before = missedHellos;
    await setMissedHellos(before + 1);
    if (before >= MISSED_HELLOS) await retire();
  }).catch(err => warn("game load not counted", err));
  return helloChain;
}

function noteHello() {
  helloChain = helloChain.then(async () => {
    await loadState();
    if (missedHellos !== 0) await setMissedHellos(0);
  }).catch(err => warn("hello not counted", err));
  return helloChain;
}

/**
 * Nobody is listening any more. Module disabled in this world: unregister and keep the files for the worlds that
 * use it. Module folder gone: delete the caches and their metadata first. The count stays in IndexedDB above
 * MISSED_HELLOS, so that this worker, which keeps controlling the pages already open and may be restarted for
 * them, stays out of their requests and stores nothing new. A config message (the module is back) resets it.
 */
async function retire() {
  let uninstalled = false;
  try {
    const res = await fetch(new URL(MODULE_MANIFEST, self.registration.scope).href, { cache: "no-store" });
    uninstalled = res.status === 404;
    res.body?.cancel().catch(() => {});
  } catch { /* unreachable server: leave the files alone */ }
  if (uninstalled) {
    await clearAll();
    await idb("kv", "readwrite", s => s.delete("config")).catch(() => {});
  }
  await self.registration.unregister();
}

/** Remember which pages want P2P. Ids of closed pages pile up slowly; drop them once there are many. */
async function notePage(clientId, p2p) {
  if (!clientId) return;
  if (p2p) p2pPages.add(clientId);
  else p2pPages.delete(clientId);
  if (p2pPages.size <= MAX_KNOWN_PAGES) return;
  try {
    const live = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map(c => c.id));
    for (const id of [...p2pPages]) if (!live.has(id)) p2pPages.delete(id);
  } catch { /* keep the ids; a dead one only costs a short wait */ }
}

/* ---------------------------------------- Fetch ---------------------------------------- */

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    if (url.pathname === scopePath() + GAME_PAGE) event.waitUntil(noteGameLoad());
    return;
  }
  // Explicit cache bypasses (CDN probes, converters) go straight to the network.
  if (req.cache === "no-store" || req.cache === "reload") return;
  if (stateLoaded && retired()) return;
  const path = decodePath(url.pathname);
  const m = OPTIMIZED_RE.exec(path);
  const ext = m ? m[1].toLowerCase() : extOfPath(path);
  if (!MEDIA_EXT.has(ext)) return;
  const mutable = !m;
  if (mutable && stateLoaded && !config.revalidateMutable) return;
  const key = canonicalKey(url);
  const preload = req.headers.get(PRELOAD_HEADER) === "1";
  const plain = preload ? withoutPreloadMark(req) : req;
  event.respondWith(handle(event, plain, key, ext, mutable, preload).catch(err => {
    warn("serving from network after error", err);
    return fetch(plain);
  }));
});

function decodePath(pathname) {
  try { return decodeURIComponent(pathname); } catch { return pathname; }
}

function extOfPath(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** The preload mark is a private signal between the page and this worker: the server never sees it. */
function withoutPreloadMark(req) {
  const headers = new Headers(req.headers);
  headers.delete(PRELOAD_HEADER);
  return new Request(req, { headers });
}

/** Same canonical form as sw-client.mjs: origin + each path segment decoded then re-encoded, no query/hash. */
function canonicalKey(url) {
  const segments = url.pathname.split("/").map(s => {
    try { return encodeURIComponent(decodeURIComponent(s)); } catch { return s; }
  });
  return url.origin + segments.join("/");
}

async function handle(event, req, key, ext, mutable, preload) {
  await loadState();
  if (retired() || (mutable && !config.revalidateMutable)) return fetch(req);
  const range = req.headers.get("range");
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) {
    if (mutable) return revalidate(event, req, key, ext, hit, range, preload);
    touch(key);
    return range ? serveBlob(await hit.blob(), range, ext, "cache") : serveStored(hit);
  }
  // Range miss: stream from the network now. No P2P wait, no waiting for a download in flight, no tee.
  if (range) return fetch(req);
  for (let pending; (pending = inflight.get(key));) {
    // The game now waits for this download too: the page's preload abort must not stop it any more.
    if (!preload) preloads.delete(key);
    const blob = await pending;
    if (blob) return serveBlob(blob, null, ext, "cache");
    if (!preload) return fetch(req);
    // A preload whose leader failed or was aborted starts over as the leader, so it stays abortable.
  }
  return lead(event, req, key, ext, mutable, preload);
}

/** First whole-body request for a missing file: P2P (immutable files only), else the network; stores the result. */
async function lead(event, req, key, ext, mutable, preload) {
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  inflight.set(key, done);
  const ctl = preload ? trackPreload(key) : null;
  const finish = blob => {
    if (inflight.get(key) === done) inflight.delete(key);
    untrackPreload(key, ctl);
    settle(blob ?? null);
  };

  try {
    if (!mutable && p2pPages.has(event.clientId) && req.destination !== "audio" && req.destination !== "video") {
      const blob = await askPage(event.clientId, key, ctl?.signal).catch(() => null);
      if (blob && blob.size > 0) {
        const typed = blob.type ? blob : new Blob([blob], { type: MIME[ext] ?? "application/octet-stream" });
        event.waitUntil(storeBlob(key, typed, ext).catch(err => warn("store failed", err)));
        finish(typed);
        return serveBlob(typed, null, ext, "p2p");
      }
    }
    // Default cache mode: a copy already in the browser HTTP cache (fresh, or revalidated with a 304) is reused.
    const net = await fetch(req.url, { credentials: "same-origin", redirect: "follow", ...preloadInit(ctl) });
    if (mutable && net.status === 200) validatedAt.set(key, Date.now()); // the copy is current right now
    return storeNetwork(event, key, ext, net, finish, ctl?.signal);
  } catch (err) {
    finish(null);
    if (ctl?.signal.aborted) return Response.error(); // the page stopped this preload: no second download
    throw err;
  }
}

/** Serve a full 200 network response and store it (tee); anything not cacheable passes through as is. */
function storeNetwork(event, key, ext, net, finish = () => {}, signal) {
  const total = parseLength(net.headers.get("content-length"));
  const cacheable = net.status === 200 && !!net.body && (net.type === "basic" || net.type === "default")
    && (total === null || total <= config.quotaBytes * MAX_SHARE_OF_QUOTA);
  if (!cacheable) {
    finish(null);
    return net;
  }
  const headers = responseHeaders(net.headers, ext, total);
  const [forCache, forClient] = net.body.tee();
  const stored = (async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(key, new Response(forCache, { status: 200, headers }));
      finish(await afterStore(cache, key, total));
    } catch (err) {
      if (!signal?.aborted) warn("cache store failed", key, err);
      finish(null);
      await forget(key); // nothing partial stays behind (an aborted preload ends here)
    }
  })();
  event.waitUntil(stored);
  const forPage = withSource(headers, "net");
  // Behind a CDN the edge says whether it already had the file: only a miss cost the host an upload. The page
  // reads that from this answer; the stored copy does not keep a verdict that was true for one download only.
  const edge = net.headers.get("cf-cache-status");
  if (edge) forPage.set("cf-cache-status", edge);
  return new Response(forClient, { status: 200, headers: forPage });
}

/**
 * Hit on a mutable file: confirm the stored copy is current before serving it. A Range request sends its Range
 * along, so a changed file answers 206 from the network instead of downloading the whole body first.
 */
async function revalidate(event, req, key, ext, hit, range, preload) {
  const serveHit = async () => {
    touch(key);
    return range ? serveBlob(await hit.blob(), range, ext, "cache") : serveStored(hit);
  };
  if (Date.now() - (validatedAt.get(key) ?? 0) < REVALIDATE_EVERY_MS) return serveHit();
  const headers = new Headers();
  const etag = hit.headers.get("etag");
  const lm = hit.headers.get("last-modified");
  if (etag) headers.set("If-None-Match", etag);
  if (lm) headers.set("If-Modified-Since", lm);
  if (range) headers.set("Range", range);
  const ctl = preload ? trackPreload(key) : null;
  let net;
  try {
    net = await fetch(req.url, { cache: "no-store", credentials: "same-origin", redirect: "follow", headers, ...preloadInit(ctl) });
  } catch {
    untrackPreload(key, ctl);
    if (ctl?.signal.aborted) return Response.error();
    return serveHit(); // offline or a tunnel blip: serve the stored copy
  }
  if (net.status === 200 && !range) {
    validatedAt.set(key, Date.now());
    return storeNetwork(event, key, ext, net, () => untrackPreload(key, ctl), ctl?.signal);
  }
  untrackPreload(key, ctl);
  if (net.status === 304) {
    validatedAt.set(key, Date.now());
    return serveHit();
  }
  if (net.status >= 500) return serveHit();
  // Deleted (404/410) or changed (200/206 to a Range request): drop the old copy; the next whole fetch stores the new one.
  if (net.status === 404 || net.status === 410 || net.status === 200 || net.status === 206) await forget(key);
  return net;
}

/* ---------------------------------------- Preloads ---------------------------------------- */

function trackPreload(key) {
  const ctl = new AbortController();
  preloads.set(key, ctl);
  return ctl;
}

function untrackPreload(key, ctl) {
  if (ctl && preloads.get(key) === ctl) preloads.delete(key);
}

/** Fetch options of a preload download: behind everything the game asks for, and stoppable. */
const preloadInit = ctl => (ctl ? { priority: "low", signal: ctl.signal } : {});

/** The page gave up on these preloads (an urgent load started). Returns how many downloads were stopped. */
function abortPreloads(urls) {
  let stopped = 0;
  for (const raw of Array.isArray(urls) ? urls : []) {
    let key;
    try { key = canonicalKey(new URL(raw, self.registration.scope)); } catch { continue; }
    const ctl = preloads.get(key);
    if (!ctl) continue;
    preloads.delete(key);
    ctl.abort();
    stopped++;
  }
  return stopped;
}

/* ---------------------------------------- P2P via the page ---------------------------------------- */

/**
 * Ask the page that made the request to fetch the file from peers. The page acknowledges at once and sends
 * `progress` while it connects and while bytes arrive, so after the first reply `timeoutMs` is an inactivity
 * timeout, not a cap. A page that does not acknowledge within FIRST_REPLY_MS (frozen tab) is skipped.
 * `signal` (a preload the page aborted) cancels the question.
 */
async function askPage(clientId, key, signal) {
  const client = await self.clients.get(clientId).catch(() => null);
  if (!client || signal?.aborted) return null;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const id = ++askSeq;
    let timer = null;
    let settled = false;
    const finish = blob => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      channel.port1.onmessage = null;
      setTimeout(() => { try { channel.port1.close(); } catch {} }, 1000);
      resolve(blob instanceof Blob ? blob : null);
    };
    const cancel = () => {
      try { channel.port1.postMessage({ kind: "cancel", id }); } catch {}
      finish(null);
    };
    const arm = ms => {
      clearTimeout(timer);
      timer = setTimeout(cancel, ms);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    channel.port1.onmessage = ({ data }) => {
      if (!data || data.id !== id) return;
      if (data.kind === "progress") arm(config.timeoutMs);
      else if (data.kind === "done") finish(data.blob ?? null);
    };
    arm(Math.min(FIRST_REPLY_MS, config.timeoutMs));
    try { client.postMessage({ type: "p2p-get", url: key, id }, [channel.port2]); }
    catch { finish(null); }
  });
}

async function broadcast(msg) {
  try {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) { try { c.postMessage(msg); } catch {} }
  } catch {}
}

/* ---------------------------------------- Storage and LRU ---------------------------------------- */

async function storeBlob(key, blob, ext) {
  await loadState();
  if (blob.size > config.quotaBytes * MAX_SHARE_OF_QUOTA) return null;
  const cache = await caches.open(CACHE);
  await cache.put(key, new Response(blob, {
    status: 200,
    headers: { "Content-Type": blob.type || MIME[ext] || "application/octet-stream", "Content-Length": String(blob.size), "Accept-Ranges": "bytes" }
  }));
  return afterStore(cache, key, blob.size);
}

/** Validate what landed in the cache, record it for LRU, announce optimized files to the pages, then enforce the quota. */
async function afterStore(cache, key, expected) {
  const res = await cache.match(key);
  if (!res) return null;
  const blob = await res.blob();
  if (expected !== null && expected !== undefined && blob.size !== expected) {
    await cache.delete(key);
    warn("truncated response discarded", key);
    return null;
  }
  const m = await loadMeta();
  const entry = { key, bytes: blob.size, lastAccess: Date.now() };
  m.set(key, entry);
  saveMeta(entry);
  if (isOptimizedKey(key)) broadcast({ type: "cached", url: key, bytes: blob.size });
  enforceQuota();
  return blob;
}

function touch(key) {
  loadMeta().then(m => {
    const e = m.get(key);
    const now = Date.now();
    if (!e || now - e.lastAccess < TOUCH_EVERY_MS) return;
    e.lastAccess = now;
    saveMeta(e);
  }).catch(() => {});
}

/** Remove one stored file and its metadata. */
async function forget(key) {
  validatedAt.delete(key);
  await caches.open(CACHE).then(c => c.delete(key)).catch(() => {});
  const m = await loadMeta();
  if (m.delete(key)) deleteMeta([key]);
}

/** Drop every stored mutable copy (revalidateMutable turned off). */
async function dropMutable() {
  const cache = await caches.open(CACHE);
  const keys = (await cache.keys()).map(r => r.url).filter(k => !isOptimizedKey(k));
  for (const k of keys) await forget(k);
}

/** Delete every optimal-foundry cache and all LRU metadata. Returns the bytes that were stored. */
async function clearAll() {
  await quotaChain.catch(() => {});
  const m = await loadMeta();
  let freed = 0;
  for (const e of m.values()) freed += e.bytes || 0;
  const names = await caches.keys();
  await Promise.all(names.filter(n => n.startsWith(CACHE_PREFIX)).map(n => caches.delete(n)));
  m.clear();
  validatedAt.clear();
  await idb("entries", "readwrite", s => s.clear()).catch(err => warn("metadata reset failed", err));
  return freed;
}

/** Serialized LRU eviction down to 90% of the quota. Files being fetched right now are never evicted. */
function enforceQuota() {
  quotaChain = quotaChain.then(async () => {
    const m = await loadMeta();
    let total = 0;
    for (const e of m.values()) total += e.bytes || 0;
    if (total <= config.quotaBytes) return;
    const target = config.quotaBytes * 0.9;
    const cache = await caches.open(CACHE);
    const evicted = [];
    for (const e of [...m.values()].sort((a, b) => a.lastAccess - b.lastAccess)) {
      if (total <= target) break;
      if (inflight.has(e.key)) continue;
      await cache.delete(e.key).catch(() => {});
      m.delete(e.key);
      validatedAt.delete(e.key);
      evicted.push(e.key);
      total -= e.bytes || 0;
    }
    deleteMeta(evicted);
    const urls = evicted.filter(isOptimizedKey);
    if (urls.length) broadcast({ type: "evicted", urls });
  }).catch(err => warn("quota enforcement failed", err));
  return quotaChain;
}

/** Bring LRU metadata in line with the cache (entries written by the page directly, or lost metadata). */
async function reconcile() {
  reconciled = true;
  await loadState();
  const cache = await caches.open(CACHE);
  const m = await loadMeta();
  const keys = (await cache.keys()).map(r => r.url);
  const present = new Set(keys);
  const now = Date.now();
  for (const key of keys) {
    if (m.has(key)) continue;
    const res = await cache.match(key);
    if (!res) continue;
    const bytes = parseLength(res.headers.get("content-length")) ?? (await res.blob()).size;
    const entry = { key, bytes, lastAccess: now };
    m.set(key, entry);
    saveMeta(entry);
  }
  const stale = [...m.keys()].filter(k => !present.has(k));
  for (const k of stale) m.delete(k);
  deleteMeta(stale);
  await enforceQuota();
}

async function stats(clientId) {
  const m = await loadMeta();
  let cachedBytes = 0;
  for (const e of m.values()) cachedBytes += e.bytes || 0;
  return {
    ok: true, version: VERSION, cachedBytes, cachedFiles: m.size,
    p2p: p2pPages.has(clientId), quotaBytes: config.quotaBytes, revalidateMutable: config.revalidateMutable
  };
}

/* ---------------------------------------- Responses and ranges ---------------------------------------- */

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

/** A copy of `headers` that also says where the body came from: "cache", "p2p" or "net". */
function withSource(headers, source) {
  const h = new Headers(headers);
  h.set(SOURCE_HEADER, source);
  return h;
}

/** The whole stored file, as stored, marked as coming from the cache. */
function serveStored(hit) {
  return new Response(hit.body, { status: 200, headers: withSource(hit.headers, "cache") });
}

/**
 * Parse a single byte range against a known size (RFC 9110).
 * Returns null to ignore the header (absent, multi-range, malformed), "unsatisfiable", or {start, end} inclusive.
 */
function parseRange(header, size) {
  if (!header || size === null || size === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== "" && Number(m[2]) < start) return null;
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

function serveBlob(blob, rangeHeader, ext, source) {
  const type = blob.type || MIME[ext] || "application/octet-stream";
  const r = parseRange(rangeHeader, blob.size);
  if (r === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}`, "Content-Type": type, [SOURCE_HEADER]: source } });
  }
  if (!r) {
    return new Response(blob, {
      status: 200,
      headers: { "Content-Type": type, "Content-Length": String(blob.size), "Accept-Ranges": "bytes", [SOURCE_HEADER]: source }
    });
  }
  return new Response(blob.slice(r.start, r.end + 1, type), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(r.end - r.start + 1),
      "Content-Range": `bytes ${r.start}-${r.end}/${blob.size}`,
      "Accept-Ranges": "bytes",
      [SOURCE_HEADER]: source
    }
  });
}

/* ---------------------------------------- Messages from pages ---------------------------------------- */

self.addEventListener("message", event => {
  const data = event.data;
  const port = event.ports?.[0];
  const reply = value => { try { port?.postMessage(value); } catch {} };
  if (!data || typeof data !== "object") return;
  const clientId = event.source?.id;
  event.waitUntil((async () => {
    try {
      switch (data.type) {
        case "config":
          await notePage(clientId, data.p2p === true);
          await applyConfig(data);
          reply({ ok: true, version: VERSION });
          break;
        case "stats":
          reply(await stats(clientId));
          break;
        case "claim":
          await self.clients.claim();
          reply({ ok: true, version: VERSION });
          break;
        case "put":
          reply({ ok: !!(await storeFromPage(data.url, data.blob)) });
          break;
        case "clear":
          reply({ ok: true, freedBytes: await clearAll() });
          break;
        case "abort-preload":
          reply({ ok: true, stopped: abortPreloads(data.urls) });
          break;
        default:
          reply({ ok: false, error: "unknown message" });
      }
    } catch (err) {
      warn("message failed", data.type, err);
      reply({ ok: false, error: String(err?.message ?? err) });
    }
  })());
});

async function storeFromPage(url, blob) {
  if (!(blob instanceof Blob) || !blob.size) return null;
  let u;
  try { u = new URL(url, self.location.origin); } catch { return null; }
  if (u.origin !== self.location.origin) return null;
  const m = OPTIMIZED_RE.exec(decodePath(u.pathname));
  if (!m) return null;
  return storeBlob(canonicalKey(u), blob, m[1].toLowerCase());
}
