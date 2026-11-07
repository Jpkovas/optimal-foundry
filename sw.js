/*
 * Optimal Foundry Service Worker. Self-contained classic script (no imports).
 *
 * Same-origin GET requests for media extensions are intercepted; everything else falls through untouched.
 *
 * Immutable optimized media (`<stem>.of-<hash8>.<ext>`): Cache Storage first. On a miss, a whole-body fetch asks
 * the controlling page for the file over P2P (only when the page enabled it), otherwise it fetches the whole file
 * once (the browser HTTP cache may answer it), streams it to the requester and stores the full 200 response.
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
 * Owners with a CDN serve this file from /modules/optimal-foundry/sw.js with `Service-Worker-Allowed: /`.
 * Without that header, copy it to the Data root as `optimal-foundry-sw.js` (served at /optimal-foundry-sw.js).
 */
"use strict";

/** Must equal SW_VERSION in scripts/p2p/sw-client.mjs; bump both whenever this file changes. */
const VERSION = "0.2.0";
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
const PASS_PREFIXES = ["socket.io/", "upload", "setup", "join", "auth"];
const TOUCH_EVERY_MS = 60_000;
const MAX_SHARE_OF_QUOTA = 0.5; // a single file may use at most half of the quota
const FIRST_REPLY_MS = 1500;    // a page that does not acknowledge a p2p-get by then is not listening
const REVALIDATE_EVERY_MS = 30_000;

let config = { p2p: false, timeoutMs: 8000, quotaBytes: 4096 * 1048576, revalidateMutable: true };
let configLoading = null;
let configLoaded = false;
let meta = null;            // Map key -> {key, bytes, lastAccess}
let metaLoading = null;
let reconciled = false;
let askSeq = 0;
let quotaChain = Promise.resolve();
const inflight = new Map(); // key -> Promise<Blob|null> (resolves when the full file is stored, or null)
const validatedAt = new Map(); // mutable key -> ms of the last successful revalidation

const warn = (...args) => console.warn("optimal-foundry sw |", ...args);
const isOptimizedKey = key => OPTIMIZED_RE.test(decodePath(new URL(key).pathname));

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

function loadConfig() {
  configLoading ??= idb("kv", "readonly", s => s.get("config"))
    .then(saved => { if (saved && typeof saved === "object") config = sanitizeConfig({ ...config, ...saved }); })
    .catch(err => warn("config load failed", err))
    .finally(() => { configLoaded = true; });
  return configLoading;
}
loadConfig(); // so the fetch handler can usually decide synchronously whether mutable media is handled

function sanitizeConfig(c) {
  const timeoutMs = Number(c.timeoutMs);
  const quotaBytes = Number(c.quotaBytes);
  return {
    p2p: c.p2p === true,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), 120_000) : 8000,
    quotaBytes: Number.isFinite(quotaBytes) && quotaBytes > 0 ? quotaBytes : 4096 * 1048576,
    revalidateMutable: c.revalidateMutable !== false
  };
}

async function applyConfig(data) {
  await loadConfig();
  config = sanitizeConfig({ ...config, ...data });
  await idb("kv", "readwrite", s => s.put(config, "config")).catch(err => warn("config save failed", err));
  if (!config.revalidateMutable) await dropMutable().catch(err => warn("mutable cleanup failed", err));
  if (!reconciled) await reconcile().catch(err => warn("reconcile failed", err));
  else await enforceQuota();
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

/* ---------------------------------------- Fetch ---------------------------------------- */

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.mode === "navigate") return;
  // Explicit cache bypasses (CDN probes, converters) go straight to the network.
  if (req.cache === "no-store" || req.cache === "reload") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  const path = decodePath(url.pathname);
  const m = OPTIMIZED_RE.exec(path);
  const ext = m ? m[1].toLowerCase() : extOfPath(path);
  if (!MEDIA_EXT.has(ext) || isPassthrough(path)) return;
  const mutable = !m;
  if (mutable && configLoaded && !config.revalidateMutable) return;
  const key = canonicalKey(url);
  event.respondWith(handle(event, req, key, ext, mutable).catch(err => {
    warn("serving from network after error", err);
    return fetch(req);
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

function isPassthrough(path) {
  let scopePath = "/";
  try { scopePath = new URL(self.registration.scope).pathname; } catch {}
  const rel = path.startsWith(scopePath) ? path.slice(scopePath.length) : path.replace(/^\/+/, "");
  return PASS_PREFIXES.some(p => rel.startsWith(p));
}

/** Same canonical form as sw-client.mjs: origin + each path segment decoded then re-encoded, no query/hash. */
function canonicalKey(url) {
  const segments = url.pathname.split("/").map(s => {
    try { return encodeURIComponent(decodeURIComponent(s)); } catch { return s; }
  });
  return url.origin + segments.join("/");
}

async function handle(event, req, key, ext, mutable) {
  if (mutable) {
    await loadConfig();
    if (!config.revalidateMutable) return fetch(req);
  }
  const range = req.headers.get("range");
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) {
    if (mutable) return revalidate(event, req, key, ext, hit, range);
    touch(key);
    return range ? serveBlob(await hit.blob(), range, ext) : hit;
  }
  // Range miss: stream from the network now. No P2P wait, no waiting for a download in flight, no tee.
  if (range) return fetch(req);
  const pending = inflight.get(key);
  if (pending) {
    const blob = await pending;
    return blob ? serveBlob(blob, null, ext) : fetch(req);
  }
  return lead(event, req, key, ext, mutable);
}

/** First whole-body request for a missing file: P2P (immutable files only), else the network; stores the result. */
async function lead(event, req, key, ext, mutable) {
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  inflight.set(key, done);
  const finish = blob => {
    if (inflight.get(key) === done) inflight.delete(key);
    settle(blob ?? null);
  };

  try {
    await loadConfig();
    if (config.p2p && !mutable && req.destination !== "audio" && req.destination !== "video") {
      const blob = await askPage(event, key).catch(() => null);
      if (blob && blob.size > 0) {
        const typed = blob.type ? blob : new Blob([blob], { type: MIME[ext] ?? "application/octet-stream" });
        event.waitUntil(storeBlob(key, typed, ext).catch(err => warn("store failed", err)));
        finish(typed);
        return serveBlob(typed, null, ext);
      }
    }
    // Default cache mode: a copy already in the browser HTTP cache (fresh, or revalidated with a 304) is reused.
    const net = await fetch(new Request(req.url, { credentials: "same-origin", redirect: "follow" }));
    if (mutable && net.status === 200) validatedAt.set(key, Date.now()); // the copy is current right now
    return storeNetwork(event, key, ext, net, finish);
  } catch (err) {
    finish(null);
    throw err;
  }
}

/** Serve a full 200 network response and store it (tee); anything not cacheable passes through as is. */
function storeNetwork(event, key, ext, net, finish = () => {}) {
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
      warn("cache store failed", key, err);
      finish(null);
      caches.open(CACHE).then(c => c.delete(key)).catch(() => {});
    }
  })();
  event.waitUntil(stored);
  return new Response(forClient, { status: 200, headers });
}

/**
 * Hit on a mutable file: confirm the stored copy is current before serving it. A Range request sends its Range
 * along, so a changed file answers 206 from the network instead of downloading the whole body first.
 */
async function revalidate(event, req, key, ext, hit, range) {
  const serveHit = async () => {
    touch(key);
    return range ? serveBlob(await hit.blob(), range, ext) : hit;
  };
  if (Date.now() - (validatedAt.get(key) ?? 0) < REVALIDATE_EVERY_MS) return serveHit();
  const headers = new Headers();
  const etag = hit.headers.get("etag");
  const lm = hit.headers.get("last-modified");
  if (etag) headers.set("If-None-Match", etag);
  if (lm) headers.set("If-Modified-Since", lm);
  if (range) headers.set("Range", range);
  let net;
  try {
    net = await fetch(req.url, { cache: "no-store", credentials: "same-origin", redirect: "follow", headers });
  } catch {
    return serveHit(); // offline or a tunnel blip: serve the stored copy
  }
  if (net.status === 304) {
    validatedAt.set(key, Date.now());
    return serveHit();
  }
  if (net.status >= 500) return serveHit();
  if (net.status === 200 && !range) {
    validatedAt.set(key, Date.now());
    return storeNetwork(event, key, ext, net);
  }
  // Deleted (404/410) or changed (200/206 to a Range request): drop the old copy; the next whole fetch stores the new one.
  if (net.status === 404 || net.status === 410 || net.status === 200 || net.status === 206) await forget(key);
  return net;
}

/* ---------------------------------------- P2P via the page ---------------------------------------- */

/**
 * Ask a window client to fetch the file from peers. The page acknowledges at once and sends `progress` while it
 * connects and while bytes arrive, so after the first reply `timeoutMs` is an inactivity timeout, not a cap.
 * A page that does not acknowledge within FIRST_REPLY_MS (not loaded yet, module disabled, frozen tab) is skipped.
 */
async function askPage(event, key) {
  const client = await pickClient(event.clientId || event.resultingClientId);
  if (!client) return null;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const id = ++askSeq;
    let timer = null;
    let settled = false;
    const finish = blob => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      setTimeout(() => { try { channel.port1.close(); } catch {} }, 1000);
      resolve(blob instanceof Blob ? blob : null);
    };
    const arm = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { channel.port1.postMessage({ kind: "cancel", id }); } catch {}
        finish(null);
      }, ms);
    };
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

async function pickClient(clientId) {
  if (clientId) {
    const c = await self.clients.get(clientId).catch(() => null);
    if (c && c.type === "window") return c;
  }
  const list = await self.clients.matchAll({ type: "window" });
  return list.find(c => c.focused) ?? list.find(c => c.visibilityState === "visible") ?? list[0] ?? null;
}

async function broadcast(msg) {
  try {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) { try { c.postMessage(msg); } catch {} }
  } catch {}
}

/* ---------------------------------------- Storage and LRU ---------------------------------------- */

async function storeBlob(key, blob, ext) {
  await loadConfig();
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
  await loadConfig();
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

async function stats() {
  const m = await loadMeta();
  let cachedBytes = 0;
  for (const e of m.values()) cachedBytes += e.bytes || 0;
  return {
    ok: true, version: VERSION, cachedBytes, cachedFiles: m.size,
    p2p: config.p2p, quotaBytes: config.quotaBytes, revalidateMutable: config.revalidateMutable
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

function serveBlob(blob, rangeHeader, ext) {
  const type = blob.type || MIME[ext] || "application/octet-stream";
  const r = parseRange(rangeHeader, blob.size);
  if (r === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}`, "Content-Type": type } });
  }
  if (!r) {
    return new Response(blob, { status: 200, headers: { "Content-Type": type, "Content-Length": String(blob.size), "Accept-Ranges": "bytes" } });
  }
  return new Response(blob.slice(r.start, r.end + 1, type), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(r.end - r.start + 1),
      "Content-Range": `bytes ${r.start}-${r.end}/${blob.size}`,
      "Accept-Ranges": "bytes"
    }
  });
}

/* ---------------------------------------- Messages from pages ---------------------------------------- */

self.addEventListener("message", event => {
  const data = event.data;
  const port = event.ports?.[0];
  const reply = value => { try { port?.postMessage(value); } catch {} };
  if (!data || typeof data !== "object") return;
  event.waitUntil((async () => {
    try {
      switch (data.type) {
        case "config":
          await applyConfig(data);
          reply({ ok: true, version: VERSION });
          break;
        case "stats":
          reply(await stats());
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
