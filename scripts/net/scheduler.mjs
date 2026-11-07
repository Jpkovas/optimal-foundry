import { MODULE_ID, SOCKET, log, warn, isOptimizedPath } from "../constants.mjs";
import { effectiveNetwork } from "../settings.mjs";
import { on, emit, request, activeGM, isCoordinator, MSG } from "../socket.mjs";
import { isLocalOrigin } from "./cdn.mjs";

/**
 * Network manager. Every client counts its own in-flight media loads (urgent = what the game asked for,
 * preload = background warming) and measures bytes/s. The active GM aggregates the reports, charges preload
 * batches to one token bucket sized to the host upload (`chargeBatch`, called by preload's PRELOAD_NEXT
 * handler), and staggers joining players.
 */

const TICK_MS = 500;
const STATUS_MS = 2000;
const RATE_WINDOW_MS = 5000;
const MAX_SAMPLES = 4000;
const JOIN_TIMEOUT_MS = 20_000;
const JOIN_ACK_MS = 4000;
const JOIN_MAX_WAIT_MS = 180_000;
const CLIENT_STALE_MS = 10_000;
const CLIENT_DROP_MS = 60_000;
const MIN_CHARGE_BYTES = 64 * 1024;
const OWN_URL_GRACE_MS = 3000;
/** Size assumed for a preload item whose size the library does not know. */
export const EST_BYTES = 2 * 1_048_576;

const local = {
  enabled: false,
  started: false,            // initial canvas draw finished (ready)
  urgent: 0,
  preload: 0,
  lastActivity: performance.now(),
  samples: [],               // {t, bytes}
  ownUrls: new Map(),        // absolute URL -> refcount of our own preload fetches
  running: new Set(),        // preload tasks in flight: {url, controller, total, received}
  background: new Set(),     // sources being pre-decoded in the background (no urgent accounting)
  textureRetries: 0,
  windowWaiters: new Set(),
  statusProviders: new Set(),
  goneCbs: new Set(),
  cacheBytes: null,
  turn: { granted: true, position: 0, deadline: 0, promise: Promise.resolve(), resolve: null, notified: false }
};

const gm = {
  clients: new Map(),        // userId -> last CLIENT_STATUS + {name, at}
  p2p: new Map(),            // userId -> {up, down, peers}
  bucket: { tokens: 0, last: performance.now(), rate: 0 },
  joinQueue: [],
  joinCurrent: null,
  joinTimer: null
};

const coordinatorHandlers = new Map(); // type -> GM handler, also callable locally

const net = () => { try { return effectiveNetwork(); } catch { return null; } };
const now = () => performance.now();

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Called at `init`. Installs the load wrappers, the resource observer and the coordination handlers. */
export function initScheduler() {
  try {
    installWrappers();
    // PIXI's default worker image loader fetches textures off the main thread, out of sight of Resource
    // Timing and dependent on blob-worker Service Worker inheritance. Main-thread fetches still decode
    // asynchronously through createImageBitmap(blob).
    try { PIXI.Assets.setPreferences({ preferWorkers: false }); } catch (err) { warn("could not set PIXI preferences", err); }
    observeResources();
    registerHandlers();
    Hooks.once("setup", onSetup);
    Hooks.once("ready", onReady);
    Hooks.on("canvasInit", () => sendStatus());
    // canvas.loading only drops after canvasReady handlers (and an await) have run.
    Hooks.on("canvasReady", () => { local.started = true; setTimeout(sendStatus, 250); });
    Hooks.on("userConnected", onUserConnected);
    local.enabled = true;
  } catch (err) {
    local.enabled = false;
    warn("network manager disabled", err);
  }
}

/** Snapshot for the dashboard and the API. `clients` only on the coordinating GM. */
export function networkStatus() {
  const n = net();
  const status = {
    profile: n?.profile ?? "unknown",
    cdn: !!n?.cdn,
    inflight: local.urgent + local.preload,
    urgent: local.urgent,
    preloading: local.preload,
    textureRetries: local.textureRetries,
    bytesPerSec: bytesPerSec(),
    idle: isIdle(),
    sceneReady: sceneReady(),
    joinTurn: local.turn.granted,
    enabled: local.enabled
  };
  if (game.user?.isGM && isCoordinator()) status.clients = clientsSnapshot();
  return status;
}

/**
 * Run `fn({signal, progress})` under the network manager.
 * - urgent: starts at once, counted, aborts running preloads.
 * - preload: waits for an idle window, then runs; an urgent load aborts it unless the file is served through
 *   the Service Worker (whose own download continues anyway) or `progress.received` is past half of `progress.total`.
 * The budget is charged by the coordinator before the item is handed out, so nothing is asked here.
 * @param {(ctx: {signal?: AbortSignal, progress?: {total: number, received: number}}) => Promise<any>} fn
 * @param {{priority?: "urgent"|"preload", url?: string, signal?: AbortSignal}} [options]
 */
export async function schedule(fn, { priority = "preload", url, signal } = {}) {
  if (priority === "urgent") return runUrgent(() => fn({}));
  while (!preloadWindowOpen()) await waitForPreloadWindow(signal);
  if (signal?.aborted) throw abortError("aborted");
  const task = { url: url ? absUrl(url) : null, controller: new AbortController(), total: 0, received: 0 };
  const onAbort = () => task.controller.abort(abortError("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  local.preload++;
  local.running.add(task);
  if (task.url) local.ownUrls.set(task.url, (local.ownUrls.get(task.url) ?? 0) + 1);
  try {
    return await fn({ signal: task.controller.signal, progress: task });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    local.preload = Math.max(0, local.preload - 1);
    local.running.delete(task);
    if (task.url) setTimeout(() => {
      const c = (local.ownUrls.get(task.url) ?? 1) - 1;
      if (c > 0) local.ownUrls.set(task.url, c); else local.ownUrls.delete(task.url);
    }, OWN_URL_GRACE_MS);
  }
}

/** Resolves when preloading may run here: idle, join turn granted, scene drawn. */
export function waitForPreloadWindow(signal) {
  if (preloadWindowOpen()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const w = { resolve, reject };
    local.windowWaiters.add(w);
    signal?.addEventListener("abort", () => { local.windowWaiters.delete(w); reject(abortError("aborted")); }, { once: true });
  });
}

/** Extra fields merged into this client's periodic CLIENT_STATUS (e.g. preload progress). */
export function registerStatusProvider(fn) {
  local.statusProviders.add(fn);
  return () => local.statusProviders.delete(fn);
}

/** GM: notified when a user disconnects so per-user state can be dropped. */
export function onClientGone(cb) {
  local.goneCbs.add(cb);
  return () => local.goneCbs.delete(cb);
}

/**
 * GM: correct the bucket after a preload batch finished (`delta` = actual - estimated network bytes).
 * Requesters that were never charged (LAN clients, unlimited profiles) are ignored.
 */
export function adjustBudget(delta, fromUserId) {
  if (!Number.isFinite(delta) || !delta || !isCoordinator()) return;
  if (gm.clients.get(fromUserId)?.local) return;
  refill();
  if (!Number.isFinite(gm.bucket.rate)) return;
  const cap = gm.bucket.rate * 2;
  gm.bucket.tokens = Math.min(cap, gm.bucket.tokens - delta);
}

/** Ask the coordinator: local call on the GM itself, socket request otherwise. Rejects without a GM. */
export async function askCoordinator(type, payload, timeoutMs = 8000) {
  if (isCoordinator()) {
    const fn = coordinatorHandlers.get(type);
    if (!fn) throw new Error(`no coordinator handler for ${type}`);
    return fn(payload, game.user.id);
  }
  const target = activeGM();
  if (!target) throw new Error("no active GM");
  return request(type, payload, target.id, timeoutMs);
}

/** Fire-and-forget to the coordinator (local call on the GM). */
export function tellCoordinator(type, payload) {
  if (isCoordinator()) {
    const fn = coordinatorHandlers.get(type);
    if (fn) Promise.resolve().then(() => fn(payload, game.user.id)).catch(err => warn(`${type} failed`, err));
    return;
  }
  const target = activeGM();
  if (target) emit(type, payload, target.id);
}

/** Register a GM-side handler reachable both over the socket and through `askCoordinator` locally. */
export function serveCoordinator(type, fn) {
  coordinatorHandlers.set(type, fn);
  on(type, (payload, from) => (isCoordinator() ? fn(payload, from) : undefined));
}

/** Whether the scene this client views has finished drawing. */
export function sceneReady() {
  return local.started && !globalThis.canvas?.loading;
}

/** Coordinator: true while a remote player is joining, drawing a scene or loading urgently. */
export const playersBusy = () => isCoordinator() && local.enabled && someoneLoading();

/**
 * Decode `srcs` into Foundry's texture cache in the background: 2 at a time, no progress bar, and without the
 * urgent accounting (it neither aborts preloads nor delays the idle window). Never throws.
 */
export async function loadInBackground(srcs) {
  const list = [...new Set(srcs)].filter(s => typeof s === "string" && s && !local.background.has(s));
  if (!list.length) return;
  for (const s of list) local.background.add(s);
  try {
    await foundry.canvas.TextureLoader.loader.load(list, { expireCache: false, maxConcurrent: 2, displayProgress: false });
  } catch (err) {
    warn("background decode failed", err);
  } finally {
    for (const s of list) local.background.delete(s);
  }
}

/* -------------------------------------------- */
/*  Wrappers                                    */
/* -------------------------------------------- */

function installWrappers() {
  const lw = globalThis.libWrapper;
  const register = (target, fn) => {
    try { lw.register(MODULE_ID, target, fn, "WRAPPER"); }
    catch (err) { warn(`could not wrap ${target}`, err); }
  };

  register("foundry.canvas.TextureLoader.prototype.loadTexture", function (wrapped, src, ...args) {
    if (!local.enabled || typeof src !== "string" || !src || src.startsWith("#") || local.background.has(src)
      || textureCached(src)) {
      return wrapped(src, ...args);
    }
    return loadWithRetry(wrapped, src, args);
  });

  // Foundry's loader fires every scene texture at once; behind a tunnel cap it with Foundry's own Semaphore.
  register("foundry.canvas.TextureLoader.prototype.load", function (wrapped, sources, options = {}, ...args) {
    const cap = local.enabled ? urgentCap() : null;
    if (cap && !(options?.maxConcurrent > 0)) options = { ...(options ?? {}), maxConcurrent: cap };
    return wrapped(sources, options, ...args);
  });

  register("foundry.audio.Sound.prototype._load", function (wrapped, ...args) {
    let cached = false;
    try { cached = !!game.audio?.buffers?.getBuffer?.(this.src); } catch { /* count it */ }
    if (!local.enabled || cached) return wrapped(...args);
    return runUrgent(() => wrapped(...args));
  });
}

function textureCached(src) {
  try { return !!PIXI.Assets?.cache?.has?.(src); } catch { return false; }
}

/**
 * Core retries a failed texture only with a cache-bust URL, which it refuses for same-origin files, so a transient
 * tunnel error (429, 5xx, reset) leaves a default icon until the next redraw. Retry same-origin loads up to twice;
 * a HEAD probe (no-store, so the SW does not answer it) gives up at once on a real 4xx. Waits run outside runUrgent.
 */
async function loadWithRetry(wrapped, src, args) {
  if (!local.turn.granted) await waitTurn();
  const load = () => runUrgent(() => wrapped(src, ...args)).catch(() => null);
  let tex = await load();
  if (tex || !sameOriginHttp(src)) return tex;
  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 0;
    try { status = (await fetch(src, { method: "HEAD", cache: "no-store", credentials: "same-origin" })).status; }
    catch { /* network error: retry */ }
    if (status >= 400 && status < 500 && status !== 429) return null; // really missing or forbidden
    if (status >= 200 && status < 300 && attempt > 0) return null;     // reachable but undecodable
    await new Promise(r => setTimeout(r, (attempt ? 2000 : 600) * (0.75 + Math.random() * 0.5)));
    local.textureRetries++;
    tex = await load();
    if (tex) return tex;
  }
  return null;
}

function sameOriginHttp(src) {
  try {
    const u = new URL(src, window.location.href);
    return /^https?:$/.test(u.protocol) && u.origin === window.location.origin;
  } catch { return false; }
}

async function runUrgent(fn) {
  local.urgent++;
  abortPreloads();
  const t0 = now();
  try {
    return await fn();
  } finally {
    local.urgent = Math.max(0, local.urgent - 1);
    // Instant answers come from memory; only real loads delay the idle window.
    if (now() - t0 > 25) local.lastActivity = now();
  }
}

/** Per-client share of the tunnel's concurrent request limit, or null when unlimited. */
function urgentCap() {
  const n = net();
  if (!n?.bandwidthLimited || !Number.isFinite(n.maxConcurrentRequests)) return null;
  if (game.user?.isGM && isLocalOrigin()) return null;
  const users = Math.max(1, game.users?.filter(u => u.active).length ?? 1);
  return Math.max(6, Math.floor(n.maxConcurrentRequests / users));
}

/* -------------------------------------------- */
/*  Measurement and idle                        */
/* -------------------------------------------- */

function observeResources() {
  if (typeof PerformanceObserver !== "function") return;
  const po = new PerformanceObserver(list => {
    const t = now();
    for (const e of list.getEntries()) {
      const bytes = e.transferSize || 0;
      if (bytes > 0) {
        local.samples.push({ t, bytes });
        if (local.samples.length > MAX_SAMPLES) local.samples.splice(0, local.samples.length - MAX_SAMPLES);
      }
      if (local.ownUrls.has(e.name) || e.name.includes("/socket.io/")) continue;
      if (bytes > 0 || e.duration > 50) local.lastActivity = t;
    }
  });
  try { po.observe({ type: "resource", buffered: false }); }
  catch {
    try { po.observe({ entryTypes: ["resource"] }); } catch (err) { warn("resource timing unavailable", err); return; }
  }
  // The timeline buffer (250 entries) fills during a scene load; nothing in core reads it, so recycle it.
  performance.addEventListener?.("resourcetimingbufferfull", () => performance.clearResourceTimings());
}

function bytesPerSec() {
  const cutoff = now() - RATE_WINDOW_MS;
  let i = 0;
  while (i < local.samples.length && local.samples[i].t < cutoff) i++;
  if (i) local.samples.splice(0, i);
  let sum = 0;
  for (const s of local.samples) sum += s.bytes;
  return Math.round(sum / (RATE_WINDOW_MS / 1000));
}

function isIdle() {
  const n = net();
  const idleMs = n?.idleMs ?? 5000;
  return local.urgent === 0 && !globalThis.canvas?.loading && now() - local.lastActivity >= idleMs;
}

const preloadWindowOpen = () => local.enabled && isIdle() && local.turn.granted && sceneReady();

function tick() {
  if (local.windowWaiters.size && preloadWindowOpen()) {
    const ws = [...local.windowWaiters];
    local.windowWaiters.clear();
    for (const w of ws) w.resolve();
  }
  if (!local.turn.granted && now() > local.turn.deadline) grantTurn("timeout");
  if (isCoordinator()) gmTick();
}

/* -------------------------------------------- */
/*  Preload lane                                */
/* -------------------------------------------- */

/** Abort running preloads that are worth aborting: not SW-served optimized files, not past half their bytes. */
function abortPreloads() {
  const sw = !!globalThis.navigator?.serviceWorker?.controller;
  for (const task of local.running) {
    if (sw && task.url && isOptimizedPath(task.url)) continue; // the SW's cache branch keeps downloading anyway
    if (task.total > 0 && task.received >= task.total / 2) continue;
    task.controller.abort(abortError("urgent load"));
  }
}

/* -------------------------------------------- */
/*  Join turn (client side)                     */
/* -------------------------------------------- */

/**
 * The initial canvas draw happens before `ready`, before socket.mjs listens, so the turn handshake runs
 * at `setup` with a raw listener for JOIN_TURN only (socket.mjs has no handler for it, so no double dispatch).
 */
function onSetup() {
  try {
    const n = net();
    const target = activeGM();
    const gate = local.enabled && !game.user.isGM && !!n?.staggerJoin && !!target && !target.isSelf;
    if (gate) {
      local.turn.granted = false;
      local.turn.deadline = now() + JOIN_ACK_MS;
      local.turn.promise = new Promise(resolve => { local.turn.resolve = resolve; });
      game.socket.on(SOCKET, onRawMessage);
      emit(MSG.CLIENT_STATUS, statusPayload({ joining: true }), target.id);
    }
  } catch (err) {
    warn("join queue unavailable", err);
    grantTurn("error");
  }
  setInterval(() => { try { tick(); } catch (err) { warn("network tick failed", err); } }, TICK_MS);
  setInterval(() => sendStatus(), STATUS_MS);
  refreshCacheBytes();
  setInterval(refreshCacheBytes, 30_000);
}

function onReady() {
  // A failed or absent first draw never fires canvasReady.
  local.started = true;
  local.lastActivity = now();
  sendStatus();
}

function onRawMessage(msg, senderId) {
  if (!msg || msg.t !== MSG.JOIN_TURN || msg.re) return;
  if (!senderId || senderId !== activeGM()?.id) return; // only the coordinating GM hands out turns
  if (msg.to && !msg.to.includes(game.user.id)) return;
  const p = msg.p ?? {};
  if (p.go !== false) return grantTurn("gm");
  local.turn.position = Number(p.position) || 0;
  const eta = Math.min(JOIN_MAX_WAIT_MS, Math.max(0, Number(p.etaMs) || JOIN_TIMEOUT_MS));
  local.turn.deadline = now() + eta + 5000;
  if (!local.turn.notified && local.turn.position > 0 && ui.notifications) {
    local.turn.notified = true;
    ui.notifications?.info(game.i18n.format("OPTIMALFOUNDRY.Network.WaitingTurn", { position: local.turn.position }));
  }
}

function waitTurn() {
  return local.turn.granted ? Promise.resolve() : local.turn.promise;
}

function grantTurn(reason) {
  if (local.turn.granted) return;
  local.turn.granted = true;
  local.turn.position = 0;
  local.turn.resolve?.();
  if (reason !== "gm") log(`join turn assumed (${reason})`);
  sendStatus();
}

/* -------------------------------------------- */
/*  Status reports                              */
/* -------------------------------------------- */

function statusPayload(extra = {}) {
  const payload = {
    inflight: local.urgent + local.preload,
    urgent: local.urgent,
    bytesPerSec: bytesPerSec(),
    sceneReady: sceneReady(),
    idle: isIdle(),
    cacheBytes: local.cacheBytes,
    joining: !local.turn.granted,
    local: isLocalOrigin()
  };
  for (const fn of local.statusProviders) {
    try { Object.assign(payload, fn() ?? {}); } catch (err) { warn("status provider failed", err); }
  }
  return Object.assign(payload, extra);
}

function sendStatus() {
  if (!local.enabled || !game.user || !game.socket) return;
  try {
    const payload = statusPayload();
    if (isCoordinator()) recordClient(game.user.id, payload);
    else {
      const target = activeGM();
      if (target) emit(MSG.CLIENT_STATUS, payload, target.id);
    }
  } catch (err) {
    warn("status report failed", err);
  }
}

async function refreshCacheBytes() {
  try { local.cacheBytes = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { local.cacheBytes = null; }
}

/* -------------------------------------------- */
/*  Coordinator (active GM)                     */
/* -------------------------------------------- */

function registerHandlers() {
  on(MSG.CLIENT_STATUS, (payload, from) => {
    if (!isCoordinator() || !payload || typeof payload !== "object" || !game.users.get(from)) return;
    recordClient(from, payload);
    if (payload.joining) enqueueJoin(from);
    else if (payload.sceneReady) {
      // Loaded already (own timeout fallback or no stagger): leave the queue.
      const i = gm.joinQueue.indexOf(from);
      if (i >= 0) { gm.joinQueue.splice(i, 1); notifyQueue(); }
      if (gm.joinCurrent === from) advanceJoin();
    }
  });
  on(MSG.P2P_STATS, (payload, from) => {
    if (!isCoordinator() || !payload || !game.users.get(from)) return;
    gm.p2p.set(from, { up: Number(payload.up) || 0, down: Number(payload.down) || 0, peers: Number(payload.peers) || 0 });
  });
}

function recordClient(userId, payload) {
  const user = game.users.get(userId);
  gm.clients.set(userId, {
    name: user?.name ?? userId,
    inflight: Number(payload.inflight) || 0,
    urgent: Number(payload.urgent) || 0,
    bytesPerSec: Number(payload.bytesPerSec) || 0,
    sceneReady: !!payload.sceneReady,
    idle: !!payload.idle,
    joining: !!payload.joining,
    local: !!payload.local,
    cacheBytes: Number.isFinite(payload.cacheBytes) ? payload.cacheBytes : null,
    preload: { done: Number(payload.preload?.done) || 0, total: Number(payload.preload?.total) || 0 },
    at: Date.now()
  });
}

function clientsSnapshot() {
  const out = {};
  const t = Date.now();
  for (const [id, c] of gm.clients) {
    const { at, ...rest } = c;
    out[id] = { ...rest, stale: t - at > CLIENT_STALE_MS, p2p: gm.p2p.get(id),
      queuePosition: gm.joinCurrent === id ? 0 : gm.joinQueue.indexOf(id) + 1 || undefined };
  }
  return out;
}

function refill() {
  const n = net();
  const rate = n?.preloadBytesPerSec ?? 0;
  const t = now();
  const b = gm.bucket;
  if (rate !== b.rate) { b.rate = rate; b.tokens = Number.isFinite(rate) ? Math.min(b.tokens, rate * 2) : 0; }
  if (Number.isFinite(rate) && rate > 0) b.tokens = Math.min(rate * 2, b.tokens + (t - b.last) / 1000 * rate);
  b.last = t;
}

/** True while someone (other than a GM on localhost) is drawing a scene, joining or loading urgently. */
function someoneLoading() {
  if (gm.joinCurrent) return true;
  const t = Date.now();
  for (const c of gm.clients.values()) {
    if (t - c.at > CLIENT_STALE_MS || c.local) continue;
    if (!c.sceneReady || c.urgent > 0 || c.joining) return true;
  }
  return false;
}

/**
 * Coordinator: charge a preload batch to the host-upload bucket. Returns the affordable prefix of `items`
 * (`{bytes?}` each) and, when nothing is affordable, how long to wait before asking again.
 * - LAN clients and unlimited profiles are not charged.
 * - While a remote player joins or draws a scene (bandwidth-limited profiles), nothing is handed out.
 * - A file larger than the burst waits for a full bucket, is charged in full (debt) and so arrives alone.
 * @template {{bytes?: number}} T
 * @param {T[]} items
 * @param {string} from  requesting user id
 * @returns {{items: T[], waitMs: number}}
 */
export function chargeBatch(items, from) {
  const n = net();
  if (!n || !game.users.get(from)) return { items: [], waitMs: 5000 };
  if (!items.length) return { items: [], waitMs: 0 };
  if (gm.clients.get(from)?.local || !Number.isFinite(n.preloadBytesPerSec)) return { items, waitMs: 0 };
  if (n.bandwidthLimited && someoneLoading()) return { items: [], waitMs: 1500 };
  refill();
  const rate = gm.bucket.rate;
  if (!(rate > 0)) return { items: [], waitMs: 10_000 };
  const out = [];
  let need = 0;
  for (const it of items) {
    const cost = Math.max(MIN_CHARGE_BYTES, Number(it.bytes) || EST_BYTES);
    need = Math.min(cost, rate * 2);
    if (gm.bucket.tokens < need) break;
    gm.bucket.tokens -= cost;
    out.push(it);
  }
  if (out.length) return { items: out, waitMs: 0 };
  const waitMs = Math.ceil((need - gm.bucket.tokens) / rate * 1000);
  return { items: [], waitMs: Math.min(30_000, Math.max(250, waitMs)) };
}

function onUserConnected(user, active) {
  if (!isCoordinator() || user.isSelf) return;
  if (active) {
    // Records arrival order only. The joiner is not listening for its turn until `setup` (world data, i18n and
    // time sync come first); it announces itself then, and only announced joiners get the turn.
    if (!user.isGM) enqueueJoin(user.id, { silent: true });
    return;
  }
  gm.clients.delete(user.id);
  gm.p2p.delete(user.id);
  const i = gm.joinQueue.indexOf(user.id);
  if (i >= 0) gm.joinQueue.splice(i, 1);
  if (gm.joinCurrent === user.id) advanceJoin();
  else notifyQueue();
  for (const cb of local.goneCbs) safeCall(cb, user.id);
}

function enqueueJoin(userId, { silent = false } = {}) {
  const n = net();
  const user = game.users.get(userId);
  if (!user) return;
  if (!n?.staggerJoin || user.isGM) {
    if (!silent) emit(MSG.JOIN_TURN, { go: true }, userId);
    return;
  }
  if (gm.joinCurrent === userId) {
    if (!silent) emit(MSG.JOIN_TURN, { go: true }, userId);
    return;
  }
  if (gm.joinQueue.includes(userId)) {
    if (silent) return;
    processJoin(); // it just announced: it may take a free turn now (processJoin answers go:true)
    if (gm.joinCurrent === userId) return;
    const i = gm.joinQueue.indexOf(userId);
    emit(MSG.JOIN_TURN, { go: false, position: i + 1, etaMs: (i + 1) * JOIN_TIMEOUT_MS }, userId);
    return;
  }
  gm.joinQueue.push(userId);
  processJoin();
  notifyQueue();
}

/** Give the turn to the first queued joiner that has announced itself (its CLIENT_STATUS says joining). */
function processJoin() {
  if (gm.joinCurrent) return;
  gm.joinQueue = gm.joinQueue.filter(id => game.users.get(id)?.active);
  const next = gm.joinQueue.find(id => gm.clients.get(id)?.joining);
  if (!next) return;
  gm.joinQueue.splice(gm.joinQueue.indexOf(next), 1);
  gm.joinCurrent = next;
  clearTimeout(gm.joinTimer);
  gm.joinTimer = setTimeout(() => advanceJoin(), JOIN_TIMEOUT_MS);
  emit(MSG.JOIN_TURN, { go: true }, next);
  notifyQueue();
}

function advanceJoin() {
  clearTimeout(gm.joinTimer);
  gm.joinTimer = null;
  gm.joinCurrent = null;
  processJoin();
}

function notifyQueue() {
  gm.joinQueue.forEach((id, i) => emit(MSG.JOIN_TURN, { go: false, position: i + 1, etaMs: (i + 1) * JOIN_TIMEOUT_MS }, id));
}

function gmTick() {
  const t = Date.now();
  for (const [id, c] of gm.clients) {
    if (id !== game.user.id && (t - c.at > CLIENT_DROP_MS || !game.users.get(id)?.active)) {
      gm.clients.delete(id);
      gm.p2p.delete(id);
    }
  }
  for (const id of gm.p2p.keys()) if (!game.users.get(id)?.active) gm.p2p.delete(id);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function absUrl(url) {
  try { return new URL(url, document.baseURI).href; } catch { return String(url); }
}

function abortError(message) {
  return new DOMException(message, "AbortError");
}

function safeCall(fn, ...args) {
  try { fn(...args); } catch (err) { warn("callback failed", err); }
}
