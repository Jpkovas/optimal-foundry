import { MODULE_ID, SOCKET, log, warn } from "./constants.mjs";

/**
 * Typed message bus over the module socket.
 * Envelope: { t: type, p: payload, from: userId, to?: userId[], rid?: requestId, re?: requestId, err?: string }
 * Foundry relays module socket messages to every other socket (never back to the sending socket);
 * `to` narrows delivery server-side through the `recipients` option and is re-checked here.
 * A user may have several sessions (tabs/windows): a message addressed to that user reaches all of them.
 */
const handlers = new Map();   // type -> Set<(payload, fromUserId) => any>
const pending = new Map();    // rid -> { resolve, reject, timer, to }
let seq = 0;

/** This browser session. Request ids carry it so two sessions of one user never share an id. */
const session = { sid: Math.random().toString(36).slice(2, 12), startedAt: Date.now() };

/**
 * The server announced that the world is closing. From then on it has no user list, and a message addressed to
 * specific users makes it throw in its log; the page is about to leave anyway, so nothing more is sent.
 */
let closing = false;

export function initSocket() {
  game.socket.on(SOCKET, onMessage);
  game.socket.on("shutdown", () => { closing = true; });
  initSessionLock();
}

/** The server appends the real sender id; trust it over the envelope's self-declared `from`. */
function onMessage(msg, senderId) {
  if (!msg || typeof msg !== "object") return;
  if (msg.to && !msg.to.includes(game.user.id)) return;
  if (senderId) msg.from = senderId;
  if (msg.re) {
    // Only the user the request went to may answer it; a forged reply leaves the real one pending.
    const p = pending.get(msg.re);
    if (!p || senderId !== p.to) return;
    pending.delete(msg.re);
    clearTimeout(p.timer);
    return msg.err ? p.reject(new Error(msg.err)) : p.resolve(msg.p);
  }
  const set = handlers.get(msg.t);
  if (!set?.size) return;
  for (const fn of set) {
    Promise.resolve()
      .then(() => fn(msg.p, msg.from))
      // A handler that returns undefined does not answer (e.g. a session that is not the coordinator).
      .then(result => { if (msg.rid && result !== undefined) send({ re: msg.rid, p: result, to: [msg.from] }); })
      .catch(err => {
        warn(`socket handler "${msg.t}" failed`, err);
        if (msg.rid) send({ re: msg.rid, err: String(err?.message ?? err), to: [msg.from] });
      });
  }
}

function send(envelope) {
  if (closing) return;
  const msg = { ...envelope, from: game.user.id };
  // Never pass an undefined options argument: socket.io sends it as null, and the server's
  // `{recipients} = {}` destructuring throws on null, silently dropping every broadcast.
  if (msg.to) game.socket.emit(SOCKET, msg, { recipients: msg.to });
  else game.socket.emit(SOCKET, msg);
}

/**
 * Subscribe to a message type. Returns an unsubscribe function.
 * A handler's return value answers a `request`; returning `undefined` sends no answer.
 */
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

/** Fire-and-forget. `to` is a userId or array of userIds; omitted = everyone else. */
export function emit(type, payload, to) {
  send({ t: type, p: payload, to: to ? [].concat(to) : undefined });
}

/** Ask one user and await the handler's return value. Rejects on timeout or handler error. */
export function request(type, payload, to, timeoutMs = 10_000) {
  const rid = `${session.sid}.${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(rid);
      reject(new Error(`socket request "${type}" timed out`));
    }, timeoutMs);
    pending.set(rid, { resolve, reject, timer, to });
    send({ t: type, p: payload, rid, to: [to] });
  });
}

/* ------------------------------------ Coordinator session lock ------------------------------------ */

const BEAT_MS = 10_000;
/**
 * Longer than Chrome's 1-minute timer alignment for hidden tabs, so a backgrounded coordinator never looks dead.
 * A closing session says goodbye on pagehide, so a normal handover is immediate; only a crash waits for the TTL.
 */
const SESSION_TTL_MS = 75_000;
const peers = new Map();      // sid -> { startedAt, seen } for other sessions of this same user
let coordinator = null;       // last value reported through the coordinatorChanged hook

/** The GM user that coordinates (Foundry's designated active GM). */
export const activeGM = () => game.users.activeGM ?? null;

/**
 * True on exactly one session: the active GM user's oldest live session (by startedAt, then sid).
 * Other GM tabs or windows of the same user stay passive and answer no coordinator requests.
 */
export function isCoordinator() {
  if (!game.user?.isActiveGM) return false;
  const now = Date.now();
  for (const [sid, p] of peers) {
    if (now - p.seen > SESSION_TTL_MS) { peers.delete(sid); continue; }
    if (p.startedAt < session.startedAt || (p.startedAt === session.startedAt && sid < session.sid)) return false;
  }
  return true;
}

/** Recompute and fire `optimal-foundry.coordinatorChanged(isCoordinator)` when the value changed. */
function recheck() {
  const now = isCoordinator();
  if (now === coordinator) return;
  const first = coordinator === null;
  coordinator = now;
  if (first) return;
  log(now ? "this session is now the coordinator" : "not coordinator: another session of this GM coordinates");
  Hooks.callAll(`${MODULE_ID}.coordinatorChanged`, now);
}

function beat() {
  emit(MSG.COORD_BEAT, { sid: session.sid, startedAt: session.startedAt }, game.user.id);
}

function initSessionLock() {
  coordinator = isCoordinator();
  Hooks.on("userConnected", user => { if (user?.isGM) recheck(); });
  if (!game.user.isGM) return;
  on(MSG.COORD_BEAT, (payload, from) => {
    if (from !== game.user.id || !payload || payload.sid === session.sid) return;
    if (payload.bye) { peers.delete(payload.sid); return recheck(); }
    const known = peers.has(payload.sid);
    peers.set(payload.sid, { startedAt: Number(payload.startedAt) || 0, seen: Date.now() });
    if (!known) beat(); // a new session: reveal ourselves now instead of at the next beat
    recheck();
  });
  beat();
  setInterval(() => { beat(); recheck(); }, BEAT_MS);
  // A plain broadcast, not addressed to this user: when the world is shutting down the server has no user list
  // any more and a targeted emit throws in its log. The handler above already ignores every other sender.
  window.addEventListener("pagehide", () => emit(MSG.COORD_BEAT, { sid: session.sid, bye: true }));
}

/** Message types used across subsystems, kept in one place so producers and consumers agree. */
export const MSG = {
  // core
  COORD_BEAT: "core.coordBeat",              // GM session -> own user {sid, startedAt}; -> all {sid, bye: true} on pagehide: same-user session lock
  // media
  CONVERT_REQUEST: "media.convertRequest",   // client -> GM {path}: please optimize this uploaded original
  REGISTER_OPTIMIZED: "media.registerOptimized", // client -> GM {original, optimized, kind, sha256, bytes, originalBytes}: a client-side converted upload
  // network / preload
  CLIENT_STATUS: "net.status",               // client -> GM (request) {inflight, urgent, bytesPerSec, sceneReady, idle, cacheBytes, joining, local, publicOrigin, secure, cache, p2p, rttMs, preload} -> true: the round trip is the client's next rttMs
  PRELOAD_NEXT: "net.preloadNext",           // client -> GM (request) {have: string[], full?: boolean} -> {items: [], waitMs}: up to 8 items, already charged to the budget
  PRELOAD_DONE: "net.preloadDone",           // client -> GM {results: [{src, bytes, ok, aborted, reason}]}: bytes = what the host uploaded; settled against what the GM charged
  PRELOAD_WAKE: "net.preloadWake",           // GM -> all {}: the preload queue changed, ask again now
  JOIN_TURN: "net.joinTurn",                 // GM -> client {}: you may start loading/preloading now
  // p2p
  P2P_HAVE: "p2p.have",                      // client -> GM {add: string[], drop: string[], reset?} | {off: true} (left the swarm)
  P2P_WANT: "p2p.want",                      // client -> GM (request) {url} -> {peers: userId[], sha256, bytes}
  P2P_SIGNAL: "p2p.signal",                  // peer -> peer {sdp?|candidate?, session}
  P2P_STATS: "p2p.stats",                    // client -> GM {up, down, peers}
  P2P_RESYNC: "p2p.resync"                   // GM -> client {}: the tracker is empty, announce your whole cache again
};
