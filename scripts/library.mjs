import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";

/**
 * The optimization library: one entry per ORIGINAL path, stored in the `library` world setting as a map keyed by that
 * path. The key is the original, so the stored entries do not repeat it: every reader gets it filled in as
 * `entry.original` (entries written by older versions still carry the field; it is ignored).
 *
 * @typedef {object} LibraryEntry
 * @property {string} original        Original path as referenced by documents (decoded, no leading slash). Never stored.
 * @property {string|null} optimized  Optimized path. Kept on `skipped`/`restored` entries for a cheap re-optimize;
 *                                    only `done` entries are live mappings.
 * @property {"image"|"video"|"audio"} kind
 * @property {"done"|"skipped"|"failed"} status
 * @property {string} [reason]        Why it was skipped/failed (i18n key suffix under Reasons / Media.Reason)
 * @property {string} [detail]        Raw error message behind `reason` (console/tooltip only)
 * @property {string} [source]        Fingerprint of the original when it was converted (ETag, or Last-Modified|length)
 * @property {string[]} [refs]        A few referencing document uuids (missing files)
 * @property {string} [uploadedName]  Client-converted upload (original === optimized): the name the user picked
 * @property {number} [cleaned]  when the cleanup emptied the original (0 bytes, same name; see media/cleanup.mjs)
 * @property {string} [sha256]        Hex SHA-256 of the optimized file (P2P integrity)
 * @property {number} [bytes]         Optimized size
 * @property {number} [originalBytes] Original size
 * @property {number} at              Epoch ms of the last change
 * @property {boolean} [rewritten]    References were re-pointed to `optimized`
 * @property {number} [attempts]      Failed attempts so far
 */

/** Batched writes: a trailing window, capped by a hard max wait from the first queued entry. */
const WINDOW_MS = 20_000;
const MAX_WAIT_MS = 60_000;

let byOptimized = new Map();
let queue = new Map();        // key -> partial entry not yet handed to the writer
let waiters = [];             // putEntries promises settled by the next flush
let flushTimer = null;
let firstQueuedAt = 0;
/** Writes handed to the writer but not persisted yet, in order: {put: Map} | {remove: Set}. */
const ops = [];
let chain = Promise.resolve();
/** Every write of this client runs here, one after another, and reads the library inside the chain. */
const serial = fn => (chain = chain.then(fn, fn));

/** The setting as stored: entries without `original`. */
const persisted = () => getSetting("library") ?? {};

/** A stored entry as readers see it: its key filled in as `original`. */
const withKey = (key, entry) => (entry ? { ...entry, original: key } : null);

/** Apply a write. `filled` is for the readers' view, where every entry carries its key as `original`. */
function apply(lib, op, key, filled = false) {
  const merge = (k, v) => { lib[k] = filled ? { ...(lib[k] ?? {}), ...v, original: k } : { ...(lib[k] ?? {}), ...v }; };
  if (op.put) {
    if (key !== undefined) { if (op.put.has(key)) merge(key, op.put.get(key)); }
    else for (const [k, v] of op.put) merge(k, v);
  } else if (key !== undefined) { if (op.remove.has(key)) delete lib[key]; }
  else for (const k of op.remove) delete lib[k];
}

/** The library as this client will persist it: stored value, then pending writes, then the open batch. */
export function getLibrary() {
  const lib = {};
  for (const [key, entry] of Object.entries(persisted())) lib[key] = withKey(key, entry);
  for (const op of ops) apply(lib, op, undefined, true);
  apply(lib, { put: queue }, undefined, true);
  return lib;
}

export function getEntry(original) {
  const key = normalizePath(original);
  const lib = {};
  const entry = persisted()[key];
  if (entry) lib[key] = withKey(key, entry);
  for (const op of ops) apply(lib, op, key, true);
  apply(lib, { put: queue }, key, true);
  return lib[key] ?? null;
}

/**
 * The entry as the server holds it, without this client's pending writes: what a crash or a reload would leave.
 * The background optimizer re-points a document only to a copy whose `done` entry is here.
 */
export function getStoredEntry(original) {
  const key = normalizePath(original);
  return withKey(key, persisted()[key]);
}

export const findByOptimized = path => byOptimized.get(normalizePath(path)) ?? null;

let approved = null;
/** Originals the GM approved for conversion in review mode (`reviewApproved`, cached until it changes). */
export function isApproved(path) {
  approved ??= new Set((getSetting("reviewApproved") ?? []).map(normalizePath));
  return approved.has(normalizePath(path));
}
export function forgetApproved() { approved = null; }

/**
 * Whether the background optimization is going to convert this original on its own: always in "auto" mode, only once
 * the GM approved it in "review" mode, never in "off", while paused, before the welcome screen, or with media off.
 */
export function willConvert(path) {
  try {
    if (!getSetting("mediaEnabled") || getSetting("backfillPaused") || !getSetting("welcomeDone")) return false;
    const mode = getSetting("backfillMode");
    return (mode === "auto") || ((mode === "review") && isApproved(path));
  }
  catch { return false; }
}

/** Rebuild the reverse index of live (`done`) mappings. Called at ready and whenever the setting changes. */
export function indexLibrary() {
  byOptimized = new Map();
  for (const e of Object.values(getLibrary())) if (e.status === "done" && e.optimized) byOptimized.set(e.optimized, e);
  Hooks.callAll(`${MODULE_ID}.libraryChanged`);
}

/**
 * Queue entries for a batched write (GM only). Partial entries for the same original are merged field by field.
 * The write goes out 20 s after the last call, and at most 60 s after the first queued entry.
 * `now: true` writes at once. The promise settles when the write carrying these entries lands
 * (rejects if it fails); callers that do not need durability should not await it, only `.catch` it.
 */
export function putEntries(entries, { now = false } = {}) {
  if (!game.user.isGM) return Promise.reject(new Error("Only a GM can write the library"));
  for (const { original, ...fields } of [].concat(entries)) {
    const key = normalizePath(original);
    queue.set(key, { ...(queue.get(key) ?? {}), ...fields, at: Date.now() });
  }
  const done = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  if (now) flush();
  else {
    firstQueuedAt ||= Date.now();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, Math.max(0, Math.min(WINDOW_MS, firstQueuedAt + MAX_WAIT_MS - Date.now())));
  }
  return done;
}

/** Hand the open batch to the writer. */
function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  firstQueuedAt = 0;
  if (!queue.size) return;
  const op = { put: queue };
  const settle = waiters;
  queue = new Map();
  waiters = [];
  write(op).then(() => settle.forEach(w => w.resolve()), err => settle.forEach(w => w.reject(err)));
}

function write(op) {
  ops.push(op);
  return serial(async () => {
    const lib = foundry.utils.deepClone(persisted());
    apply(lib, op);
    await setSetting("library", lib);
  }).finally(() => ops.splice(ops.indexOf(op), 1));
}

/** Write anything queued now. Resolves once every write of this client has settled (failures go to their callers). */
export function flushLibrary() {
  flush();
  return chain.then(() => {}, () => {});
}

/** Delete entries (GM only). Pending queued writes for those keys are dropped so they cannot bring them back. */
export function removeEntries(originals) {
  if (!game.user.isGM) return Promise.reject(new Error("Only a GM can write the library"));
  const keys = new Set([].concat(originals).map(normalizePath));
  for (const k of keys) queue.delete(k);
  return write({ remove: keys });
}

export function libraryStats() {
  const s = { done: 0, skipped: 0, failed: 0, originalBytes: 0, optimizedBytes: 0 };
  for (const e of Object.values(getLibrary())) {
    s[e.status] = (s[e.status] ?? 0) + 1;
    if (e.status === "done") { s.originalBytes += e.originalBytes ?? 0; s.optimizedBytes += e.bytes ?? 0; }
  }
  s.savedBytes = s.originalBytes - s.optimizedBytes;
  return s;
}

/**
 * Canonical form used as library key and for reference matching:
 * strip origin, route prefix, query/hash and leading slash; decode %XX.
 */
export function normalizePath(path) {
  if (!path) return "";
  let p = String(path).trim();
  try { if (/^https?:\/\//i.test(p)) { const u = new URL(p); if (u.origin !== globalThis.location?.origin) return p; p = u.pathname; } } catch {}
  p = p.split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/^\/+/, "");
  const prefix = globalThis.ROUTE_PREFIX ? `${globalThis.ROUTE_PREFIX.replace(/^\/+|\/+$/g, "")}/` : "";
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  return p;
}
