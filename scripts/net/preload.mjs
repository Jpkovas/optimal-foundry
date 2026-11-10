import { MODULE_ID, EXT, warn, log, extOf, isOptimizedPath } from "../constants.mjs";
import { getSetting, setSetting, effectiveNetwork } from "../settings.mjs";
import { getEntry, findByOptimized, normalizePath, willConvert } from "../library.mjs";
import { on, emit, activeGM, isCoordinator, MSG } from "../socket.mjs";
import {
  schedule, waitForPreloadWindow, registerStatusProvider, onClientGone, chargeBatch, settleBatch, clientOrigin,
  LATER_TIER, askCoordinator, tellCoordinator, serveCoordinator, sceneReady, loadInBackground
} from "./scheduler.mjs";
import { initCdnResponder, isLoopbackOrigin } from "./cdn.mjs";
import { cachedOptimizedUrls, swStatus, abortSwPreloads } from "../p2p/sw-client.mjs";
import { holderCount, canSeed } from "../p2p/swarm.mjs";
import { skipByName } from "../media/formats.mjs";
import { collectDocumentReferences } from "../media/references.mjs";

/**
 * Idle-time preloading. The active GM keeps one ordered queue of media paths (tiers below) and remembers per user
 * what was already warmed in this session. A client asks for the next batch when its network is idle; the GM
 * charges up to BATCH items to the host-upload bucket and returns them; the client warms them (at most
 * PARALLEL at once) with plain fetches into the HTTP cache / Service Worker and reports the batch in one message.
 * A GM on the server's own machine (loopback) does not warm anything: loopback fetches save nothing.
 *
 * The queue is automatic: it covers everything players may need, most likely first, and the host-upload budget,
 * P2P and the idle window decide how fast it drains. Marking a scene only moves it to the front.
 *   0 "now": scenes the GM marked, the scene the GM has open when it is not the active one, scenes connected
 *     players are viewing.
 *   1 "probably next": the rest of the active scene (other levels, ambient sounds, its whole playlist), playlists
 *     playing now, the active scene's neighbours in the navigation bar (2 after, 1 before), teleport destinations
 *     in other scenes, the folder neighbours (in the directory's order), and preloadInclude.
 *   2 "this session": every other scene in the navigation bar (nearest first), the rest of the playlists linked to
 *     scenes above, and player characters' art.
 *   3 "later": every other scene (most recently edited first), every other playlist, and the media of journals
 *     players can see.
 * Each scene brings its visuals, its first track and its non-hidden ambient sounds at its own tier; the rest of its
 * playlist one tier later. Visual media matches core's scene load: hidden placeables are included, because core
 * loads them too. Items are the paths the documents reference; the library only supplies the size.
 */

const MAX_ITEMS = 5000;          // queue length
/** Per-user "have" sets (client and GM), larger than the queue: at the cap, a queue change must not evict files
 * still queued and make clients warm the whole queue again. */
const HAVE_MAX = 4 * MAX_ITEMS;
const LIBRARY_REBUILD_MS = 15_000; // a running backfill changes the library every few seconds
const VIEW_CHECK_MS = 3_000;       // players' viewed scenes fire no hook: compared on this beat
const BATCH = 8;
const PARALLEL = 3;
const EMPTY_WAIT_MS = 30_000;
const REBUILD_DEBOUNCE_MS = 1500;
const ASSIGN_TTL_MS = 120_000;   // how long a file stays reserved for the client fetching it from the host first
const ASSIGN_DONE_MS = 5_000;    // ...and once that client reported it: it announces the file within ~1 s of finishing
const RESERVED_WAIT_MS = 2_000;  // only reserved files left: poll again soon
const MISSING_TTL_MS = 600_000;  // a 4xx answer keeps a file out of every batch this long
const HTTP_CACHE_MAX_BYTES = 32 * 1_048_576; // below Chrome-on-Windows (~40 MB) and Firefox (50 MB) entry limits
const FULL_RATIO = 0.8;          // above this share of cacheQuotaMB, ask the GM to skip the last tier
const PRELOAD_HEADER = "X-Optimal-Foundry-Preload"; // marks a preload for the Service Worker, which strips it
const SOURCE_HEADER = "X-Optimal-Foundry-Source";   // set by the Service Worker on what it answers: cache | p2p | net
const EDGE_HIT = /^(HIT|STALE|REVALIDATED)$/i;      // cf-cache-status: the edge answered without downloading from the host
const PLAN_LIMIT = 60;           // plan entries kept for the dashboard
const SCENE_KEYS = ["texture", "ring", "hidden", "path", "background", "foreground", "fog", "playlist",
  "playlistSound", "folder", "sort", "active", "animation", "levels", "tiles", "tokens", "notes", "drawings", "walls",
  "sounds", "name", "regions", "navigation", "navOrder", "ownership"];
/** Documents whose changes can change the queue, with the update keys that matter for each. */
const WATCHED = {
  Scene: SCENE_KEYS, Level: SCENE_KEYS, Tile: SCENE_KEYS, Token: SCENE_KEYS, Note: SCENE_KEYS, Drawing: SCENE_KEYS,
  Wall: SCENE_KEYS, AmbientSound: SCENE_KEYS, Region: ["behaviors"], RegionBehavior: ["system", "disabled", "type"],
  Playlist: ["playing", "playbackOrder", "mode", "seed", "folder", "name", "sounds"],
  PlaylistSound: ["path", "sort"],
  Folder: ["folder", "sort", "sorting", "name"],
  Actor: ["img", "prototypeToken", "ownership"],
  JournalEntry: ["ownership", "pages"],
  JournalEntryPage: ["src", "text", "image", "video", "ownership", "type"],
  User: ["role", "character"]
};
const WATCHED_SETTINGS = new Set(["nextScenes", "preloadInclude", "preloadExclude", "preloadEnabled",
  "preloadMaxFileMB", "networkProfile", "cdnStatus", "mediaEnabled", "backfillMode", "backfillPaused", "welcomeDone", "reviewApproved"]);
const IMAGE_EXT = new Set(EXT.image);

/** Client state. */
const client = {
  started: false,
  disabled: false,
  looping: false,
  have: new Set(),      // paths warmed (or found in the SW cache) during this session
  synced: false,        // the GM holds our `have` set
  active: new Set(),    // paths being warmed right now
  done: 0,
  total: 0,
  paused: false,
  wake: null,           // resolves the current interruptible sleep
  predecoded: null      // scene id already pre-decoded
};

/** GM state. */
const queue = {
  items: [],            // {src, bytes?, tier, kind}
  plan: [],             // {type, id, name, tier, reason, files, bytes}: why things are in the queue (dashboard)
  rank: new Map(),      // referenced path (as the documents hold it) -> position: the backfill converts in this order
  journalRefs: new Map(),// journal id -> media paths (the schema walk is the costly part of a build)
  viewSignature: "",    // players' viewed scenes at the last build
  built: false,
  haveByUser: new Map(),// userId -> Set<src>
  assigned: new Map(),  // src -> {userId, until, share}: the one client fetching it from the host first
  edge: new Set(),      // behind a CDN: files a client pulled through it in this session, so the edge holds them
  missing: new Map(),   // src -> epoch ms of a 4xx answer
  rebuildTimer: null
};

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** Called at `ready` on every client. */
export function initPreload() {
  if (client.started) return;
  client.started = true;
  try {
    initCdnResponder();
    registerStatusProvider(() => ({ preload: { done: client.done, total: client.total } }));
    serveCoordinator(MSG.PRELOAD_NEXT, (payload, from) => gmNext(payload ?? {}, from));
    serveCoordinator(MSG.PRELOAD_DONE, (payload, from) => gmDone(payload ?? {}, from));
    on(MSG.PRELOAD_WAKE, (_payload, from) => { if (from === activeGM()?.id) wakeLoop(); });
    onClientGone(userId => {
      queue.haveByUser.delete(userId);
      for (const [src, a] of queue.assigned) if (a.userId === userId) queue.assigned.delete(src);
    });
    watchWorld();
    if (isCoordinator()) rebuildQueue();
    if (!(game.user.isGM && isLoopbackOrigin())) loop();
  } catch (err) {
    client.disabled = true;
    warn("preload disabled", err);
  }
}

/**
 * Dashboard snapshot. On the GM `queueLength` is the whole queue; on players, what is left for them.
 * `running` is false where the warm loop does not run (a GM on the server's own machine, which still serves the
 * queue). `enabled` is false when the world or this browser (`preloadScope` "off") turned preloading off.
 */
export function preloadStatus() {
  let enabled = false;
  try {
    enabled = deviceOn() && !client.disabled;
  } catch { /* settings not ready */ }
  return {
    enabled,
    running: client.looping,
    queueLength: isCoordinator() ? queue.items.length : Math.max(0, client.total - client.done),
    current: client.active.values().next().value ?? undefined,
    done: client.done,
    total: client.total,
    paused: client.paused
  };
}

/** GM: add or remove a scene from the "next scenes" list that leads the preload queue. */
export async function markNextScene(sceneId, next = true) {
  if (!game.user.isGM) {
    ui.notifications?.warn(game.i18n.localize("OPTIMALFOUNDRY.Preload.GMOnly"));
    return false;
  }
  const stored = getSetting("nextScenes") ?? [];
  const list = stored.filter(id => typeof id === "string" && game.scenes.has(id));
  const i = list.indexOf(sceneId);
  if (next && i < 0 && game.scenes.has(sceneId)) list.push(sceneId);
  else if (!next && i >= 0) list.splice(i, 1);
  if (list.length === stored.length && list.every((id, k) => id === stored[k])) return true;
  await setSetting("nextScenes", list);
  return true;
}

/**
 * Coordinator: the automatic plan for the dashboard: what is queued and why (scenes and playlists in queue order),
 * and files and known bytes per tier. `null` elsewhere.
 */
export function preloadPlan() {
  if (!isCoordinator()) return null;
  const tiers = [0, 1, 2, 3].map(tier => {
    const list = queue.items.filter(it => it.tier === tier);
    return { tier, files: list.length, bytes: list.reduce((n, it) => n + (Number(it.bytes) || 0), 0) };
  });
  return { built: queue.built, plan: queue.plan.slice(0, PLAN_LIMIT), more: Math.max(0, queue.plan.length - PLAN_LIMIT), tiers };
}

/**
 * Coordinator: how much of the "now" and "probably next" media (tiers 0-1) each user warmed in this session, as far
 * as this module knows. `{[userId]: {have, total, bytesLeft}}`; `{}` elsewhere.
 */
export function upcomingReadiness() {
  if (!isCoordinator()) return {};
  const items = queue.items.filter(it => it.tier <= 1);
  const out = {};
  for (const [userId, set] of queue.haveByUser) {
    let have = 0, bytesLeft = 0;
    for (const it of items) {
      if (set.has(it.src)) have++;
      else bytesLeft += Number(it.bytes) || 0;
    }
    out[userId] = { have, total: items.length, bytesLeft };
  }
  return out;
}

/** Coordinator: the preload order as `src -> index` (originals that are not converted yet keep their path). */
export function preloadRank() {
  if (!isCoordinator()) return new Map();
  if (!queue.built) rebuildQueue();
  return queue.rank;
}

/* -------------------------------------------- */
/*  Client loop                                 */
/* -------------------------------------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A sleep that PRELOAD_WAKE (or a local change) cuts short. */
function nap(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); if (client.wake === done) client.wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    client.wake?.();
    client.wake = done;
  });
}

function wakeLoop() {
  client.wake?.();
}

/** The world preloads and this browser takes part (`preloadScope`: "all", "session" without the last tier, "off"). */
const deviceOn = () => !!getSetting("preloadEnabled") && getSetting("preloadScope") !== "off";

async function loop() {
  client.looping = true;
  let failures = 0;
  await seedHave();
  while (!client.disabled) {
    try {
      if (!deviceOn() || !activeGM()) {
        client.paused = true;
        await nap(10_000);
        continue;
      }
      client.paused = true;
      await waitForPreloadWindow();
      client.paused = false;

      const res = await requestNext();
      const items = Array.isArray(res?.items) ? res.items.slice(0, BATCH) : [];
      if (!items.length) {
        failures = 0;
        if (!res?.waitMs || res.waitMs >= EMPTY_WAIT_MS) await maybePredecode();
        await nap(Math.max(250, res?.waitMs ?? EMPTY_WAIT_MS));
        continue;
      }
      const results = await warmBatch(items);
      tellCoordinator(MSG.PRELOAD_DONE, { results });
      // Every item failing on a transient error (tunnel 429/5xx, network) backs off; anything else resets.
      if (results.every(r => r.reason === "error")) throw new Error("every item of the batch failed");
      failures = 0;
    } catch (err) {
      failures++;
      warn("preload step failed", err?.message ?? err);
      if (failures >= 10) {
        warn("preload paused for 5 minutes after repeated failures");
        client.paused = true;
        failures = 0;
        await sleep(300_000);
        continue;
      }
      await sleep(Math.min(60_000, 2000 * failures));
    }
  }
  client.paused = true;
  client.looping = false;
}

async function requestNext() {
  const payload = client.synced ? {} : { have: haveList() };
  // `full` leaves the last tier out: the cache has little room left, or this browser only preloads for the session.
  if (cacheNearlyFull() || getSetting("preloadScope") === "session") payload.full = true;
  let res = await askCoordinator(MSG.PRELOAD_NEXT, payload, 10_000);
  if (res?.needHave) res = await askCoordinator(MSG.PRELOAD_NEXT, { ...payload, have: haveList() }, 10_000);
  client.synced = !res?.needHave;
  if (res && Number.isFinite(res.total)) { client.total = res.total; client.done = Math.min(res.total, res.done ?? 0); }
  return res;
}

function cacheNearlyFull() {
  try {
    const quota = Number(getSetting("cacheQuotaMB")) * 1_048_576;
    return quota > 0 && (Number(swStatus().cachedBytes) || 0) >= FULL_RATIO * quota;
  } catch { return false; }
}

/** Warm a batch, PARALLEL at a time. Items left when this device stops preloading are reported as aborted. */
async function warmBatch(items) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      results[i] = deviceOn()
        ? await warmItem(item)
        : { src: String(item.src), bytes: 0, ok: false, aborted: true };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

/** @returns {Promise<{src, bytes, ok, aborted?, reason?}>}  `bytes`: what the host uploaded for the file (see warm) */
async function warmItem(item) {
  const src = String(item.src);
  const url = new URL(foundry.utils.getRoute(src), window.location.origin).href;
  // The Service Worker keeps every media file it serves in Cache Storage, whatever its size; without it the file
  // lands in the HTTP cache, which drops big entries.
  const limit = effectiveNetwork().preloadMaxBytes;
  const maxBytes = swStatus().controlling ? limit : Math.min(limit, HTTP_CACHE_MAX_BYTES);
  let progress = null;
  client.active.add(src);
  try {
    const r = await schedule(ctx => { progress = ctx.progress; return warm(url, ctx.signal, maxBytes, ctx.progress); },
      { priority: "preload", url });
    if (r.ok || r.reason === "tooLarge") remember(src);
    if (!r.ok && r.reason !== "tooLarge") log(`preload skipped ${src}: ${r.reason}`);
    return { src, bytes: r.bytes, ok: r.ok, reason: r.reason };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    if (!aborted) warn(`preload of ${src} failed`, err?.message ?? err);
    const bytes = progress?.offHost ? 0 : (progress?.received ?? 0);
    return { src, bytes, ok: false, aborted, reason: aborted ? undefined : "error" };
  } finally {
    client.active.delete(src);
  }
}

/**
 * Fetch and drain the body so the HTTP cache and the Service Worker keep the whole file. The request carries
 * PRELOAD_HEADER, which lets the Service Worker fetch it at low priority and abort it when the game needs the link.
 * `bytes` is what the host uploaded for the file as far as this page can tell: nothing when the Service Worker
 * answered from its cache or from a peer (SOURCE_HEADER), or when the CDN's edge already held it.
 * Exported for the tests.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @param {number} [maxBytes]  larger files are not kept: `{ok: false, reason: "tooLarge"}`
 * @param {{total: number, received: number, offHost?: boolean}} [progress]  updated while the body arrives
 * @returns {Promise<{ok: boolean, bytes: number, reason?: string}>}
 */
export async function warm(url, signal, maxBytes, progress) {
  const res = await fetch(url, { signal, credentials: "same-origin", priority: "low", headers: { [PRELOAD_HEADER]: "1" } });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    // Overload (tunnel 429/5xx) is transient: report an error so the file is offered again later.
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} for ${url}`);
    return { ok: false, bytes: 0, reason: `HTTP ${res.status}` };
  }
  const source = res.headers.get(SOURCE_HEADER);
  const offHost = source === "cache" || source === "p2p" || EDGE_HIT.test(res.headers.get("cf-cache-status") ?? "");
  if (progress) progress.offHost = offHost;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(maxBytes) && declared > maxBytes) {
    discard(res.body, url);
    return { ok: false, bytes: 0, reason: "tooLarge" };
  }
  if (progress && declared > 0) progress.total = declared;
  let bytes = 0;
  if (!res.body) bytes = (await res.arrayBuffer()).byteLength;
  else {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (progress) progress.received = bytes;
        if (Number.isFinite(maxBytes) && bytes > maxBytes) {
          await discard(reader, url);
          return { ok: false, bytes: offHost ? 0 : bytes, reason: "tooLarge" };
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  // The Service Worker says where its answer came from; without one, Resource Timing knows what the network moved.
  return { ok: true, bytes: offHost ? 0 : source ? bytes : transferredBytes(url, bytes) };
}

/** Stop reading a file that will not be kept, and the Service Worker's own download of it. */
function discard(stream, url) {
  try { abortSwPreloads([url]); } catch { /* no worker to tell */ }
  return stream?.cancel().catch(() => {});
}

/** Network bytes actually moved (0-ish for cache revalidations), from Resource Timing when available. */
function transferredBytes(url, fallback) {
  try {
    const entries = performance.getEntriesByName(url, "resource");
    const last = entries[entries.length - 1];
    if (last && Number.isFinite(last.transferSize) && (last.transferSize > 0 || last.encodedBodySize > 0)) return last.transferSize;
  } catch { /* fall through */ }
  return fallback || 0;
}

/* -------------------------------------------- */
/*  Pre-decode (stretch, `predecodeNext`)       */
/* -------------------------------------------- */

/** Core's texture memory limits by canvas performance mode (LOW..MAX), minus core's 15% margin. */
const MEMORY_LIMITS = [2, 4, 8, 12].map(gb => gb * 1024 ** 3 * 0.85);

/**
 * Once the predicted next scene (see predictedNextScene) is fully warmed, decode its textures into Foundry's
 * texture cache so the switch skips the decode. One scene at a time, never pinned (core's TTL drops it if unused), skipped on LOW
 * performance mode or when it would push texture memory past 70% of core's limit.
 */
async function maybePredecode() {
  try {
    if (!getSetting("predecodeNext") || !globalThis.canvas?.ready || !sceneReady()) return;
    const mode = canvas.performance?.mode ?? 0;
    if (mode < CONST.CANVAS_PERFORMANCE_MODES.MED) return;
    const scene = predictedNextScene();
    if (!scene || scene.id === canvas.scene?.id || client.predecoded === scene.id) return;
    const srcs = sceneMedia(scene).visual.filter(src => IMAGE_EXT.has(extOf(src)));
    if (!srcs.length || !srcs.every(src => client.have.has(src))) return;
    const TL = foundry.canvas.TextureLoader;
    const estimate = (scene.width || 0) * (scene.height || 0) * 4 * Math.max(1, scene.levels?.size ?? 1);
    const limit = MEMORY_LIMITS[Math.min(mode, MEMORY_LIMITS.length - 1)];
    if ((TL.approximateTotalMemoryUsage ?? 0) + estimate > 0.7 * limit) return;
    client.predecoded = scene.id;
    log(`pre-decoding ${scene.name}`);
    await loadInBackground(srcs);
  } catch (err) {
    warn("pre-decode failed", err);
  }
}

/* -------------------------------------------- */
/*  Local "have" set                            */
/* -------------------------------------------- */

/** The SW's Cache Storage is authoritative for optimized files it serves; everything else starts unknown. */
async function seedHave() {
  if (!globalThis.navigator?.serviceWorker?.controller) return;
  try { for (const p of (await cachedOptimizedUrls()).slice(-HAVE_MAX)) client.have.add(p); }
  catch (err) { warn("could not read the SW cache", err); }
}

function remember(src) {
  client.have.delete(src);
  client.have.add(src);
  while (client.have.size > HAVE_MAX) client.have.delete(client.have.values().next().value);
}

const haveList = () => [...client.have];

/* -------------------------------------------- */
/*  GM: queue                                   */
/* -------------------------------------------- */

function gmNext({ have, full }, from) {
  if (!game.users.get(from)) return { items: [], waitMs: 60_000 };
  if (Array.isArray(have)) {
    const set = new Set();
    for (const s of have.slice(-HAVE_MAX)) if (typeof s === "string") set.add(normalizePath(s));
    queue.haveByUser.set(from, set);
  }
  const set = queue.haveByUser.get(from);
  if (!set) return { needHave: true };
  if (!queue.built) rebuildQueue(); // became coordinator after ready (GM hand-over)
  let enabled = false, n = null;
  try { enabled = !!getSetting("preloadEnabled"); n = effectiveNetwork(); } catch { /* keep disabled */ }
  if (!enabled || !n) return { items: [], waitMs: 60_000, total: 0, done: 0 };

  const t = Date.now();
  // Who uploads each file (see chargeBatch), for a requester whose downloads cross the host's uplink.
  // Behind a CDN the first handout of a file fills the edge from the host: one client gets it, charged, and once it
  // reports the file the edge serves everyone else for free. Only a browser on the public hostname goes through
  // the edge; one on a private address is charged for everything and fills nothing.
  // Without a CDN, with sharing on, one client that can share fetches each eligible file from the host and the
  // other sharers take it from that client through the swarm. A browser that cannot share right now (no local
  // cache, opted out, plain HTTP) neither holds such a reservation nor waits on one.
  const origin = clientOrigin(from);
  const fill = origin === "public" && n.profile === "cdn";
  const sharer = origin !== "loopback" && !!n.p2p && canSeed(from);
  const minP2P = sharer ? (Number(getSetting("p2pMinFileKB")) || 0) * 1024 : 0;
  const picked = [];
  let waiting = false, done = 0, total = 0;
  for (const it of queue.items) {
    if (full && it.tier >= LATER_TIER) continue;
    if (t - (queue.missing.get(it.src) ?? -Infinity) < MISSING_TTL_MS) continue;
    total++;
    if (set.has(it.src)) { done++; continue; }
    if (picked.length >= BATCH) continue;
    const first = fill || (sharer && p2pEligible(it, minP2P)); // one client fetches it from the host first
    let source = "host";
    if (fill && queue.edge.has(it.src)) source = "edge";
    else if (first && !fill && holderCount(it.src, from) > 0) source = "peer";
    else if (first && reservedElsewhere(it.src, from, t)) { waiting = true; continue; }
    picked.push({ src: it.src, bytes: it.bytes, tier: it.tier, kind: it.kind, source, reserve: first && source === "host" });
  }
  // Only files another client is fetching from the host are left: ask again soon and take them from the edge or
  // from that client. A reservation cannot starve anyone: it ends on its TTL, when the fetcher leaves or can no
  // longer share, when its fetch fails, and a few seconds after it succeeds (gmDone).
  if (!picked.length) return { items: [], waitMs: waiting ? RESERVED_WAIT_MS : EMPTY_WAIT_MS, total, done };

  const charged = chargeBatch(picked, from);
  for (const it of charged.items) {
    if (it.reserve) queue.assigned.set(it.src, { userId: from, until: t + ASSIGN_TTL_MS, share: !fill });
  }
  return {
    items: charged.items.map(it => ({ src: it.src, bytes: it.bytes, tier: it.tier, kind: it.kind })),
    waitMs: charged.waitMs,
    total,
    done
  };
}

function p2pEligible(it, minBytes) {
  if (!isOptimizedPath(it.src)) return false;
  const e = findByOptimized(it.src);
  return !!e?.sha256 && (Number(e.bytes) || 0) >= minBytes;
}

/** True while another connected user holds the reservation for this file (and, for sharing, can still share). */
function reservedElsewhere(src, from, t) {
  const a = queue.assigned.get(src);
  if (!a) return false;
  if (t >= a.until || !game.users.get(a.userId)?.active || (a.share && !canSeed(a.userId))) {
    queue.assigned.delete(src);
    return false;
  }
  return a.userId !== from;
}

function gmDone({ results }, from) {
  if (!game.users.get(from) || !Array.isArray(results)) return;
  const set = queue.haveByUser.get(from);
  if (!set) return; // coordinator changed mid-batch: the next PRELOAD_NEXT gets needHave and resyncs the full list
  const t = Date.now();
  const settled = [];
  for (const r of results.slice(0, BATCH)) {
    if (!r || typeof r.src !== "string") continue;
    const src = normalizePath(r.src);
    if (r.ok || r.reason === "tooLarge") {
      set.delete(src);
      set.add(src);
    } else if (/^HTTP 4/.test(String(r.reason ?? ""))) queue.missing.set(src, t);
    const a = queue.assigned.get(src);
    if (a?.userId === from) {
      // Not fetched (failed, aborted, too large): the next client that asks fetches it from the host.
      if (!r.ok) queue.assigned.delete(src);
      // Fetched by a sharer: it announces the file within about a second, then the others take it from there.
      else if (a.share) a.until = Math.min(a.until, t + ASSIGN_DONE_MS);
      // Fetched through the CDN: the edge holds it now.
      else {
        queue.assigned.delete(src);
        queue.edge.add(src);
      }
    }
    settled.push({ src, bytes: r.bytes });
  }
  while (set.size > HAVE_MAX) set.delete(set.values().next().value);
  while (queue.edge.size > HAVE_MAX) queue.edge.delete(queue.edge.values().next().value);
  // Charged at handout with the coordinator's own estimate; settled with what the host really uploaded.
  settleBatch(settled, from);
}

function watchWorld() {
  const queueRebuild = () => {
    if (!isCoordinator()) return;
    clearTimeout(queue.rebuildTimer);
    queue.rebuildTimer = setTimeout(rebuildQueue, REBUILD_DEBOUNCE_MS);
  };
  // A journal's media list is cached; any change to the entry or one of its pages drops it.
  const forgetJournal = doc => queue.journalRefs.delete(doc?.documentName === "JournalEntryPage" ? doc.parent?.id : doc?.id);
  for (const [name, keys] of Object.entries(WATCHED)) {
    const relevant = new Set(keys);
    const journal = (name === "JournalEntry") || (name === "JournalEntryPage");
    Hooks.on(`create${name}`, doc => { if (journal) forgetJournal(doc); queueRebuild(); });
    Hooks.on(`delete${name}`, doc => {
      if (journal) forgetJournal(doc);
      if (name === "Scene") pruneNextScenes(doc.id);
      queueRebuild();
    });
    Hooks.on(`update${name}`, (doc, changes) => {
      if (journal) forgetJournal(doc);
      if (name === "Scene" && changes?.active === true) pruneNextScenes(doc.id);
      if (changes && Object.keys(changes).some(k => relevant.has(k))) queueRebuild();
    });
  }
  Hooks.on("userConnected", queueRebuild);
  // Players switching scenes (User#viewedScene) fire no hook: compare on a beat.
  setInterval(() => { if (isCoordinator() && (viewSignature() !== queue.viewSignature)) queueRebuild(); }, VIEW_CHECK_MS);
  Hooks.on(`${MODULE_ID}.settingChanged`, key => {
    if (WATCHED_SETTINGS.has(key)) queueRebuild();
    if (key === "preloadScope" || key === "preloadEnabled" || key === "nextScenes") wakeLoop();
  });
  Hooks.on(`${MODULE_ID}.coordinatorChanged`, now => { if (now) queueRebuild(); });
  // Every conversion writes the library: rebuild at most every LIBRARY_REBUILD_MS for those.
  let libraryTimer = null;
  Hooks.on(`${MODULE_ID}.libraryChanged`, () => {
    if (!isCoordinator() || libraryTimer) return;
    libraryTimer = setTimeout(() => { libraryTimer = null; queueRebuild(); }, LIBRARY_REBUILD_MS);
  });
  Hooks.on("canvasReady", queueRebuild);
}

async function pruneNextScenes(sceneId) {
  if (!isCoordinator()) return;
  try {
    const list = getSetting("nextScenes") ?? [];
    if (list.includes(sceneId)) await setSetting("nextScenes", list.filter(id => id !== sceneId));
  } catch (err) { warn("could not prune next scenes", err); }
}

/** Paths that cannot or should not be warmed: virtual, inline, remote. */
function localPath(src) {
  if (typeof src !== "string" || !src || src.startsWith("#") || /^(data|blob):/i.test(src)) return null;
  const p = normalizePath(src);
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return null;
  return p;
}

/**
 * Visual and audio media of one scene. Visual media matches core's scene load (every level; hidden placeables
 * included, since core loads them too). Hidden ambient sounds are left out: they do not play.
 */
function sceneMedia(scene) {
  const visual = [], audio = [];
  const add = (arr, src) => { const p = localPath(src); if (p) arr.push(p); };
  for (const lv of scene.levels ?? []) { add(visual, lv.background?.src); add(visual, lv.foreground?.src); add(visual, lv.fog?.src); }
  for (const t of scene.tiles ?? []) add(visual, t.texture?.src);
  for (const t of scene.tokens ?? []) {
    add(visual, t.texture?.src);
    if (t.ring?.enabled) add(visual, t.ring.subject?.texture);
  }
  for (const n of scene.notes ?? []) add(visual, n.texture?.src);
  for (const d of scene.drawings ?? []) add(visual, d.texture);
  for (const w of scene.walls ?? []) add(visual, w.animation?.texture);
  for (const s of scene.sounds ?? []) if (!s.hidden) add(audio, s.path);
  return { visual, audio };
}

function playlistAudio(playlist) {
  if (!playlist) return [];
  const ids = playlist.playbackOrder?.length ? playlist.playbackOrder : playlist.sounds.map(s => s.id);
  return ids.map(id => localPath(playlist.sounds.get(id)?.path)).filter(Boolean);
}

function folderChain(doc) {
  const out = [];
  let f = doc?.folder;
  for (let i = 0; f && i < 32; i++) { out.push(f.uuid); f = f.folder; }
  return out;
}

const matches = (doc, set) => set.has(doc.uuid) || folderChain(doc).some(u => set.has(u));

/** Scenes in the navigation bar, in the bar's order. */
function navigationScenes(scenes) {
  return scenes.filter(s => s.navigation).sort((a, b) => (a.navOrder - b.navOrder) || a.name.localeCompare(b.name));
}

/** 2 after the scene, then 1 before it, in an ordered list. */
function neighbours(scene, ordered) {
  const i = scene ? ordered.indexOf(scene) : -1;
  if (i < 0) return [];
  return [...ordered.slice(i + 1, i + 3), ...ordered.slice(Math.max(0, i - 1), i)];
}

/** The scene's siblings in the Scenes directory, in the order the directory shows them (alphabetical or manual). */
function folderSiblings(scene, scenes) {
  if (!scene) return [];
  const mode = scene.folder ? scene.folder.sorting : (game.scenes?.sortingMode ?? "a");
  return scenes.filter(s => (s.folder?.id ?? null) === (scene.folder?.id ?? null))
    .sort((a, b) => (mode === "m" ? (a.sort - b.sort) : 0) || a.name.localeCompare(b.name, game.i18n?.lang));
}

/** Other scenes the scene's enabled teleport regions lead to. Relative destinations stay in the same scene. */
function teleportTargets(scene) {
  const out = [];
  for (const region of scene?.regions ?? []) {
    for (const behavior of region.behaviors ?? []) {
      if ((behavior.type !== "teleportToken") || behavior.disabled) continue;
      for (const uuid of behavior.system?.destinations ?? []) {
        const id = /^Scene\.([^.]+)\./.exec(String(uuid))?.[1];
        const target = id && (id !== scene.id) ? game.scenes.get(id) : null;
        if (target) out.push(target);
      }
    }
  }
  return out;
}

/**
 * The scene players will most likely see next, on any client: the first marked scene, else the active scene's next
 * neighbour in the navigation bar, else in its folder.
 */
function predictedNextScene() {
  const scenes = [...(game.scenes ?? [])];
  const active = game.scenes?.active ?? null;
  const marked = (getSetting("nextScenes") ?? []).map(id => game.scenes.get(id)).find(s => s && !s.active);
  return marked ?? neighbours(active, navigationScenes(scenes))[0] ?? neighbours(active, folderSiblings(active, scenes))[0] ?? null;
}

/** Which non-active scene each connected player is viewing; a change means tier 0 changed. */
function viewSignature() {
  return [...(game.users ?? [])].filter(u => u.active && !u.isGM).map(u => `${u.id}:${u.viewedScene ?? ""}`).sort().join(",");
}

/** Build the ordered queue and its plan. Coordinator only; cheap enough to rerun on every relevant change (debounced). */
function rebuildQueue() {
  if (!isCoordinator()) return;
  try {
    const { items, plan, rank } = buildQueue(effectiveNetwork().preloadMaxBytes, queue.journalRefs);
    const changed = items.length !== queue.items.length || items.some((it, i) => it.src !== queue.items[i].src);
    queue.items = items;
    queue.plan = plan;
    queue.rank = rank;
    queue.viewSignature = viewSignature();
    queue.built = true;
    Hooks.callAll(`${MODULE_ID}.preloadPlanChanged`);
    if (changed) {
      emit(MSG.PRELOAD_WAKE, {});
      wakeLoop();
    }
  } catch (err) {
    warn("could not build the preload queue", err);
  }
}

/** The queue (see the tiers at the top of this file) and, for the dashboard, why each scene or group is in it. */
export function buildQueue(maxBytes = Infinity, journalRefs = new Map()) {
  const include = new Set(getSetting("preloadInclude") ?? []);
  const exclude = new Set(getSetting("preloadExclude") ?? []);
  const scenes = [...game.scenes];
  const active = game.scenes.active ?? null;
  const players = [...(game.users ?? [])].filter(u => !u.isGM);
  const items = [], plan = [];
  const seen = new Set();
  const rank = new Map();
  const doneScenes = new Set(active ? [active.id] : []);
  const donePlaylists = new Set();
  let linked = [];
  let entry = null;

  const excluded = doc => !!doc && matches(doc, exclude);
  const begin = (type, doc, tier, reason) => {
    entry = { type, id: doc?.id ?? null, name: doc?.name ?? "", tier, reason, files: 0, bytes: 0 };
    plan.push(entry);
  };
  const end = () => { if (entry && !entry.files) plan.pop(); entry = null; };
  const full = () => items.length >= MAX_ITEMS;
  const push = (src, tier) => {
    if (full()) return;
    // The backfill's order: every referenced path, including originals not converted yet (not queued below).
    const raw = localPath(src);
    if (raw && !rank.has(raw)) rank.set(raw, rank.size);
    const resolved = resolveMedia(src);
    if (!resolved || seen.has(resolved.src)) return;
    if (Number.isFinite(maxBytes) && (resolved.bytes > maxBytes)) return;
    seen.add(resolved.src);
    items.push({ ...resolved, tier });
    if (entry) { entry.files++; entry.bytes += resolved.bytes ?? 0; }
  };
  const addPlaylist = (pl, tier, reason) => {
    if (full() || !pl || donePlaylists.has(pl.id) || excluded(pl)) return;
    donePlaylists.add(pl.id);
    begin("playlist", pl, tier, reason);
    for (const src of playlistAudio(pl)) push(src, tier);
    end();
  };
  /** Visuals, first track and non-hidden ambient sounds at the tier; the rest of the playlist goes to `linked`. */
  const addScene = (scene, tier, reason, { force = false } = {}) => {
    if (full() || !scene || doneScenes.has(scene.id) || (!force && excluded(scene))) return;
    doneScenes.add(scene.id);
    begin("scene", scene, tier, reason);
    const { visual, audio } = sceneMedia(scene);
    for (const src of visual) push(src, tier);
    const pl = excluded(scene.playlist) ? null : scene.playlist;
    const first = pl && (scene.playlistSound ?? (pl.playbackOrder?.length ? pl.sounds.get(pl.playbackOrder[0]) : null));
    if (first) push(first.path, tier);
    for (const src of audio) push(src, tier);
    end();
    if (pl) linked.push(pl);
  };
  const flushLinked = tier => {
    const list = linked;
    linked = [];
    for (const pl of list) addPlaylist(pl, tier, "linked");
  };

  // 0 "now". Marked scenes ignore the exclude list: the GM asked for them by name.
  for (const id of getSetting("nextScenes") ?? []) addScene(game.scenes.get(id), 0, "marked", { force: true });
  const prep = globalThis.canvas?.scene;
  if (prep && !prep.active) addScene(prep, 0, "gmViewing");
  for (const user of players) {
    const viewed = user.active ? game.scenes.get(user.viewedScene) : null;
    if (viewed && !viewed.active) addScene(viewed, 0, "playerViewing");
  }

  // 1 "probably next".
  if (active) {
    begin("scene", active, 1, "active");
    const { visual, audio } = sceneMedia(active);
    if ((active.levels?.size ?? 0) > 1) for (const src of visual) push(src, 1);
    for (const src of audio) push(src, 1);
    end();
    addPlaylist(active.playlist, 1, "active");
  }
  for (const pl of game.playlists ?? []) if (pl.playing) addPlaylist(pl, 1, "playing");
  const nav = navigationScenes(scenes);
  for (const scene of neighbours(active, nav)) addScene(scene, 1, "navigation");
  for (const scene of teleportTargets(active)) addScene(scene, 1, "teleport");
  for (const scene of neighbours(active, folderSiblings(active, scenes))) addScene(scene, 1, "folder");
  for (const scene of scenes) if (matches(scene, include)) addScene(scene, 1, "include");
  for (const pl of game.playlists ?? []) if (matches(pl, include)) addPlaylist(pl, 1, "include");
  flushLinked(2);

  // 2 "this session".
  const at = nav.indexOf(active);
  const byDistance = at < 0 ? nav : [...nav].sort((a, b) => Math.abs(nav.indexOf(a) - at) - Math.abs(nav.indexOf(b) - at));
  for (const scene of byDistance) addScene(scene, 2, "navigationBar");
  begin("actors", null, 2, "characters");
  for (const actor of game.actors ?? []) {
    if (full()) break;
    if (!players.some(u => actor.testUserPermission?.(u, "OWNER"))) continue;
    push(actor.img, 2);
    push(actor.prototypeToken?.texture?.src, 2);
  }
  end();
  flushLinked(3);

  // 3 "later".
  const rest = scenes.filter(s => !doneScenes.has(s.id))
    .sort((a, b) => (b._stats?.modifiedTime ?? 0) - (a._stats?.modifiedTime ?? 0));
  for (const scene of rest) addScene(scene, 3, "rest");
  flushLinked(3);
  for (const pl of game.playlists ?? []) addPlaylist(pl, 3, "rest");
  begin("journals", null, 3, "journals");
  for (const journal of game.journal ?? []) {
    if (full()) break;
    if (!players.some(u => journal.testUserPermission?.(u, "OBSERVER"))) continue;
    let srcs = journalRefs.get(journal.id);
    if (!srcs) journalRefs.set(journal.id, srcs = [...collectDocumentReferences(journal).keys()]);
    for (const src of srcs) push(src, 3);
  }
  end();
  return { items, plan, rank };
}

/**
 * What to warm for a referenced path, with size and kind from the library. An original that is converted but not
 * yet rewritten resolves to its optimized copy (what the document is about to reference). An original the backfill
 * has not processed yet resolves to nothing: warming it would spend the host's upload on a file that stops being
 * used seconds later. The library change after conversion rebuilds the queue.
 */
function resolveMedia(src) {
  const p = localPath(src);
  if (!p) return null;
  const sized = (path, bytes, kind) => ({ src: path, bytes: Number(bytes) > 0 ? Number(bytes) : undefined, kind });
  const opt = findByOptimized(p);
  if (opt) return sized(p, opt.bytes, opt.kind);
  const e = getEntry(p);
  if (e?.status === "done" && e.optimized) return sized(normalizePath(e.optimized), e.bytes, e.kind);
  if (!e && awaitingConversion(p)) return null;
  return sized(p, e?.originalBytes, e?.kind);
}

function awaitingConversion(path) {
  return !isOptimizedPath(path) && !skipByName(path) && willConvert(path);
}
