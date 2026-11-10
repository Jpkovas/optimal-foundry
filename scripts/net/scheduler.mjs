import { MODULE_ID, SOCKET, log, warn } from "../constants.mjs";
import { effectiveNetwork } from "../settings.mjs";
import { on, emit, request, activeGM, isCoordinator, MSG } from "../socket.mjs";
import { isLocalOrigin, isLoopbackOrigin } from "./cdn.mjs";
import { cacheStatus } from "./local-cache.mjs";
import { swarmStatus } from "../p2p/swarm.mjs";

/**
 * Network manager. Every client counts its own in-flight media loads (urgent = what the game asked for,
 * preload = background warming) and measures bytes/s. The active GM aggregates the reports, charges preload
 * batches to one token bucket (`chargeBatch`, called by preload's PRELOAD_NEXT handler), and staggers joining
 * players.
 *
 * The bucket's ceiling is the share of the host upload the GM typed in the settings, which is often wrong or
 * eaten by a screen share, so the rate adapts below it. The coordinator answers every status report and each
 * client sends the round trip of its previous report along with the next. When most remote clients see theirs
 * well above their own best of the session, the host's uplink is queueing: the rate is halved, and it climbs
 * back a tenth of the ceiling at a time once the round trips are back to normal. Round trips measured while a
 * player loads a scene do not count: the game itself fills the uplink then.
 */

const TICK_MS = 500;
const STATUS_MS = 2000;
const STATUS_ACK_MS = 5000;      // a status report unanswered for this long counts as a round trip this slow
const URGENT_SETTLE_MS = 300;    // urgent loads that follow each other within this long are reported as one
const RATE_WINDOW_MS = 5000;
const MAX_SAMPLES = 4000;
const JOIN_TIMEOUT_MS = 20_000;
const JOIN_ACK_MS = 4000;
const JOIN_SILENCE_MS = 30_000;  // a queued joiner waits at most this long after the GM's last word
const HEAD_TIMEOUT_MS = 4000;
const CLIENT_STALE_MS = 10_000;
const CLIENT_DROP_MS = 60_000;
const BUSY_MAX_MS = 75_000;      // a client busy for this long without a break stops pausing everyone else
const BUSY_WAIT_MS = 1500;
const MIN_CHARGE_BYTES = 64 * 1024;
const OWN_URL_GRACE_MS = 3000;
const BURST_S = 2;               // the bucket holds this many seconds of the rate
const CLAIM_TTL_MS = 5000;       // how long a client refused for tokens keeps later tiers away from the bucket
const ADAPT_MS = 5000;           // the rate moves one step per this long
const RECOVER_SHARE = 0.1;       // ...up by this share of the ceiling while the uplink is fine
const MIN_RATE_SHARE = 1 / 8;    // ...and never below this share of the ceiling
const RTT_RECENT = 3;            // round trips behind a client's "recent" value (their minimum: one stall is not a queue)
const RTT_MAX_MS = 60_000;
const MAX_HANDED = 64;           // charges kept per user until its batch reports; a client holds one batch per tab
/** Size assumed for a preload item whose size the library does not know. */
const EST_BYTES = 2 * 1_048_576;
/** The "later" preload tier (the rest of the world): it gets at most half of the current rate. */
export const LATER_TIER = 3;

const local = {
  enabled: false,
  started: false,            // initial canvas draw finished (ready)
  ready: false,              // Foundry's `ready` passed: socket.mjs listens, so requests can be answered
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
  rttMs: null,               // round trip of the last answered status report, sent once with the next one
  reportedUrgent: false,     // the coordinator's last news from us said "loading urgently"
  urgentTimer: null,
  turn: { granted: true, position: 0, deadline: 0, promise: Promise.resolve(), resolve: null, notified: false }
};

const gm = {
  clients: new Map(),        // userId -> last CLIENT_STATUS + {name, at, busySince}
  rtt: new Map(),            // userId -> {base, recent: number[], at}: status round trips of clients that are not on the host
  rttFrom: 0,                // epoch ms from which round trips count again after a player was loading
  // `later` is the last tier's own allowance inside the bucket; `rate` moves between a floor and `ceiling`.
  bucket: { tokens: 0, later: 0, last: performance.now(), ceiling: 0, rate: 0, stepAt: 0 },
  claims: new Map(),         // userId -> {tier, until}: refused for tokens on an item of that tier
  handed: new Map(),         // userId -> Map<src, {cost, later}>: what each user was charged, until its batch reports
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
    // PIXI's default worker image loader fetches textures inside a worker, where the page's global fetch (the
    // local cache's wrapper) does not exist: those images would bypass the cache and Resource Timing. Main-thread
    // fetches still decode asynchronously through createImageBitmap(blob).
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

/**
 * Snapshot for the dashboard and the API. Only on the coordinating GM: `clients` (per user, with `secure`, `cache`
 * and `p2p`: HTTPS or localhost, the local cache is active, the browser can share right now) and `budget`
 * `{rateBytesPerSec, ceilingBytesPerSec, slowed, rttMs}`: the preload rate in force, the ceiling from the settings,
 * whether round trips pushed the rate below it, and the median recent round trip of the remote clients (null
 * before the first one).
 */
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
  if (game.user?.isGM && isCoordinator()) {
    status.clients = clientsSnapshot();
    status.budget = budgetSnapshot();
  }
  return status;
}

/**
 * Run `fn({signal, progress})` under the network manager.
 * - urgent: starts at once, counted, aborts running preloads.
 * - preload: waits for an idle window, then runs; an urgent load aborts it (through the `signal` it was given)
 *   unless `progress.received` is past half of `progress.total`.
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

/**
 * Coordinator: how this user's browser reaches the server, from its last status report.
 * - "loopback": on the server's own machine; what it downloads costs the host no upload.
 * - "private": a private address, which may be a LAN but just as well a VPN across the host's uplink, so it is
 *   charged like any remote client; it never goes through a public CDN.
 * - "public": a public hostname (also assumed before the first report); behind a CDN, its requests reach the edge.
 * @returns {"loopback"|"private"|"public"}
 */
export function clientOrigin(userId) {
  const c = gm.clients.get(userId);
  return c?.local ? "loopback" : (c && !c.publicOrigin) ? "private" : "public";
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
 * a HEAD probe (never taken over by the local cache) gives up at once on a real 4xx. Waits run outside runUrgent.
 */
async function loadWithRetry(wrapped, src, args) {
  if (!local.turn.granted) await waitTurn();
  const load = () => runUrgent(() => wrapped(src, ...args)).catch(() => null);
  let tex = await load();
  if (tex || !sameOriginHttp(src)) return tex;
  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 0;
    try {
      // Without a timeout a probe that stalls on a flaky link would hold the scene's loading bar.
      status = (await fetch(src, { method: "HEAD", cache: "no-store", credentials: "same-origin",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) })).status;
    } catch { /* network error or timeout: retry */ }
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
  const first = local.urgent++ === 0;
  abortPreloads();
  if (first) urgentStarted();
  const t0 = now();
  try {
    return await fn();
  } finally {
    local.urgent = Math.max(0, local.urgent - 1);
    // Instant answers come from memory; only real loads delay the idle window.
    if (now() - t0 > 25) local.lastActivity = now();
    if (local.urgent === 0) urgentEnded();
  }
}

/**
 * This browser started waiting on media. The swarm hears it through the hook, and the coordinator at once instead
 * of at the next timed report, so it stops handing out preloads that would compete with this load.
 */
function urgentStarted() {
  try { Hooks.callAll(`${MODULE_ID}.urgentLoad`); } catch (err) { warn("urgentLoad hook failed", err); }
  if (!local.reportedUrgent) sendStatus();
}

/** No urgent load is left: report it once things settle, so a run of short loads is not a message each. */
function urgentEnded() {
  clearTimeout(local.urgentTimer);
  local.urgentTimer = setTimeout(() => { if (local.urgent === 0 && local.reportedUrgent) sendStatus(); }, URGENT_SETTLE_MS);
}

/** Per-client share of the tunnel's concurrent request limit, or null when unlimited. */
function urgentCap() {
  const n = net();
  if (!Number.isFinite(n?.maxConcurrentRequests)) return null;
  if (game.user?.isGM && isLoopbackOrigin()) return null;
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

/**
 * A video texture, a streamed sound or a media element on the page that is downloading and does not hold enough
 * to keep playing yet. Resource Timing lists such a request only when it ends, so the idle clock cannot see it.
 */
function mediaBuffering() {
  const starving = el => !!el && el.networkState === 2 && el.readyState < 4; // NETWORK_LOADING, below HAVE_ENOUGH_DATA
  try {
    for (const mesh of globalThis.canvas?.primary?.videoMeshes ?? []) if (starving(mesh.sourceElement)) return true;
    for (const sound of globalThis.game?.audio?.playing?.values() ?? []) if (starving(sound.element)) return true;
    for (const el of document.querySelectorAll("video, audio")) if (starving(el)) return true;
  } catch { /* canvas or audio not ready */ }
  return false;
}

function tick() {
  if (mediaBuffering()) local.lastActivity = now();
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

/**
 * Abort running preloads, except those past half of their bytes. The local cache runs in this page: aborting a
 * preload's signal ends its download (unless the game started waiting for the same file meanwhile).
 */
function abortPreloads() {
  for (const task of local.running) {
    if (task.controller.signal.aborted) continue;
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
  local.ready = true;
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
  // The GM answers every "joining" report (one per STATUS_MS) with the position again, so a live queue keeps moving
  // this deadline; a GM that went away is not waited for longer than JOIN_SILENCE_MS.
  const eta = Math.max(0, Number(p.etaMs) || JOIN_TIMEOUT_MS);
  local.turn.deadline = now() + Math.min(JOIN_SILENCE_MS, eta + 5000);
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
    local: isLoopbackOrigin(),       // on the server's own machine: what it downloads costs the host no upload
    publicOrigin: !isLocalOrigin(),  // may sit behind a CDN, so it can run the CDN probe for a GM on localhost
    secure: !!globalThis.isSecureContext,
    cache: false,
    p2p: false
  };
  try {
    payload.cache = !!cacheStatus().active;
    payload.p2p = !!swarmStatus().enabled;
  } catch { /* not started yet */ }
  for (const fn of local.statusProviders) {
    try { Object.assign(payload, fn() ?? {}); } catch (err) { warn("status provider failed", err); }
  }
  return Object.assign(payload, extra);
}

function sendStatus() {
  if (!local.enabled || !game.user || !game.socket) return;
  try {
    const payload = statusPayload();
    local.reportedUrgent = payload.urgent > 0;
    if (isCoordinator()) return recordClient(game.user.id, payload);
    const target = activeGM();
    if (!target) return;
    if (!local.ready) return emit(MSG.CLIENT_STATUS, payload, target.id); // no answer could be heard yet
    // The coordinator answers each report. The round trip crosses the host's uplink, so it grows when preloads
    // (or anything else) fill it: the next report carries it, and the coordinator adapts the budget to it.
    // No answer in time is a round trip at least that slow.
    payload.rttMs = local.rttMs;
    local.rttMs = null;
    const t0 = now();
    const timed = () => { local.rttMs = Math.min(STATUS_ACK_MS, Math.round(now() - t0)); };
    request(MSG.CLIENT_STATUS, payload, target.id, STATUS_ACK_MS).then(timed, timed);
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
    return true; // the answer the client times (see sendStatus); a passive session returns nothing
  });
}

function recordClient(userId, payload) {
  const user = game.users.get(userId);
  const t = Date.now();
  const busy = !payload.sceneReady || Number(payload.urgent) > 0 || !!payload.joining;
  gm.clients.set(userId, {
    name: user?.name ?? userId,
    inflight: Number(payload.inflight) || 0,
    urgent: Number(payload.urgent) || 0,
    bytesPerSec: Number(payload.bytesPerSec) || 0,
    sceneReady: !!payload.sceneReady,
    idle: !!payload.idle,
    joining: !!payload.joining,
    local: !!payload.local,
    publicOrigin: !!payload.publicOrigin,
    secure: !!payload.secure,
    cache: !!payload.cache,
    p2p: !!payload.p2p,
    cacheBytes: Number.isFinite(payload.cacheBytes) ? payload.cacheBytes : null,
    preload: { done: Number(payload.preload?.done) || 0, total: Number(payload.preload?.total) || 0 },
    busySince: busy ? (gm.clients.get(userId)?.busySince ?? t) : null,
    at: t
  });
  // While a player loads, the game itself fills the uplink (and no preload is handed out): round trips measured
  // then say nothing about the budget. A report carries the round trip of the one before it, hence two periods.
  if (someoneLoading()) gm.rttFrom = t + 2 * STATUS_MS;
  else if (!payload.local && t >= gm.rttFrom) noteRtt(userId, payload.rttMs);
}

function clientsSnapshot() {
  const out = {};
  const t = Date.now();
  for (const [id, c] of gm.clients) {
    const { at, busySince, ...rest } = c;
    out[id] = { ...rest, stale: t - at > CLIENT_STALE_MS,
      queuePosition: gm.joinCurrent === id ? 0 : gm.joinQueue.indexOf(id) + 1 || undefined };
  }
  return out;
}

function forgetClient(userId) {
  gm.clients.delete(userId);
  gm.rtt.delete(userId);
  gm.claims.delete(userId);
  gm.handed.delete(userId);
}

/**
 * True while someone (other than a client on the server's own machine) is drawing a scene, joining or loading
 * urgently. A client that says so for BUSY_MAX_MS without a break is no longer believed: a request stalled in a
 * dead spot, or a module error that leaves its canvas "loading", must not pause everyone else for the session.
 */
function someoneLoading() {
  if (gm.joinCurrent) return true;
  const t = Date.now();
  for (const c of gm.clients.values()) {
    if (t - c.at > CLIENT_STALE_MS || c.local || c.busySince === null) continue;
    if (t - c.busySince < BUSY_MAX_MS) return true;
  }
  return false;
}

/* -------------------------------------------- */
/*  Budget (coordinator)                        */
/* -------------------------------------------- */

/** A status round trip a remote client measured. Its best of the session is its baseline. */
function noteRtt(userId, ms) {
  if (!Number.isFinite(ms) || !(ms > 0)) return;
  const r = gm.rtt.get(userId) ?? { base: Infinity, recent: [], at: 0 };
  const sample = Math.min(ms, RTT_MAX_MS);
  r.base = Math.min(r.base, sample);
  r.recent.push(sample);
  if (r.recent.length > RTT_RECENT) r.recent.shift();
  r.at = Date.now();
  gm.rtt.set(userId, r);
}

/**
 * What the round trips say about the host's uplink. A client is "high" when even the best of its last few round
 * trips is more than twice its baseline plus 100 ms. A queue on the host's uplink shows on every remote client; a
 * single client's own slow link (or its own busy browser) must not slow everyone, so it takes more than half of
 * the clients that report to call the uplink congested. `rttMs` is their median recent round trip.
 */
function rttState() {
  const t = Date.now();
  const recent = [];
  let high = 0;
  for (const r of gm.rtt.values()) {
    if (t - r.at > CLIENT_STALE_MS) continue;
    const ms = Math.min(...r.recent);
    recent.push(ms);
    if (ms > 2 * r.base + 100) high++;
  }
  recent.sort((a, b) => a - b);
  return { congested: high * 2 > recent.length, rttMs: recent.length ? recent[recent.length >> 1] : null };
}

/** Bring the bucket up to date: the ceiling from the settings, one rate step per ADAPT_MS, then the new tokens. */
function refill() {
  const b = gm.bucket;
  const ceiling = net()?.preloadBytesPerSec ?? 0;
  const t = now();
  if (ceiling !== b.ceiling) {
    b.ceiling = b.rate = ceiling;
    b.stepAt = t;
  } else if (t - b.stepAt >= ADAPT_MS) {
    b.stepAt = t;
    // The rate stays where it is while a player loads: nothing is handed out then, and nothing is measured.
    if (!someoneLoading()) {
      b.rate = rttState().congested
        ? Math.max(ceiling * MIN_RATE_SHARE, b.rate / 2)
        : Math.min(ceiling, b.rate + ceiling * RECOVER_SHARE);
    }
  }
  const burst = b.rate * BURST_S;
  const gained = Math.max(0, t - b.last) / 1000 * b.rate;
  b.tokens = Math.min(burst, b.tokens + gained);
  b.later = Math.min(burst / 2, b.later + gained / 2);
  b.last = t;
}

function budgetSnapshot() {
  refill();
  const b = gm.bucket;
  return {
    rateBytesPerSec: Math.round(b.rate),
    ceilingBytesPerSec: Math.round(b.ceiling),
    slowed: b.rate < b.ceiling,
    rttMs: rttState().rttMs
  };
}

/** Take `bytes` from the bucket (negative gives back), and from the last tier's allowance when `later`. */
function spend(bytes, later) {
  const b = gm.bucket;
  const burst = b.rate * BURST_S;
  // One file of the largest size preloading accepts is the deepest honest debt; nothing may dig deeper.
  const floor = -(net()?.preloadMaxBytes ?? 0);
  b.tokens = Math.min(burst, Math.max(floor, b.tokens - bytes));
  if (later) b.later = Math.min(burst / 2, Math.max(floor, b.later - later));
}

/** The earliest tier another user is waiting on tokens for: anything later would take them from under it. */
function claimedTier(from, t) {
  let tier = Infinity;
  for (const [id, c] of gm.claims) {
    if (c.until <= t) gm.claims.delete(id);
    else if (id !== from) tier = Math.min(tier, c.tier);
  }
  return tier;
}

/**
 * Coordinator: charge a preload batch to the host-upload bucket. Returns the items handed out and, when there are
 * none, how long to wait before asking again. Each item says who uploads it (`source`):
 * - "host" (default): costs its size. A file larger than the burst waits for a full bucket, is charged in full
 *   (debt) and so arrives alone. An item of the last tier also needs that tier's allowance, half of the rate.
 *   Nothing is handed out while a remote player joins, draws a scene or loads urgently. A client refused for
 *   tokens on an item of tier T holds a claim for CLAIM_TTL_MS: meanwhile other clients get nothing of a later
 *   tier, so small files of the last tier cannot keep the bucket empty under a large file that is needed next.
 *   After the first refusal nothing else that costs upload is handed out in this batch (the queue order holds).
 * - "peer": a seeder holds it, so it costs nothing now; if it comes from the host after all, `settleBatch` charges it.
 * - "edge": the CDN's edge holds it, it never costs anything.
 * A client on the server's own machine is never charged.
 * @template {{src: string, bytes?: number, tier?: number, source?: "host"|"peer"|"edge"}} T
 * @param {T[]} items
 * @param {string} from  requesting user id
 * @returns {{items: T[], waitMs: number}}
 */
export function chargeBatch(items, from) {
  const n = net();
  if (!n || !game.users.get(from)) return { items: [], waitMs: 5000 };
  if (!items.length) return { items: [], waitMs: 0 };
  if (clientOrigin(from) === "loopback") return { items, waitMs: 0 };
  refill();
  const b = gm.bucket;
  const burst = b.rate * BURST_S;
  const barrier = claimedTier(from, Date.now());
  gm.claims.delete(from);
  const busy = someoneLoading();
  const out = [];
  let waitMs = 0, charged = false;
  for (const it of items) {
    if (it.source === "edge") { out.push(it); continue; }
    let cost = 0, later = false;
    if (it.source !== "peer") {
      if (waitMs) continue;
      const tier = Number(it.tier) || 0;
      if (busy || tier > barrier) { waitMs = BUSY_WAIT_MS; continue; }
      if (!(b.rate > 0)) { waitMs = 10_000; continue; }
      cost = Math.max(MIN_CHARGE_BYTES, Number(it.bytes) || EST_BYTES);
      later = tier >= LATER_TIER;
      // Bytes still missing, at the bucket's rate; the last tier's allowance fills at half of it.
      const short = Math.max(Math.min(cost, burst) - b.tokens, later ? (Math.min(cost, burst / 2) - b.later) * 2 : 0);
      if (short > 0) {
        // The claimant asks again before its claim runs out, so the claim holds until it is served.
        waitMs = Math.min(CLAIM_TTL_MS - 1000, Math.max(250, Math.ceil(short / b.rate * 1000)));
        if (!charged) gm.claims.set(from, { tier, until: Date.now() + CLAIM_TTL_MS });
        continue;
      }
      spend(cost, later ? cost : 0);
      charged = true;
    }
    noteHanded(from, it.src, cost, later);
    out.push(it);
  }
  return { items: out, waitMs: out.length ? 0 : waitMs };
}

function noteHanded(userId, src, cost, later) {
  let handed = gm.handed.get(userId);
  if (!handed) gm.handed.set(userId, handed = new Map());
  handed.delete(src);
  handed.set(src, { cost, later });
  while (handed.size > MAX_HANDED) handed.delete(handed.keys().next().value);
}

/**
 * Coordinator: settle a finished preload batch against what this user was charged for it. A client's numbers are
 * only believed within bounds: a file it was not handed is ignored, each file settles once, and the bytes it says
 * the host uploaded are capped at the largest file preloading accepts. Giving back more than was charged is
 * impossible, and the debt is clamped (see `spend`).
 * @param {{src: string, bytes?: number}[]} results  `bytes`: what the host uploaded for the file (0 from a cache,
 *   a peer or the CDN's edge; the partial bytes of an aborted download)
 * @param {string} from  reporting user id
 */
export function settleBatch(results, from) {
  const handed = gm.handed.get(from);
  if (!handed || !isCoordinator()) return;
  const max = net()?.preloadMaxBytes ?? 0;
  let delta = 0, later = 0;
  for (const r of results) {
    const h = handed.get(r?.src);
    if (!h) continue;
    handed.delete(r.src);
    const actual = Math.min(Math.max(0, Number(r.bytes) || 0), Math.max(h.cost, max));
    delta += actual - h.cost;
    if (h.later) later += actual - h.cost;
  }
  if (!handed.size) gm.handed.delete(from);
  if (!delta) return;
  refill();
  spend(delta, later);
}

function onUserConnected(user, active) {
  if (!isCoordinator() || user.isSelf) return;
  if (active) {
    // Records arrival order only. The joiner is not listening for its turn until `setup` (world data, i18n and
    // time sync come first); it announces itself then, and only announced joiners get the turn.
    if (!user.isGM) enqueueJoin(user.id, { silent: true });
    return;
  }
  forgetClient(user.id);
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
    if (id !== game.user.id && (t - c.at > CLIENT_DROP_MS || !game.users.get(id)?.active)) forgetClient(id);
  }
  refill(); // keeps the rate stepping while nobody asks for a batch
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
