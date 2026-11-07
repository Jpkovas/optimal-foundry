import { MODULE_ID, OUTPUT, warn, log, extOf, isOptimizedPath, sha256Hex } from "../constants.mjs";
import { getSetting, effectiveNetwork } from "../settings.mjs";
import { on, emit, request, activeGM, isCoordinator, MSG } from "../socket.mjs";
import { findByOptimized, normalizePath } from "../library.mjs";
import { isLocalOrigin } from "../net/cdn.mjs";
import { cachedOptimizedUrls, readCached, sendSwConfig } from "./sw-client.mjs";

/**
 * P2P swarm over native RTCPeerConnection + one negotiated DataChannel per peer pair.
 *
 * Tracker: the coordinating GM session keeps, in memory only, which user holds which optimized path (P2P_HAVE)
 * and the throughput every client measured from every seeder (P2P_STATS). P2P_WANT returns holders ranked by
 * that. Clients announce every optimized path they cache; the library, sha256 and size floor are checked only at
 * WANT time (names are content-addressed, so an early or stale holder is never served wrongly). The coordinator
 * pulls full lists with P2P_RESYNC when it starts, when it takes over, and when a user (re)connects.
 * The GM is also a normal peer unless it reaches the server through a local origin (then it only tracks); its own
 * messages go straight to the local tracker (the socket never echoes).
 *
 * Source selection: while the game waits on media (`urgent`), only already-open peers are used, and never behind a
 * caching CDN. Background (preload) fetches may wait for ICE; progress pings keep the SW from timing out meanwhile.
 * At most MAX_DOWNLOADS files download at once. A seeder that answers `busy` is dropped for that file at once on an
 * urgent load; a preload lane backs off and asks again. Pieces no peer delivered come from the host by one Range.
 * Endgame: an idle lane duplicates the oldest piece in flight from a single peer; the first copy wins.
 *
 * Signaling: P2P_SIGNAL with the "perfect negotiation" pattern; polite side = lower userId.
 * Every message carries the sender's session id (`<page epoch>:<counter>`) so a reload or a reconnect
 * replaces the old connection instead of mixing candidates from two sessions.
 *
 * Wire format on the DataChannel:
 *   text   JSON control {op: "req"|"end"|"err"|"cancel"|"ping"|"pong", ...}
 *   binary [rid u32][offset-in-piece u32][bytes], at most min(sctp.maxMessageSize, 64 KiB) per message.
 *
 * Status fields: `up`/`down` are cumulative bytes this page load; P2P_STATS sends {up, down, peers: <open count>,
 * rates: {[userId]: bytesPerSec}}.
 */

const PIECE = 1_048_576;
const HEADER = 8;
const MAX_FETCH_PEERS = 3;
const LANES_PER_PEER = 2;
const ICE_TIMEOUT_MS = 10_000; // first mDNS resolution can take several seconds
const DISCONNECT_GRACE_MS = 5000;
const MAX_UPLOADS = 3;
const MAX_PEERS = 12;
const BAN_STRIKES = 3;
const FAIL_COOLDOWN_MS = 60_000;
const IDLE_CLOSE_MS = 120_000;
const TICK_MS = 5000;
const PING_MS = 10_000;
const WANT_TIMEOUT_MS = 5000;
const MAX_P2P_BYTES = 768 * 1_048_576; // whole file is assembled in memory for the SHA-256 check
const BUFFER_HIGH = 4 * 1_048_576;
const BUFFER_LOW = 1_048_576;
const DEFAULT_RATE = 262_144;          // assumed bytes/s for a peer never measured
const EWMA_ALPHA = 0.3;
const MAX_LIST = 20_000;
const MAX_DOWNLOADS = 2;               // concurrent files per page; further misses go to the network at once
const MAX_REPORTED_RATE = 100 * 1_048_576;
const CONNECT_PING_MS = 2000;
const STEAL_AFTER_MS = 2000;           // endgame duplicates only pieces in flight at least this long
const BUSY_RETRIES = 6;                // preload: how often a lane re-asks a seeder at its upload cap
const BUSY_BACKOFF_MS = 400;           // ...waiting this long times the attempt number (about 8 s in all)
const DEBUG_ALLOW_LOCAL = `${MODULE_ID}.debug.allowLocalP2P`;

const S = { enabled: false, reason: undefined, up: 0, down: 0, servedFiles: 0, fetchedFiles: 0, failures: 0, lastFailure: null };
const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let sessionCounter = 0;
let initialized = false;
let tickTimer = null;
let iceServers = null;

const peers = new Map();     // userId -> Peer
const rates = new Map();     // userId -> EWMA bytes/s measured downloading from that peer
const strikes = new Map();   // userId -> strike count
const banned = new Set();
const cooldown = new Map();  // userId -> epoch ms until which we do not dial it
const fetching = new Map();  // path -> Promise<Blob|null>
const seedBlobs = new Map(); // path -> Blob (small LRU for seeding)
let activeUploads = 0;
const bucket = { tokens: 0, last: 0 };
let lastStatsKey = "";

const pendingAdd = new Set();
const pendingDrop = new Set();
let announceTimer = null;
let resyncTimer = null;

// GM tracker state (memory only)
const holders = new Map();   // path -> Set<userId>
const byUser = new Map();    // userId -> Set<path>
const reports = new Map();   // reporterId -> {[seederId]: bytesPerSec}
const clientStats = new Map(); // userId -> {up, down, peers, at}

/* ---------------------------------------- Public API ---------------------------------------- */

export function initSwarm() {
  if (initialized) return;
  initialized = true;
  try {
    on(MSG.P2P_HAVE, (payload, from) => { if (isCoordinator()) trackerHave(from, payload); });
    // A passive session returns undefined: no reply, so it cannot race the coordinator's answer.
    on(MSG.P2P_WANT, (payload, from) => isCoordinator() ? trackerWant(from, payload) : undefined);
    on(MSG.P2P_STATS, (payload, from) => { if (isCoordinator()) trackerStats(from, payload); });
    on(MSG.P2P_SIGNAL, (payload, from) => onSignal(payload, from));
    on(MSG.P2P_RESYNC, (_payload, from) => {
      if (from !== activeGM()?.id) return;
      lastStatsKey = "";
      scheduleResync(500 + Math.random() * 2500); // jitter: N clients must not all send their lists at once
    });
    Hooks.on("userConnected", onUserConnected);
    Hooks.on(`${MODULE_ID}.coordinatorChanged`, onCoordinatorChanged);
    Hooks.on(`${MODULE_ID}.settingChanged`, key => {
      if (key === "p2pParticipate") getSetting("p2pParticipate") ? enable() : disable("optOut");
      else if (key === "iceServers") iceServers = null;
    });
    tickTimer = setInterval(tick, TICK_MS);
    if (getSetting("p2pParticipate")) enable();
    else disable("optOut");
    if (isCoordinator()) emit(MSG.P2P_RESYNC, {});
  } catch (err) {
    disable("error");
    warn("P2P swarm disabled", err);
  }
}

export function swarmStatus() {
  const status = {
    enabled: S.enabled,
    reason: S.reason,
    peers: [...peers.values()].map(p => ({
      userId: p.userId,
      name: game.users?.get(p.userId)?.name ?? p.userId,
      state: p.state,
      rttMs: p.rttMs,
      upBytes: p.upBytes,
      downBytes: p.downBytes,
      bytesPerSec: rates.get(p.userId) ?? null
    })),
    up: S.up,
    down: S.down,
    servedFiles: S.servedFiles,
    fetchedFiles: S.fetchedFiles,
    failures: S.failures,
    lastFailure: S.lastFailure,
    banned: [...banned]
  };
  if (isCoordinator()) {
    status.tracker = {
      files: holders.size,
      clients: Object.fromEntries([...new Set([...byUser.keys(), ...clientStats.keys()])].map(id => [id, {
        name: game.users?.get(id)?.name ?? id,
        files: byUser.get(id)?.size ?? 0,
        ...(clientStats.get(id) ?? {})
      }]))
    };
  }
  return status;
}

/**
 * Fetch a whole optimized file from peers and verify it against the library SHA-256.
 * Resolves null whenever P2P cannot deliver a verified copy (the caller falls back to the network).
 * @param {string} url  Path or same-origin URL of an optimized file
 * @param {{signal?: AbortSignal, onProgress?: () => void, urgent?: boolean}} [options]
 *   urgent: the game is waiting for this file; use only peers that are already connected, never wait for ICE.
 */
export function fetchFromPeers(url, { signal, onProgress, urgent = false } = {}) {
  if (!S.enabled) return Promise.resolve(null);
  const path = normalizePath(url);
  if (!path || !isOptimizedPath(path)) return Promise.resolve(null);
  const running = fetching.get(path);
  if (running) return running;
  if (fetching.size >= MAX_DOWNLOADS) return Promise.resolve(null);
  const p = download(path, signal, onProgress, urgent)
    .catch(err => { warn("P2P download failed", path, err); return null; })
    .finally(() => fetching.delete(path));
  fetching.set(path, p);
  return p;
}

/**
 * Coordinator only: how many active users other than `excludeId` announced `path`. 0 elsewhere.
 * @param {string} path
 * @param {string} [excludeId]
 */
export function holderCount(path, excludeId) {
  if (!isCoordinator()) return 0;
  let n = 0;
  for (const id of holders.get(normalizePath(path)) ?? []) if (id !== excludeId && game.users.get(id)?.active) n++;
  return n;
}

/** Called by sw-client when files land in Cache Storage. Accepts URLs or paths. */
export function noteCached(urls) {
  if (!S.enabled) return;
  for (const u of urls) {
    const p = normalizePath(u);
    if (!isOptimizedPath(p)) continue;
    pendingDrop.delete(p);
    pendingAdd.add(p);
  }
  scheduleAnnounce();
}

/** Called by sw-client when files are evicted from Cache Storage. */
export function noteEvicted(urls) {
  for (const u of urls) {
    const p = normalizePath(u);
    seedBlobs.delete(p);
    if (!S.enabled) continue;
    pendingAdd.delete(p);
    pendingDrop.add(p);
  }
  scheduleAnnounce();
}

/* ---------------------------------------- Enable / disable ---------------------------------------- */

/** Test override for local-origin clients (several players on one machine): localStorage key = "1". */
function allowLocal() {
  try { return globalThis.localStorage?.getItem(DEBUG_ALLOW_LOCAL) === "1"; } catch { return false; }
}

function enable() {
  // A client on a local origin (usually the GM on the host) shares the server's uplink: never seed or fetch.
  const missing = isLocalOrigin() && !allowLocal() ? "local"
    : !window.isSecureContext ? "insecure"
    : typeof RTCPeerConnection !== "function" ? "noWebRTC"
    : !globalThis.crypto?.subtle ? "noCrypto"
    : !("caches" in globalThis) ? "noCache" : null;
  if (missing) return disable(missing);
  S.enabled = true;
  S.reason = undefined;
  scheduleResync(1000);
  sendSwConfig();
}

function disable(reason) {
  const was = S.enabled;
  S.enabled = false;
  S.reason = reason;
  for (const peer of [...peers.values()]) peer.close(true);
  pendingAdd.clear();
  pendingDrop.clear();
  if (was) announce({ add: [], drop: [], reset: true });
  sendSwConfig();
}

/* ---------------------------------------- Announcements ---------------------------------------- */

const minBytes = () => (Number(getSetting("p2pMinFileKB")) || 0) * 1024;

function announce(msg) {
  if (isCoordinator()) return trackerHave(game.user.id, msg);
  const gm = activeGM();
  if (gm) emit(MSG.P2P_HAVE, msg, gm.id);
}

function scheduleAnnounce() {
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    if (!pendingAdd.size && !pendingDrop.size) return;
    const msg = { add: [...pendingAdd].slice(0, MAX_LIST), drop: [...pendingDrop].slice(0, MAX_LIST) };
    pendingAdd.clear();
    pendingDrop.clear();
    announce(msg);
  }, 1000);
}

function scheduleResync(delay) {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(resync, delay);
}

async function resync() {
  if (!S.enabled) return;
  try {
    const paths = await cachedOptimizedUrls();
    announce({ add: paths.slice(0, MAX_LIST), drop: [], reset: true });
  } catch (err) {
    warn("P2P announce failed", err);
  }
}

/* ---------------------------------------- GM tracker ---------------------------------------- */

const strList = v => Array.isArray(v) ? v.filter(s => typeof s === "string").slice(0, MAX_LIST) : [];

function trackerHave(userId, payload) {
  if (!userId || !payload || typeof payload !== "object") return;
  let set = byUser.get(userId);
  if (payload.reset && set) {
    for (const p of set) dropHolder(p, userId);
    set.clear();
  }
  if (!set) byUser.set(userId, set = new Set());
  for (const raw of strList(payload.drop)) {
    const p = normalizePath(raw);
    set.delete(p);
    dropHolder(p, userId);
  }
  for (const raw of strList(payload.add)) {
    const p = normalizePath(raw);
    if (!isOptimizedPath(p)) continue;
    set.add(p);
    if (!holders.has(p)) holders.set(p, new Set());
    holders.get(p).add(userId);
  }
}

function dropHolder(path, userId) {
  const h = holders.get(path);
  if (!h) return;
  h.delete(userId);
  if (!h.size) holders.delete(path);
}

function trackerForget(userId) {
  const set = byUser.get(userId);
  if (set) for (const p of set) dropHolder(p, userId);
  byUser.delete(userId);
  reports.delete(userId);
  clientStats.delete(userId);
}

function trackerWant(userId, payload) {
  const path = normalizePath(payload?.url);
  const e = findByOptimized(path);
  if (!e?.sha256 || !(e.bytes >= minBytes())) return { peers: [], sha256: null, bytes: 0 };
  const ids = [...(holders.get(path) ?? [])].filter(id => id !== userId && game.users.get(id)?.active);
  const score = new Map(ids.map(id => [id, seederScore(userId, id)]));
  ids.sort((a, b) => score.get(b) - score.get(a));
  return { peers: ids.slice(0, 8), sha256: e.sha256, bytes: e.bytes };
}

/** The requester's own measurement of a seeder wins; otherwise the mean of everyone's reports. */
function seederScore(requester, seeder) {
  const own = reports.get(requester)?.[seeder];
  if (own > 0) return own;
  let sum = 0, n = 0;
  for (const r of reports.values()) if (r[seeder] > 0) { sum += r[seeder]; n++; }
  return n ? sum / n : DEFAULT_RATE;
}

function trackerStats(userId, payload) {
  if (!userId || !payload || typeof payload !== "object") return;
  const r = {};
  if (payload.rates && typeof payload.rates === "object") {
    for (const [id, v] of Object.entries(payload.rates)) {
      if (id !== userId && Number.isFinite(v) && v > 0) r[id] = Math.min(v, MAX_REPORTED_RATE);
    }
  }
  reports.set(userId, r);
  clientStats.set(userId, {
    up: Number(payload.up) || 0,
    down: Number(payload.down) || 0,
    peers: Number(payload.peers) || 0,
    at: Date.now()
  });
}

function onUserConnected(user, connected) {
  if (!user || user.id === game.user.id) return;
  if (!connected) {
    peers.get(user.id)?.close(false);
    cooldown.delete(user.id);
    if (isCoordinator()) trackerForget(user.id);
    return;
  }
  // A socket that reconnects without a reload never re-announces by itself: ask it. (A reloading client's
  // message is dropped before its ready, which is fine: its own enable() resyncs.)
  if (isCoordinator()) emit(MSG.P2P_RESYNC, {}, user.id);
}

/** A session that takes over starts with an empty tracker and pulls every list; one that hands over drops its own. */
function onCoordinatorChanged(now) {
  if (!now) {
    holders.clear();
    byUser.clear();
    reports.clear();
    clientStats.clear();
    return;
  }
  lastStatsKey = "";
  scheduleResync(500);
  emit(MSG.P2P_RESYNC, {});
}

/* ---------------------------------------- Periodic work ---------------------------------------- */

function tick() {
  try {
    const now = Date.now();
    for (const peer of [...peers.values()]) {
      if (peer.state === "open" && !peer.requests.size && !peer.uploads.size && now - peer.lastUsed > IDLE_CLOSE_MS) peer.close(true);
    }
    reportStats();
  } catch (err) {
    warn("P2P tick failed", err);
  }
}

function reportStats() {
  if (!S.enabled && !S.up && !S.down) return;
  const open = [...peers.values()].filter(p => p.state === "open").length;
  const payload = { up: S.up, down: S.down, peers: open, rates: Object.fromEntries(rates) };
  const key = JSON.stringify(payload);
  if (key === lastStatsKey) return;
  lastStatsKey = key;
  if (isCoordinator()) return trackerStats(game.user.id, payload);
  const gm = activeGM();
  if (gm) emit(MSG.P2P_STATS, payload, gm.id);
}

/* ---------------------------------------- Download ---------------------------------------- */

async function want(path) {
  if (isCoordinator()) return trackerWant(game.user.id, { url: path });
  const gm = activeGM();
  if (!gm) return null;
  try { return await request(MSG.P2P_WANT, { url: path }, gm.id, WANT_TIMEOUT_MS); }
  catch { return null; }
}

async function download(path, signal, onProgress, urgent) {
  const entry = findByOptimized(path);
  if (!entry?.sha256 || !(entry.bytes >= minBytes()) || entry.bytes > MAX_P2P_BYTES) return null;
  if (signal?.aborted) return null;
  const isOpen = id => peers.get(id)?.state === "open";
  if (urgent) {
    // The edge serves faster than a peer; and with no open link, any P2P attempt only adds latency.
    if (effectiveNetwork().profile === "cdn") return null;
    if (![...peers.values()].some(p => p.state === "open")) return null;
  }
  const info = await want(path);
  if (!info?.peers?.length || (info.sha256 && info.sha256 !== entry.sha256) || (info.bytes && info.bytes !== entry.bytes)) return null;
  const now = Date.now();
  let candidates = info.peers.filter(id => typeof id === "string" && id !== game.user.id && !banned.has(id)
    && !((cooldown.get(id) ?? 0) > now) && game.users.get(id)?.active);
  if (urgent) {
    // Warm links to the best other holders for later requests, without waiting for them now.
    for (const id of candidates.filter(id => !isOpen(id)).slice(0, MAX_FETCH_PEERS)) connect(id).catch(() => {});
    candidates = candidates.filter(isOpen);
  }
  if (!candidates.length) return null;

  const dl = new Download(path, entry.bytes, signal, onProgress, urgent);
  dl.progress();
  const workers = new Map(); // promise -> userId
  const launch = () => {
    while (workers.size < MAX_FETCH_PEERS && candidates.length && !dl.finished && !dl.aborted) {
      const userId = candidates.shift();
      const w = connect(userId)
        .then(peer => work(dl, peer))
        .catch(() => {})
        .finally(() => { workers.delete(w); dl.pulse(); });
      workers.set(w, userId);
    }
  };
  while (!dl.finished && !dl.aborted) {
    launch();
    if (!workers.size) break;
    await Promise.race([...workers.keys(), dl.changed(), sleep(CONNECT_PING_MS)]);
    // A legitimate ICE handshake can take up to ICE_TIMEOUT_MS: keep the SW's inactivity timer from firing.
    if ([...workers.values()].some(id => peers.get(id)?.state === "connecting")) dl.progress();
  }
  // Peers ran out with part of the file delivered: take only the rest from the host instead of all of it again.
  if (!dl.finished && !dl.aborted && dl.doneCount > 0) await fillFromHost(dl).catch(() => {});
  dl.close();
  if (!dl.finished || dl.aborted) return null;

  const hash = await sha256Hex(dl.buf);
  if (hash !== String(entry.sha256).toLowerCase()) {
    S.failures++;
    // Only a lone contributor is provably the culprit; with several, striking all would ban honest seeders.
    if (dl.contributors.size === 1) {
      const [id] = dl.contributors;
      warn(`P2P hash mismatch for ${path}; striking ${id}`);
      strike(id);
    } else warn(`P2P hash mismatch for ${path} from ${[...dl.contributors].join(", ")}; nobody struck`);
    return null;
  }
  S.fetchedFiles++;
  return new Blob([dl.buf], { type: mimeOf(path) });
}

class Download {
  constructor(path, size, signal, onProgress, urgent = false) {
    this.path = path;
    this.urgent = urgent;
    this.size = size;
    this.signal = signal;
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.buf = new Uint8Array(size);
    this.nPieces = Math.ceil(size / PIECE);
    this.queue = Array.from({ length: this.nPieces }, (_, i) => i);
    this.done = new Uint8Array(this.nPieces);
    this.doneCount = 0;
    this.contributors = new Set(); // every peer that wrote bytes into buf
    this.inflight = new Map();     // piece -> [{userId, t0, ctl}]
    this.aborted = !!signal?.aborted;
    this._wake = null;
    this._changed = null;
    this._onAbort = () => { this.aborted = true; this.pulse(); };
    signal?.addEventListener("abort", this._onAbort, { once: true });
  }
  get finished() { return this.doneCount === this.nPieces; }
  take() { return this.queue.shift(); }
  /** Endgame: the oldest in-flight piece (older than STEAL_AFTER_MS) that only one other peer is fetching. */
  steal(userId) {
    let best, bestT = performance.now() - STEAL_AFTER_MS;
    for (const [i, list] of this.inflight) {
      if (this.done[i] || list.length !== 1 || list[0].userId === userId) continue;
      if (list[0].t0 < bestT) { best = i; bestT = list[0].t0; }
    }
    return best;
  }
  track(i, req) {
    const list = this.inflight.get(i);
    if (list) list.push(req);
    else this.inflight.set(i, [req]);
  }
  untrack(i, req) {
    const list = this.inflight.get(i)?.filter(r => r !== req) ?? [];
    if (list.length) this.inflight.set(i, list);
    else this.inflight.delete(i);
  }
  /** Back to the queue, unless another request for the same piece is still running. */
  giveBack(i) {
    if (this.done[i] || this.inflight.has(i)) return;
    this.queue.unshift(i);
    this.pulse();
  }
  wrote(userId) {
    this.contributors.add(userId);
    this.progress();
  }
  complete(i, userId) {
    if (!this.done[i]) { this.done[i] = 1; this.doneCount++; }
    for (const r of this.inflight.get(i) ?? []) if (r.userId !== userId) r.ctl.abort();
    this.progress();
    this.pulse();
  }
  progress() { try { this.onProgress?.(); } catch {} }
  changed() { return this._changed ??= new Promise(resolve => { this._wake = resolve; }); }
  pulse() { const wake = this._wake; this._wake = null; this._changed = null; wake?.(); }
  close() { this.signal?.removeEventListener("abort", this._onAbort); this.pulse(); }
}

/** Pull pieces from one peer with a few lanes in flight until the file is done or the peer misbehaves. */
async function work(dl, peer) {
  let errors = 0, lastCode = null, refused = false, busy = 0;
  const lane = async () => {
    while (!dl.finished && !dl.aborted && !refused && peer.state === "open" && errors < 2) {
      const idx = dl.take() ?? dl.steal(peer.userId);
      if (idx === undefined) {
        await Promise.race([dl.changed(), sleep(1000)]);
        continue;
      }
      const start = idx * PIECE;
      const end = Math.min(dl.size, start + PIECE);
      const req = { userId: peer.userId, t0: performance.now(), ctl: new AbortController() };
      dl.track(idx, req);
      const signal = dl.signal ? AbortSignal.any([dl.signal, req.ctl.signal]) : req.ctl.signal;
      try {
        await peer.fetchRange(dl.path, start, end, dl.buf, signal, pieceTimeout(peer.userId, end - start), () => dl.wrote(peer.userId));
        dl.untrack(idx, req);
        measure(peer.userId, (end - start) / Math.max(0.001, (performance.now() - req.t0) / 1000));
        dl.complete(idx, peer.userId);
        errors = 0;
        busy = 0;
      } catch (err) {
        dl.untrack(idx, req);
        if (dl.done[idx]) continue; // another peer delivered this piece first (endgame); not this peer's fault
        dl.giveBack(idx);
        const code = err?.code;
        if (code === "aborted" || code === "closed") return;
        if (code === "busy") {
          // Urgent: try the next holder now. Preload: the seeder's cap frees within a piece time, and giving up
          // here would throw away the pieces this peer already delivered.
          if (dl.urgent || ++busy > BUSY_RETRIES) { refused = true; dl.pulse(); return; }
          dl.progress(); // keep the SW's inactivity timer from firing while we wait
          await sleep(BUSY_BACKOFF_MS * busy);
          continue;
        }
        if (code === "missing") { errors = 2; lastCode = code; continue; }
        // A silent peer gets a (low) measurement of our own, so it drops to the bottom of our ranking.
        if (code === "timeout") measure(peer.userId, (end - start) / Math.max(0.001, (performance.now() - req.t0) / 1000));
        errors++;
        lastCode = code;
        S.failures++;
      }
    }
  };
  peer.lastUsed = Date.now();
  await Promise.all(Array.from({ length: LANES_PER_PEER }, lane));
  peer.lastUsed = Date.now();
  // Gave up on timeouts or protocol errors: do not pick this peer again for a while (not a strike).
  if (errors >= 2 && lastCode && lastCode !== "missing") cooldown.set(peer.userId, Date.now() + FAIL_COOLDOWN_MS);
}

/**
 * One Range request to the host for the span of pieces no peer delivered. Pieces inside the span that peers did
 * deliver are overwritten with the host's identical bytes; the caller still checks the whole file's SHA-256.
 */
async function fillFromHost(dl) {
  let first = -1, last = -1;
  for (let i = 0; i < dl.nPieces; i++) if (!dl.done[i]) { if (first < 0) first = i; last = i; }
  if (first < 0) return;
  const start = first * PIECE;
  const end = Math.min(dl.size, (last + 1) * PIECE);
  const url = new URL(foundry.utils.getRoute(dl.path), window.location.origin);
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: dl.signal, credentials: "same-origin" });
  if (res.status !== 206) { res.body?.cancel().catch(() => {}); return; }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== end - start || dl.aborted) return;
  dl.buf.set(bytes, start);
  for (let i = first; i <= last; i++) if (!dl.done[i]) { dl.done[i] = 1; dl.doneCount++; }
  dl.contributors.add("host"); // a mismatch then has two sources, so no peer is struck on the host's account
  dl.progress();
}

function pieceTimeout(userId, bytes) {
  const expected = bytes / (rates.get(userId) || DEFAULT_RATE) * 1000;
  return Math.min(60_000, Math.max(3000, 4 * expected));
}

function measure(userId, bps) {
  const prev = rates.get(userId);
  rates.set(userId, prev ? prev + EWMA_ALPHA * (bps - prev) : bps);
}

function strike(userId) {
  const n = (strikes.get(userId) ?? 0) + 1;
  strikes.set(userId, n);
  if (n >= BAN_STRIKES && !banned.has(userId)) {
    banned.add(userId);
    peers.get(userId)?.close(true);
    warn(`P2P peer ${game.users.get(userId)?.name ?? userId} banned for this session after ${n} bad files`);
  }
}

/* ---------------------------------------- Seeding ---------------------------------------- */

async function seedBlob(path) {
  if (seedBlobs.has(path)) {
    const b = seedBlobs.get(path);
    seedBlobs.delete(path);
    seedBlobs.set(path, b);
    return b;
  }
  const blob = await readCached(path);
  if (!blob) return null;
  seedBlobs.set(path, blob);
  while (seedBlobs.size > 4) seedBlobs.delete(seedBlobs.keys().next().value);
  return blob;
}

const canvasLoading = () => !!globalThis.canvas?.loading;

/** Per-client upload cap shared by every upload (token bucket, 1 s burst). */
async function takeTokens(n) {
  const rate = Math.max(0.25, Number(getSetting("p2pUploadCapMBps")) || 2) * 1_000_000;
  const burst = Math.max(rate, n);
  for (;;) {
    const now = performance.now();
    bucket.tokens = Math.min(burst, bucket.tokens + (now - (bucket.last || now)) / 1000 * rate);
    bucket.last = now;
    if (bucket.tokens >= n) { bucket.tokens -= n; return; }
    await sleep(Math.max(5, Math.ceil((n - bucket.tokens) / rate * 1000)));
  }
}

/* ---------------------------------------- Peer connections ---------------------------------------- */

function connect(userId) {
  const existing = peers.get(userId);
  if (existing && (existing.state === "open" || existing.state === "connecting")) return existing.opened;
  if (!S.enabled) return Promise.reject(new Error("disabled"));
  makeRoom();
  const peer = new Peer(userId);
  peers.set(userId, peer);
  return peer.opened;
}

function makeRoom() {
  if (peers.size < MAX_PEERS) return;
  const idle = [...peers.values()].filter(p => !p.requests.size && !p.uploads.size).sort((a, b) => a.lastUsed - b.lastUsed)[0];
  idle?.close(true);
}

function getIceServers() {
  if (iceServers) return iceServers;
  iceServers = parseIceServers(getSetting("iceServers"));
  try { new RTCPeerConnection({ iceServers }).close(); }
  catch (err) { warn("invalid iceServers setting, using none", err); iceServers = []; }
  return iceServers;
}

/** "stun:host:port, turn:user:pass@host:port?transport=udp" -> RTCIceServer[] (percent-encode @ or : in credentials). */
function parseIceServers(value) {
  const out = [];
  for (const raw of String(value ?? "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(stuns?|turns?):(?:([^@]*)@)?(.+)$/i.exec(s);
    if (!m) { warn("ignoring ICE server", s); continue; }
    const scheme = m[1].toLowerCase();
    const server = { urls: `${scheme}:${m[3]}` };
    if (m[2] && scheme.startsWith("turn")) {
      const i = m[2].indexOf(":");
      const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
      server.username = dec(i < 0 ? m[2] : m[2].slice(0, i));
      server.credential = dec(i < 0 ? "" : m[2].slice(i + 1));
    }
    out.push(server);
  }
  return out;
}

async function onSignal(payload, from) {
  if (!S.enabled || !from || from === game.user.id || banned.has(from)) return;
  if (!payload || typeof payload !== "object" || typeof payload.sid !== "string") return;
  let peer = peers.get(from);
  if (payload.bye) {
    if (peer && peer.remoteSid === payload.sid) peer.close(false);
    return;
  }
  const isOffer = payload.description?.type === "offer";
  if (peer && peer.remoteSid && peer.remoteSid !== payload.sid) {
    if (!isOffer) return; // late message from a session that no longer exists
    peer.close(false);    // the remote started over (reload or reconnect)
    peer = null;
  }
  if (!peer) {
    if (!isOffer) return;
    makeRoom();
    peer = new Peer(from);
    peers.set(from, peer);
  }
  peer.remoteSid ??= payload.sid;
  peer.handleSignal(payload);
}

class Peer {
  constructor(userId) {
    this.userId = userId;
    this.polite = game.user.id < userId;
    this.sid = `${epoch}:${++sessionCounter}`;
    this.remoteSid = null;
    this.state = "connecting";
    this.rttMs = null;
    this.upBytes = 0;
    this.downBytes = 0;
    this.lastUsed = Date.now();
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.nextRid = 0;
    this.requests = new Map(); // rid -> pending download of one range
    this.uploads = new Map();  // rid -> {cancelled}
    this.lowWaiters = [];
    this.ice = { local: new Set(), remote: new Set() }; // candidate types seen, for failure diagnostics
    this.signalChain = Promise.resolve();
    this.byeSent = false;
    this.opened = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.opened.catch(() => {});
    this.connectTimer = setTimeout(() => this.fail("iceTimeout"), ICE_TIMEOUT_MS);
    this.disconnectTimer = null;
    this.pingTimer = null;

    try {
      this.pc = new RTCPeerConnection({ iceServers: getIceServers() });
      this.dc = this.pc.createDataChannel("optimal-foundry", { negotiated: true, id: 0, ordered: true });
    } catch (err) {
      warn("cannot create peer connection", err);
      this.pc = null;
      queueMicrotask(() => this.fail("error"));
      return;
    }
    this.dc.binaryType = "arraybuffer";
    this.dc.bufferedAmountLowThreshold = BUFFER_LOW;

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.signal({ description: this.pc.localDescription.toJSON() });
      } catch (err) {
        if (this.state === "connecting" || this.state === "open") warn("P2P offer failed", err);
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (candidate.candidate) this.ice.local.add(candidateType(candidate.candidate));
      this.signal({ candidate: candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc?.connectionState;
      if (st === "failed" || st === "closed") this.fail(st);
      else if (st === "disconnected") {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => { if (this.pc?.connectionState === "disconnected") this.fail("disconnected"); }, DISCONNECT_GRACE_MS);
      } else if (st === "connected") clearTimeout(this.disconnectTimer);
    };
    this.dc.onopen = () => {
      clearTimeout(this.connectTimer);
      this.state = "open";
      this.lastUsed = Date.now();
      this.pingTimer = setInterval(() => this.send({ op: "ping", t: performance.now() }), PING_MS);
      this.send({ op: "ping", t: performance.now() });
      this._resolve(this);
    };
    this.dc.onclose = () => this.fail("closed");
    this.dc.onbufferedamountlow = () => this.wakeWriters();
    this.dc.onmessage = ({ data }) => {
      try {
        if (typeof data === "string") this.onControl(JSON.parse(data));
        else if (data instanceof ArrayBuffer) this.onChunk(data);
      } catch (err) {
        warn("P2P message rejected", err);
      }
    };
  }

  signal(data) {
    emit(MSG.P2P_SIGNAL, { sid: this.sid, ...data }, this.userId);
  }

  /** Perfect negotiation; messages are processed strictly in arrival order. */
  handleSignal({ description, candidate }) {
    this.signalChain = this.signalChain.then(async () => {
      const pc = this.pc;
      if (!pc || this.state === "closed" || this.state === "failed") return;
      try {
        if (description) {
          const collision = description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
          this.ignoreOffer = !this.polite && collision;
          if (this.ignoreOffer) return;
          await pc.setRemoteDescription(description);
          if (description.type === "offer") {
            await pc.setLocalDescription();
            this.signal({ description: pc.localDescription.toJSON() });
          }
        } else if (candidate) {
          if (candidate.candidate) this.ice.remote.add(candidateType(candidate.candidate));
          try { await pc.addIceCandidate(candidate); }
          catch (err) { if (!this.ignoreOffer) throw err; }
        }
      } catch (err) {
        warn("P2P signaling error", err);
      }
    });
  }

  send(obj) {
    if (this.dc?.readyState !== "open") return false;
    try { this.dc.send(JSON.stringify(obj)); return true; }
    catch { return false; }
  }

  chunkSize() {
    const max = this.pc?.sctp?.maxMessageSize;
    const limit = max === Infinity ? 65536 : (Number(max) > 0 ? Number(max) : 16384);
    return Math.min(limit, 65536) - HEADER;
  }

  async drain() {
    while (this.state === "open" && this.dc.bufferedAmount > BUFFER_HIGH) {
      await new Promise(resolve => this.lowWaiters.push(resolve));
    }
  }

  wakeWriters() {
    const waiters = this.lowWaiters;
    this.lowWaiters = [];
    for (const w of waiters) w();
  }

  /** Download [start, end) of `path` into `target` at the same offset. Rejects with err.code. */
  fetchRange(path, start, end, target, signal, timeoutMs, onData) {
    return new Promise((resolve, reject) => {
      const error = code => Object.assign(new Error(`P2P ${code}`), { code });
      if (this.state !== "open") return reject(error("closed"));
      if (signal?.aborted) return reject(error("aborted"));
      this.nextRid = (this.nextRid + 1) >>> 0 || 1;
      const rid = this.nextRid;
      const req = { base: start, length: end - start, received: 0, target, onData };
      const cleanup = () => {
        clearTimeout(req.timer);
        this.requests.delete(rid);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => req.fail("aborted");
      req.fail = code => {
        cleanup();
        if (code !== "closed" && code !== "busy" && code !== "missing") this.send({ op: "cancel", rid });
        reject(error(code));
      };
      req.done = () => { cleanup(); this.lastUsed = Date.now(); resolve(); };
      req.timer = setTimeout(() => req.fail("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.requests.set(rid, req);
      if (!this.send({ op: "req", rid, path, start, end })) req.fail("closed");
    });
  }

  onChunk(buf) {
    if (buf.byteLength < HEADER) return;
    const dv = new DataView(buf);
    const req = this.requests.get(dv.getUint32(0));
    if (!req) return; // cancelled or timed out
    const off = dv.getUint32(4);
    const data = new Uint8Array(buf, HEADER);
    if (off + data.length > req.length) return req.fail("protocol");
    req.target.set(data, req.base + off);
    req.received += data.length;
    this.downBytes += data.length;
    S.down += data.length;
    req.onData?.();
  }

  onControl(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.op) {
      case "req": this.serve(msg); break;
      case "cancel": { const job = this.uploads.get(msg.rid); if (job) job.cancelled = true; break; }
      case "end": {
        const req = this.requests.get(msg.rid);
        if (req) req.received === req.length ? req.done() : req.fail("short");
        break;
      }
      case "err": this.requests.get(msg.rid)?.fail(msg.code === "busy" || msg.code === "missing" ? msg.code : "remote"); break;
      case "ping": this.send({ op: "pong", t: msg.t }); break;
      case "pong": if (Number.isFinite(msg.t)) this.rttMs = Math.round(performance.now() - msg.t); break;
    }
  }

  async serve({ rid, path, start, end }) {
    if (!Number.isInteger(rid) || typeof path !== "string") return;
    const p = normalizePath(path);
    if (!S.enabled || canvasLoading() || activeUploads >= MAX_UPLOADS || this.uploads.size >= LANES_PER_PEER || this.uploads.has(rid)) {
      return this.send({ op: "err", rid, code: "busy" });
    }
    if (!isOptimizedPath(p) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - start > PIECE) {
      return this.send({ op: "err", rid, code: "missing" });
    }
    const job = { cancelled: false };
    this.uploads.set(rid, job);
    activeUploads++;
    try {
      const blob = await seedBlob(p);
      if (!blob) {
        noteEvicted([p]); // the tracker still lists us for a file this browser no longer has
        return this.send({ op: "err", rid, code: "missing" });
      }
      if (end > blob.size) return this.send({ op: "err", rid, code: "missing" });
      const data = new Uint8Array(await blob.slice(start, end).arrayBuffer());
      const chunk = this.chunkSize();
      for (let off = 0; off < data.length; off += chunk) {
        if (job.cancelled || this.state !== "open") return;
        if (canvasLoading()) return this.send({ op: "err", rid, code: "busy" });
        const n = Math.min(chunk, data.length - off);
        await takeTokens(n);
        await this.drain();
        if (job.cancelled || this.state !== "open") return;
        const msg = new Uint8Array(HEADER + n);
        const dv = new DataView(msg.buffer);
        dv.setUint32(0, rid);
        dv.setUint32(4, off);
        msg.set(data.subarray(off, off + n), HEADER);
        this.dc.send(msg);
        this.upBytes += n;
        S.up += n;
      }
      this.send({ op: "end", rid });
      this.lastUsed = Date.now();
      if (end >= blob.size) S.servedFiles++;
    } catch (err) {
      warn("P2P upload failed", err);
      this.send({ op: "err", rid, code: "remote" });
    } finally {
      activeUploads--;
      this.uploads.delete(rid);
    }
  }

  fail(reason) {
    if (this.state === "closed" || this.state === "failed") return;
    const graceful = reason === "closed" || reason === "bye";
    if (!graceful) {
      cooldown.set(this.userId, Date.now() + FAIL_COOLDOWN_MS);
      S.failures++;
      const name = game.users.get(this.userId)?.name ?? this.userId;
      const local = [...this.ice.local].join(",") || "-";
      const remote = [...this.ice.remote].join(",") || "-";
      S.lastFailure = { userId: this.userId, name, reason, local, remote, at: Date.now() };
      log(`P2P connection to ${name} ${reason} (local: ${local}; remote: ${remote})`);
    }
    this.teardown(graceful ? "closed" : "failed", true);
  }

  close(sendBye) {
    if (this.state === "closed" || this.state === "failed") return;
    this.teardown("closed", sendBye);
  }

  teardown(state, sendBye) {
    this.state = state;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.pingTimer);
    if (sendBye && !this.byeSent) {
      this.byeSent = true;
      try { emit(MSG.P2P_SIGNAL, { sid: this.sid, bye: true }, this.userId); } catch {}
    }
    this._reject(new Error(`P2P ${state}`));
    for (const req of [...this.requests.values()]) req.fail("closed");
    for (const job of this.uploads.values()) job.cancelled = true;
    this.wakeWriters();
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    if (peers.get(this.userId) === this) peers.delete(this.userId);
  }
}

/* ---------------------------------------- Helpers ---------------------------------------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * ICE candidate type from its SDP line ("candidate:f 1 udp p <address> <port> typ <type> ..."):
 * host, srflx, prflx or relay; "mdns" for a host candidate hidden behind a .local name.
 */
function candidateType(line) {
  const parts = String(line).split(" ");
  if (/\.local$/i.test(parts[4] ?? "")) return "mdns";
  return / typ (\w+)/.exec(line)?.[1] ?? "?";
}

function mimeOf(path) {
  const ext = extOf(path);
  for (const o of Object.values(OUTPUT)) if (o.ext === ext) return o.mime;
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", avif: "image/avif",
    mp4: "video/mp4", m4v: "video/mp4", ogv: "video/ogg", mp3: "audio/mpeg", opus: "audio/ogg" }[ext] ?? "application/octet-stream";
}
