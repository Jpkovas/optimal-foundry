import { MODULE_ID, EXT, log, warn, extOf, isOptimizedPath } from "../constants.mjs";
import { getSetting, setSetting } from "../settings.mjs";
import { on, MSG, isCoordinator } from "../socket.mjs";
import {
  getEntry, getStoredEntry, getLibrary, putEntries, removeEntries, flushLibrary, normalizePath, findByOptimized,
  isApproved, forgetApproved
} from "../library.mjs";
import {
  collectReferences, collectDocumentReferences, rewriteReferences, expandPatterns, matchPattern, setTokenPatterns, isPatternKey
} from "./references.mjs";
import { optimizeUrl, canConvert, conversionBlocker } from "./converter.mjs";
import { outputLocation, ensureDirectory, encodeSegments, toFetchUrl, dirName, CORE_PUBLIC_ROOTS } from "./naming.mjs";
import { tunnelLimited, TUNNEL_LIMIT_BYTES } from "./upload-hook.mjs";
import { playersBusy } from "../net/scheduler.mjs";
import { preloadRank } from "../net/preload.mjs";
import { isLocalOrigin } from "../net/cdn.mjs";

/**
 * Background optimization of existing world media, run by the coordinating GM session only.
 * One item at a time: check the original -> convert -> upload next to it (or the mirror) -> re-point.
 * Re-pointing is batched (one library write, then one update per document per batch); player requests and new
 * references run at once.
 */

const MAX_ATTEMPTS = 3;
/** The background optimizer rescans on its own at most this often (a manual Analyze always runs). */
const RESCAN_MIN_MS = 5 * 60_000;
/** HEAD requests in flight when many files are checked (the copies at a scan, an undo, a re-pointing batch). */
const HEAD_CONCURRENCY = 4;
/** This many uploads failing in a row stop the run: the server is the problem (a full disk, a tunnel), not the files. */
const UPLOAD_BREAKER = 3;
/** An upload may take this long plus the time its size needs at 1 Mbit/s; a server that hangs answers nothing. */
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_MIN_BYTES_PER_SEC = 125_000;
/**
 * A conversion that reports no progress for this long is stopped (its worker is terminated) and counts as a failed
 * attempt. Generous on purpose: an image reports only at 50% and 100%, and a large map takes minutes to encode.
 */
const STALL_MS = 5 * 60_000;
/**
 * Heavy work keeps the game master's computer busy for minutes, so it waits until no player is connected: every
 * video, and audio and images whose original is larger than these sizes.
 */
export const HEAVY_AUDIO_BYTES = 20 * 1_048_576;
export const HEAVY_IMAGE_BYTES = 30 * 1_048_576;
/** Uncompressed formats: two different files of the same length have the same size, so size proves nothing. */
const FIXED_SIZE_EXT = new Set(["wav", "bmp", "tif", "tiff"]);
const AUTO_START_MS = 30_000;
const ITEM_GAP_MS = 750;
const DEFERRED_RECHECK_MS = 60_000;
const QUIET_MAX_S = 120;
const REWRITE_BATCH = 20;
const DOC_DEBOUNCE_MS = 1500;
const URGENT_RECHECK_MS = 5000;
const RESORT_DELAY_MS = 2000;
const MISSING_REFS_MAX = 10;
const CRASH_KEY = `${MODULE_ID}.backfillCurrent`;
const KINDS = ["image", "video", "audio"];
const MEDIA_EXT = new Set([...EXT.image, ...EXT.video, ...EXT.audio]);
/** Formats that are already the target codec family: never queued and never recorded (keeps the library small). */
const ALREADY_OPTIMAL = new Set(["webp", "avif", "ogg", "opus"]);
const KIND_ORDER = { image: 0, audio: 1, video: 2 };
/** Document types whose create/update never needs a look: history, our own state, and token deltas. */
const UNWATCHED_DOCUMENTS = new Set(["ChatMessage", "FogExploration", "Setting", "ActorDelta"]);
/** Fields a converted entry carries; cleared when an original goes back to skipped/failed. */
const CLEAR = { optimized: null, sha256: undefined, bytes: undefined, rewritten: undefined, source: undefined,
  cleaned: undefined, refs: undefined, detail: undefined };

const state = {
  active: false,          // the backfill should be working through the queue
  pausedByUser: false,
  phase: "idle",
  current: null,          // {original, kind, progress, urgent}
  queue: [],              // items from the last scan (plus new references found by the document hooks)
  review: [],             // review mode: conversions waiting for the GM's approval (dashboard)
  heavy: [],              // heavy conversions held back while players are connected
  urgent: [],             // player convert requests and new references to converted files, run even while paused
  deferred: new Map(),    // original -> {to, refs, failed}
  lastError: null,        // {path?, reason, detail?}
  scannedAt: 0,
  repaired: 0,            // references pointed back at originals this session (their optimized copy was gone)
  run: { done: 0, skipped: 0, failed: 0 },
  abort: null
};

let initialized = false;
let loop = null;
let scanning = null;
let deferredBusy = false;
let undoing = false;
/** Set while the cleanup empties originals; undo and the cleanup never run at the same time. */
let cleaning = false;
let autoTimer = null;
let resortTimer = null;
let rescanTimer = null;
let currentItem = null;
/** The optimized copies the documents use were checked this session (see repairCopies). */
let copiesChecked = false;
/** Paths the documents referenced at the last read, plus what the document hooks saw since. Null before the first. */
let known = null;
/** Document uuids changed while a player's request waits for the first read of the session (see usedBefore). */
const touched = new Set();
let waitingRequests = 0;
let indexing = null;
/**
 * References held by world compendium documents, read from the server once and then kept:
 * `{byDoc: Map<top-level uuid, [path, Ref][]>, external: Set, vector: Set}`. Null until read (or while off).
 */
let packs = null;
let trackPacks = false;
const packDirty = new Map();        // top-level compendium document uuid -> the document, or null when deleted
let collecting = Promise.resolve();
/** Uploads that failed one after another: `{original, attempts}` (attempts before the failure). */
let uploadStreak = [];
/** Originals the GM told to convert now although they are heavy (runHeavyNow). */
const heavyAllowed = new Set();
const capability = new Map();       // kind -> Promise<boolean>
const notCapableWarned = new Set();
const pendingRewrites = new Map();  // original -> {to, refs}
const pendingDocs = new Map();      // uuid -> {doc, children, timer}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = (timeout = 2000) => new Promise(resolve => {
  if (typeof globalThis.requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout });
  else setTimeout(resolve, 50);
});
const FP = () => foundry.applications.apps.FilePicker.implementation;
const t = (key, data) => data ? game.i18n.format(`OPTIMALFOUNDRY.Library.${key}`, data) : game.i18n.localize(`OPTIMALFOUNDRY.Library.${key}`);

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

export function initBackfill() {
  if (initialized) return;
  initialized = true;
  try {
    on(MSG.CONVERT_REQUEST, onConvertRequest);
    on(MSG.REGISTER_OPTIMIZED, onRegisterOptimized);
    if (!game.user.isGM) return;
    window.addEventListener("pagehide", clearCrashMarker);
    Hooks.on("canvasReady", () => setTimeout(processDeferred, 2000));
    Hooks.on("updatePlaylistSound", (sound, changed) => { if (changed?.playing === false) setTimeout(processDeferred, 1000); });
    Hooks.on("updateScene", (scene, changed) => {
      if (!("active" in (changed ?? {}))) return;
      setTimeout(processDeferred, 2000);
      resortSoon();
    });
    Hooks.on(`${MODULE_ID}.settingChanged`, (key, value) => {
      if (key === "nextScenes") resortSoon();
      else if (key === "backfillMode") onModeChanged().catch(err => warn("backfill mode change failed", err));
      else if ((key === "welcomeDone") && value) scheduleAutoStart(5000);
      else if (key === "backfillPaused") value ? pause() : scheduleAutoStart(1000);
    });
    Hooks.on(`${MODULE_ID}.coordinatorChanged`, now => { if (now) scheduleAutoStart(AUTO_START_MS); });
    Hooks.on("userConnected", () => {
      if (!playersConnected()) releaseHeavy();
      // A player arrived in the middle of a heavy conversion: stop it. The worker holds it back when it returns to it.
      else if (currentItem?.heavy && !heavyAllowed.has(currentItem.original)) state.abort?.abort();
    });
    watchDocuments();
    setInterval(() => { if (state.deferred.size) processDeferred(); }, DEFERRED_RECHECK_MS);
    scheduleAutoStart(AUTO_START_MS);
  }
  catch (err) {
    warn("background optimization failed to initialize", err);
  }
}

/**
 * Analyze: collect references and rebuild the queue. Coordinator only, and only while media optimization is on.
 * This is the scan a person asks for (the dashboard's button, the API): it reads the world's compendia from the
 * server again and checks that the optimized copies the documents use are still there. The scans the optimizer runs
 * on its own do both only the first time in a session.
 * @returns {Promise<{paths: number, convert: number, rewrite: number, review: number, kinds: {image: number, audio: number, video: number}}|null>}
 */
export function scan() {
  return runScan(true);
}

function runScan(manual = false) {
  if (!isCoordinator() || !getSetting("mediaEnabled")) return Promise.resolve(null);
  if (scanning) return scanning;
  clearTimeout(rescanTimer);
  scanning = (async () => {
    try {
      await recordInterrupted();
      let { refs, unread } = await collect(manual);
      if ((manual || (!copiesChecked && !throughCdn())) && !undoing && !cleaning) {
        copiesChecked = true;
        const repaired = await repairCopies(refs);
        if (repaired) {
          state.repaired += repaired;
          // The documents changed: read them again, so the queue and the report describe what they hold now.
          ({ refs, unread } = await collect(false));
        }
      }
      const items = [];
      for (const [path, list] of refs) {
        if (state.deferred.has(path) || pendingRewrites.has(path) || (state.current?.original === path)) continue;
        const item = classify(path, list);
        if (item) items.push(item);
      }
      const { queue, review } = splitForReview(items);
      // What is held back for the players stays held, with its references as they are now. A player's own request
      // stays too: the documents may not use its file yet.
      const fresh = new Map(queue.map(i => [i.original, i]));
      state.heavy = state.heavy.filter(h => h.urgent || fresh.has(h.original)).map(h => (h.urgent ? h : fresh.get(h.original)));
      const heldBack = new Set(state.heavy.map(h => h.original));
      state.queue = sortQueue(queue.filter(i => !heldBack.has(i.original)));
      state.review = sortQueue(review);
      state.scannedAt = Date.now();
      pruneApproved();
      const kinds = { image: 0, audio: 0, video: 0 };
      for (const i of items) if (i.type === "convert") kinds[i.kind]++;
      const summary = {
        paths: refs.size,
        convert: items.filter(i => i.type === "convert").length,
        rewrite: items.filter(i => i.type === "rewrite").length,
        review: state.review.length,
        kinds
      };
      log("backfill scan", summary);
      await setSetting("scanReport", scanReport(refs, unread)).catch(err => warn("could not store the scan report", err));
      return summary;
    }
    catch (err) {
      warn("backfill scan failed", err);
      state.lastError = { reason: "scanFailed", detail: String(err?.message ?? err) };
      return null;
    }
  })().finally(() => { scanning = null; });
  return scanning;
}

/**
 * Every media reference of the world, one read at a time. World documents are walked each time (they are in
 * memory). World compendia are fetched from the server only when `full`, or when they were not read yet this session
 * (the first scan, the setting turned on); in between their references are kept, and the document hooks say which
 * documents to walk again. The counts of media on other hosts and of SVG then include the last full read's.
 * @param {boolean} full  Read the compendia from the server again (a manual Analyze).
 * @returns {Promise<{refs: Map<string, object[]>, unread: {external: Set<string>, vector: Set<string>}}>}
 */
function collect(full) {
  const run = collecting.then(() => readReferences(full));
  collecting = run.catch(() => {});
  return run;
}

async function readReferences(full) {
  const unread = { external: new Set(), vector: new Set() };
  const add = (refs, path, ref) => { const list = refs.get(path); if (list) list.push(ref); else refs.set(path, [ref]); };
  let refs;
  trackPacks = !!getSetting("includeCompendia");
  if (!trackPacks) {
    packs = null;
    packDirty.clear();
    refs = await collectReferences({ includeCompendia: false, unread });
  }
  else if (full || !packs) {
    // Documents that change while the compendia are read are marked again by the hooks and walked next time.
    packDirty.clear();
    refs = await collectReferences({ includeCompendia: true, unread });
    packs = { byDoc: new Map(), external: new Set(unread.external), vector: new Set(unread.vector) };
    for (const [path, list] of refs) {
      for (const ref of list) {
        if (!String(ref.uuid).startsWith("Compendium.")) continue;
        // Compendium.<package>.<pack>.<type>.<id>: the top-level document that holds the reference.
        const top = ref.uuid.split(".").slice(0, 5).join(".");
        if (!packs.byDoc.has(top)) packs.byDoc.set(top, []);
        packs.byDoc.get(top).push([path, ref]);
      }
    }
  }
  else {
    refs = await collectReferences({ includeCompendia: false, unread });
    for (const [uuid, doc] of packDirty) {
      const list = [];
      try {
        if (doc) for (const [path, found] of collectDocumentReferences(doc, { children: true })) for (const ref of found) list.push([path, ref]);
      }
      catch (err) { warn(`could not scan ${uuid}`, err); }
      if (list.length) packs.byDoc.set(uuid, list);
      else packs.byDoc.delete(uuid);
    }
    packDirty.clear();
    for (const list of packs.byDoc.values()) for (const [path, ref] of list) add(refs, path, ref);
    for (const v of packs.external) unread.external.add(v);
    for (const v of packs.vector) unread.vector.add(v);
  }
  // Wildcard token art: the files a pattern matches are references of its actor, the pattern itself is not a file.
  await expandPatterns(refs);
  known = new Set(refs.keys());
  return { refs, unread };
}

/**
 * A world compendium document was created, changed or deleted (our own re-pointing included): its kept references
 * are read again at the next scan. Costs nothing here; a bulk import marks the same document many times.
 */
function notePackChange(doc, deleted = false) {
  if (!trackPacks) return;
  let top = doc;
  while (top?.parent) top = top.parent;
  if (!top?.pack || (game.packs?.get(top.pack)?.metadata?.packageType !== "world")) return;
  packDirty.set(top.uuid, (deleted && (top === doc)) ? null : top);
}

/**
 * Asked for a file it does not hold yet, a caching CDN fetches the whole file from the host, even for a HEAD.
 * Checking every copy through one would pull the library through the host's upload at once, outside the preload's
 * budget. So the optimizer checks the copies on its own only from a browser that reaches the server directly (or
 * through a tunnel that does not cache); a manual Analyze always checks.
 */
const throughCdn = () => !!getSetting("cdnStatus")?.cdn && !isLocalOrigin();

/**
 * Self-repair: optimized copies the documents point at that are gone or cut short (a world restored or moved
 * without the copies kept outside its folder, a full disk). Their references go back to the original, when it still
 * has content, and the entry is forgotten, so the scan queues the original for conversion again.
 * @param {Map<string, object[]>} refs  The references just collected
 * @returns {Promise<number>} references pointed back at originals
 */
async function repairCopies(refs) {
  const broken = new Map(); // optimized copy -> original
  const lost = [];
  await eachLimited([...refs.keys()].filter(isOptimizedPath), HEAD_CONCURRENCY, async copy => {
    const entry = getEntry(findByOptimized(copy)?.original);
    // No entry, or a client-converted upload (original === optimized): there is no original to go back to.
    if ((entry?.status !== "done") || (entry.optimized !== copy) || (entry.original === copy)) return;
    try {
      if (await copyIntact(entry)) return;
      const original = await headInfo(entry.original);
      if (original && (original.bytes !== 0)) broken.set(copy, entry.original);
      else lost.push(copy);
    }
    catch (err) { warn(`could not check ${copy}`, err); }
  });
  if (lost.length) warn("optimized copies are missing and their originals are gone or empty", lost);
  if (!broken.size) return 0;

  // Nothing may point documents at these copies again.
  const originals = new Set(broken.values());
  for (const o of originals) { state.deferred.delete(o); pendingRewrites.delete(o); }
  state.urgent = state.urgent.filter(i => !originals.has(i.original));
  let res;
  try { res = await rewriteReferences(broken, { refs, protect: () => false }); }
  catch (err) {
    warn("could not point documents back at the originals", err);
    return 0;
  }
  const failed = new Set(res.failedFrom);
  const forget = [...broken].filter(([copy]) => !failed.has(copy)).map(([, original]) => original);
  if (forget.length) await removeEntries(forget).catch(err => warn("could not forget the entries of missing copies", err));
  // Token art that picks its file by a pattern goes back to the original pattern, unless an original is gone too.
  const patterns = await restorePatterns(refs, new Set([...broken.keys()].filter(copy => !failed.has(copy))),
    new Set(lost.map(copy => findByOptimized(copy)?.original)));
  const repointed = res.updated + patterns;
  warn(`${broken.size} optimized copies were missing or incomplete; ${repointed} references point at the originals again`,
    [...broken.keys()]);
  if (repointed) ui.notifications?.warn(t("Repaired", { files: broken.size, references: repointed }));
  return repointed;
}

/**
 * Is the optimized copy of an entry on the server, whole? "No" is asked twice, the second time past any CDN cache,
 * which may still hold the answer from before the file was stored. Throws when the server cannot be asked.
 */
async function copyIntact(entry) {
  const expected = Number(entry.bytes);
  const whole = info => !!info && ((info.bytes === null) || !(expected > 0) || (info.bytes === expected));
  return whole(await headInfo(entry.optimized)) || whole(await headInfo(entry.optimized, { fresh: true }));
}

/** Start (or resume) the background optimization. Waits for players to settle, then scans when nothing is queued. */
export async function start() {
  if (!isCoordinator()) {
    warn("only the coordinating GM session runs the background optimization");
    return false;
  }
  if (!getSetting("mediaEnabled")) {
    warn("media optimization is turned off");
    return false;
  }
  if (getSetting("backfillMode") === "off") {
    warn("the optimization of existing files is turned off");
    return false;
  }
  if (!getSetting("welcomeDone")) {
    warn("the background optimization waits for the welcome screen");
    return false;
  }
  clearTimeout(autoTimer);
  state.active = true;
  state.pausedByUser = false;
  state.lastError = null;
  state.run = { done: 0, skipped: 0, failed: 0 };
  await waitForQuiet();
  if (!state.active) return true; // paused while waiting
  // A document edited before the first scan queues one item: the session still needs the full scan.
  if (!state.queue.length || !state.scannedAt) await runScan();
  if (state.active) kick();
  return true;
}

/** Pause. The current conversion is aborted and re-queued (not counted), unless it is a player's request. */
export function pause() {
  clearTimeout(autoTimer);
  const wasWorking = state.active || !!loop;
  state.active = false;
  if (wasWorking) state.pausedByUser = true;
  if (!state.current?.urgent) state.abort?.abort();
  flushLibrary();
  return true;
}

export const isRunning = () => state.active;

/* -------------------------------------------- */
/*  Review mode                                 */
/* -------------------------------------------- */

/** May the backfill start on its own (auto-start, new references)? Never before a GM went through the welcome screen. */
function autoAllowed() {
  return !!getSetting("mediaEnabled") && (getSetting("backfillMode") !== "off") && !getSetting("backfillPaused")
    && !!getSetting("welcomeDone") && !state.pausedByUser;
}

/** "auto" queues every conversion; "review" holds back the ones the GM has not approved; "off" keeps nothing. */
function splitForReview(items) {
  const mode = getSetting("backfillMode");
  if (mode === "off") return { queue: [], review: [] };
  if (mode === "auto") return { queue: items, review: [] };
  const queue = [], review = [];
  for (const i of items) (((i.type === "convert") && !isApproved(i.original)) ? review : queue).push(i);
  return { queue, review };
}

/**
 * Every write of `reviewApproved` runs here, one after another, and computes the new list from the one just written:
 * a prune never drops approvals saved a moment earlier.
 */
let approvalsWrite = Promise.resolve();
function writeApprovals(change) {
  approvalsWrite = approvalsWrite.catch(() => {}).then(() => {
    const list = getSetting("reviewApproved") ?? [];
    const next = change(list);
    if ((next.length === list.length) && next.every((p, i) => p === list[i])) return;
    return setSetting("reviewApproved", next).then(() => forgetApproved());
  });
  return approvalsWrite;
}

/**
 * A failure worth another try. Not after MAX_ATTEMPTS, and never after an interrupted conversion: a file that took
 * the browser down once would do it again at every load.
 */
const retryable = e => (e?.status === "failed") && (e.reason !== "interrupted") && ((e.attempts ?? 0) < MAX_ATTEMPTS);

/** Approvals are only needed until the original has a final library entry. */
function pruneApproved() {
  writeApprovals(list => list.filter(p => {
    const e = getEntry(p);
    return !e || retryable(e);
  })).catch(err => warn("could not prune approvals", err));
}

/** May this original be converted now? Always in auto mode; in review mode once the GM approved it. */
function mayConvert(path) {
  const mode = getSetting("backfillMode");
  return (mode === "auto") || ((mode === "review") && isApproved(path));
}

/**
 * Back to the review list (review mode only; "off" just drops it). `replacedBy` is the fingerprint of a new file found
 * under the name of a converted original: that entry is stale, and the list keeps the item until a conversion
 * (a player's request, say) records that very file.
 */
function toReview(item, replacedBy) {
  if ((getSetting("backfillMode") === "review") && !state.review.some(i => i.original === item.original)) {
    state.review.push({ ...item, type: "convert", urgent: false, replacedBy });
  }
}

/**
 * Last check before working on an item: the mode or the approvals may have changed since it was queued (a mode
 * switch mid-conversion, a scan that started under the old mode, another GM session). Players' requests always run.
 */
function held(item) {
  if (item.urgent) return false;
  if (getSetting("backfillMode") === "off") return true;
  if ((item.type !== "convert") || mayConvert(item.original)) return false;
  toReview(item);
  return true;
}

/** The mode changed: stop what runs (a player's request finishes), sort the queue again, start if now allowed. */
async function onModeChanged() {
  if (!isCoordinator()) return;
  clearTimeout(autoTimer);
  state.active = false;
  if (!state.current?.urgent) state.abort?.abort();
  // A scan already running split the queue under the old mode: wait for it, then scan again.
  if (scanning) await scanning.catch(() => {});
  await runScan();
  scheduleAutoStart(5000);
}

/** Conversions waiting for the GM in review mode: original, kind and the uuids of the documents that use it. */
export function reviewList() {
  // A player's request may have converted one meanwhile. A converted original that was replaced by a new file is listed
  // like a new one, for as long as its entry still describes the old file.
  state.review = state.review.filter(i => {
    const e = getEntry(i.original);
    return !e || retryable(e) || ((e.status === "done") && !!i.replacedBy && (e.source !== i.replacedBy));
  });
  return state.review.map(i => ({ original: i.original, kind: i.kind,
    refs: [...new Set((i.refs ?? []).map(r => r?.uuid).filter(Boolean))] }));
}

/**
 * Approve conversions waiting for review (all of them when `originals` is omitted) and start converting them.
 * The approval is saved before anything converts, so a reload keeps it. Coordinator only.
 * @returns {Promise<number|null>} approved count, or null when this session cannot do it
 */
export async function approve(originals) {
  if (!isCoordinator()) return null;
  const want = originals ? new Set([].concat(originals).map(normalizePath)) : null;
  const picked = state.review.filter(i => !want || want.has(i.original));
  if (!picked.length) return 0;
  await writeApprovals(list => [...new Set([...list, ...picked.map(i => i.original)])]);
  const taken = new Set(picked.map(i => i.original));
  state.review = state.review.filter(i => !taken.has(i.original));
  state.queue = sortQueue([...state.queue, ...picked]);
  state.pausedByUser = false;
  if (getSetting("backfillPaused")) await setSetting("backfillPaused", false);
  if (state.active) kick();
  else start().catch(err => warn("backfill start after approval failed", err)); // waits for the welcome screen
  return picked.length;
}

/**
 * Leave originals as they are: recorded as skipped ("declined"), so no scan offers them again. "Try again" in the
 * file list forgets the entry and puts them back in review. Coordinator only.
 * @returns {Promise<number|null>}
 */
export async function decline(originals) {
  if (!isCoordinator()) return null;
  const want = new Set([].concat(originals ?? []).map(normalizePath));
  // Never over a final entry (a player's request may have converted it since it was listed).
  const picked = state.review.filter(i => want.has(i.original) && [null, "failed"].includes(getEntry(i.original)?.status ?? null));
  state.review = state.review.filter(i => !want.has(i.original));
  if (!picked.length) return 0;
  await putEntries(picked.map(i => ({ ...CLEAR, original: i.original, kind: i.kind, status: "skipped", reason: "declined",
    attempts: undefined })), { now: true });
  return picked.length;
}

export function backfillStatus() {
  return {
    running: state.active,
    paused: state.pausedByUser || !!getSetting("backfillPaused"),
    phase: scanning ? "scanning" : state.phase,
    current: state.current ? { ...state.current } : undefined,
    queued: state.queue.length + state.urgent.length,
    review: state.review.length,
    waitingForPlayers: state.heavy.length,
    mode: getSetting("backfillMode"),
    waitingWelcome: !getSetting("welcomeDone"),
    run: { ...state.run },
    deferred: state.deferred.size,
    lastError: state.lastError ? { ...state.lastError } : undefined
  };
}

/** Players at the table: any connected user who is not a game master. */
const playersConnected = () => !!game.users?.some(u => u.active && !u.isGM);

/**
 * Work the background optimizer holds back while players are connected: every video, and audio or images whose
 * original is larger than HEAVY_AUDIO_BYTES / HEAVY_IMAGE_BYTES. An unknown size is not heavy.
 * @param {"image"|"video"|"audio"} kind
 * @param {number|null} bytes  Size of the original
 */
export function isHeavy(kind, bytes) {
  if (kind === "video") return true;
  return Number(bytes) > (kind === "audio" ? HEAVY_AUDIO_BYTES : HEAVY_IMAGE_BYTES);
}

/** Put the held conversions back in line (the last player left, or the GM wants them now). Returns how many. */
function releaseHeavy() {
  if (!isCoordinator()) return 0;
  const items = state.heavy.splice(0);
  for (const i of items) (i.urgent ? state.urgent : state.queue).push(i);
  if (!items.length) return 0;
  state.queue = sortQueue(state.queue);
  kick(); // a player's request among them runs even while paused
  if (!state.active && autoAllowed()) start().catch(err => warn("backfill start failed", err));
  return items.length;
}

/**
 * Convert the heavy files held back for the players now, without waiting for them to leave. Coordinator only.
 * Like an approval it means "go": a paused optimization resumes.
 * @returns {Promise<number|null>} files released, or null when this session cannot do it
 */
export async function runHeavyNow() {
  if (!isCoordinator()) return null;
  if (!state.heavy.length) return 0;
  for (const i of state.heavy) heavyAllowed.add(i.original);
  state.pausedByUser = false;
  if (getSetting("backfillPaused")) await setSetting("backfillPaused", false);
  return releaseHeavy();
}

/**
 * Re-point documents from optimized copies back to their originals. Never deletes files.
 * Reverted entries become `{status: "skipped", reason: "restored"}` and keep `optimized`, so nothing converts them
 * again until `retry()`. Skipped and failed entries are left alone; entries whose original is missing or was emptied
 * by the cleanup are kept.
 * @param {string[]} [originals]  Library keys; all entries when omitted.
 * @returns {Promise<{reverted: number, kept: number, updated: number, failed: number}|null>}
 */
export async function undo(originals) {
  if (!isCoordinator()) {
    warn("only the coordinating GM session can undo the optimization");
    return null;
  }
  if (cleaning || undoing) {
    warn("undo is not available while the cleanup or another undo is running");
    return null;
  }
  const wasActive = state.active;
  const wasPaused = state.pausedByUser;
  undoing = true;
  let summary, refreshReport = false;
  try {
    pause();
    if (loop) await Promise.race([loop, sleep(15_000)]);
    for (let i = 0; deferredBusy && (i < 150); i++) await sleep(100);
    await flushLibrary();

    const lib = getLibrary();
    // Client-converted uploads (original === optimized) have no original to go back to.
    const keys = (originals ? [...new Set([].concat(originals).map(normalizePath))] : Object.keys(lib))
      .filter(key => (lib[key]?.status === "done") && lib[key].optimized && (normalizePath(lib[key].optimized) !== key));
    const kept = [], emptied = [], restored = [];
    const res = { updated: 0, failed: 0 };
    if (keys.length) {
      state.phase = "rewriting";
      try {
        const { refs } = await collect(false);
        for (let i = 0; i < keys.length; i += REWRITE_BATCH) {
          // Each group is looked at again right before it is re-pointed: undoing a large library takes minutes, and
          // another game master's cleanup may empty an original meanwhile.
          const map = new Map(); // optimized -> original
          await eachLimited(keys.slice(i, i + REWRITE_BATCH), HEAD_CONCURRENCY, async key => {
            const entry = getEntry(key);
            if ((entry?.status !== "done") || !entry.optimized) return;
            const info = await headInfo(key).catch(() => null);
            if (!info) return void kept.push(key);
            // Empty: the cleanup took its content (marked now when the mark was lost). Never point documents at it.
            if (info.bytes === 0) {
              kept.push(key);
              if (!entry.cleaned) emptied.push(key);
              return;
            }
            // Marked as emptied, yet it has content: only the file that was converted may come back (it was
            // restored, or the mark was wrong). A different file under that name is not this entry's original.
            if (entry.cleaned && !sameOriginal(entry, info)) return void kept.push(key);
            map.set(normalizePath(entry.optimized), key);
          });
          if (!map.size) continue;

          // Nothing may re-point these to the optimized copy while (or after) they are reverted.
          const undone = new Set(map.values());
          for (const k of undone) { state.deferred.delete(k); pendingRewrites.delete(k); }
          for (const list of ["queue", "urgent", "heavy"]) state[list] = state[list].filter(it => !undone.has(it.original));

          let part;
          try { part = await rewriteReferences(map, { refs, protect: () => false }); }
          catch (err) {
            warn("undo failed", err);
            part = { updated: 0, failed: map.size, failedFrom: [...map.keys()] };
          }
          res.updated += part.updated;
          res.failed += part.failed;
          const failed = new Set(part.failedFrom);
          for (const [optimized, original] of map) (failed.has(optimized) ? kept : restored).push(original);
        }
        res.updated += await restorePatterns(refs, new Set(restored.map(o => normalizePath(getEntry(o).optimized))), new Set(kept));
      }
      catch (err) {
        warn("undo failed", err);
        const settled = new Set([...kept, ...restored]);
        for (const key of keys) if (!settled.has(key)) kept.push(key);
      }
      finally { state.phase = "idle"; }
    }
    if (restored.length) {
      try {
        await putEntries(restored.map(original => ({ original, status: "skipped", reason: "restored", rewritten: false,
          cleaned: undefined, detail: undefined })), { now: true });
      }
      catch (err) { warn("could not mark restored library entries", err); }
    }
    if (emptied.length) await markEmptied(emptied);
    refreshReport = true;
    summary = { reverted: restored.length, kept: kept.length, updated: res.updated, failed: res.failed };
    log("undo", summary, kept.length ? { kept } : "");
    ui.notifications?.info(t("UndoDone", { reverted: summary.reverted }));
    if (kept.length) ui.notifications?.warn(t("UndoKept", { kept: kept.length }));
  }
  finally {
    undoing = false;
  }
  if (refreshReport && !wasActive) runScan(); // start() scans when it restarts
  if (wasActive) start().catch(err => warn("backfill restart after undo failed", err));
  else {
    state.pausedByUser = wasPaused;
    ui.notifications?.info(t("UndoPaused"));
    kick(); // player requests that arrived during the undo
  }
  return summary;
}

/**
 * Give entries another chance. Coordinator only.
 * Restored entries that kept their optimized copy become live again and are re-pointed now (no new encode).
 * Skipped and failed entries are forgotten, so the scan queues them for conversion.
 * @param {string[]} originals  Library keys
 * @returns {Promise<number|null>} entries affected, or null when this session cannot do it
 */
export async function retry(originals) {
  if (!isCoordinator() || !getSetting("mediaEnabled")) return null;
  const keys = [...new Set([].concat(originals ?? []).map(normalizePath))].filter(Boolean);
  const reoptimize = [], forget = [];
  for (const k of keys) {
    const e = getEntry(k);
    // Re-pointing needs a mode that touches documents: in "off" a restored entry stays restored.
    if ((e?.status === "skipped") && (e.reason === "restored") && e.optimized) {
      if (getSetting("backfillMode") !== "off") reoptimize.push(k);
    }
    else if ((e?.status === "skipped") || (e?.status === "failed")) forget.push(k);
  }
  if (!reoptimize.length && !forget.length) return 0;
  try {
    // Durable before any reference points at the optimized copy again.
    if (reoptimize.length) {
      await putEntries(reoptimize.map(original => ({ original, status: "done", reason: undefined, rewritten: false })),
        { now: true });
    }
    if (forget.length) await removeEntries(forget);
  }
  catch (err) {
    warn("retry: could not update the library", err);
    return null;
  }
  await runScan();
  const now = new Set(reoptimize);
  const rewrites = state.queue.filter(i => (i.type === "rewrite") && now.has(i.original));
  if (rewrites.length) {
    state.queue = state.queue.filter(i => !rewrites.includes(i));
    state.urgent.push(...rewrites.map(i => ({ ...i, urgent: true })));
  }
  if (rewrites.length || state.active) kick();
  else if (state.queue.length && autoAllowed()) start().catch(err => warn("backfill start after retry failed", err));
  return reoptimize.length + forget.length;
}

/* -------------------------------------------- */
/*  Worker                                      */
/* -------------------------------------------- */

function scheduleAutoStart(delay) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (!isCoordinator() || state.active) return;
    if (autoAllowed()) return void start().catch(err => warn("backfill auto-start failed", err));
    // Paused: nothing converts, but the review list and the scan table still describe the world.
    if (getSetting("mediaEnabled") && (getSetting("backfillMode") !== "off") && getSetting("welcomeDone") && !state.scannedAt) runScan();
  }, delay);
}

function kick() {
  if (loop || undoing || !isCoordinator()) return;
  loop = runLoop()
    .catch(err => {
      warn("backfill worker stopped", err);
      state.lastError = { reason: "workerStopped", detail: String(err?.message ?? err) };
    })
    .finally(() => {
      loop = null;
      // Work that arrived while the loop was finishing (an approval, a Start during the last flush).
      if (state.urgent.length || (state.active && state.queue.length)) kick();
    });
}

async function runLoop() {
  let processed = 0;
  try {
    while (isCoordinator() && !undoing) {
      const item = state.urgent.shift() ?? (state.active ? state.queue.shift() : null);
      if (!item) break;
      await waitForQuiet();
      if (undoing || (!item.urgent && !state.active)) { requeue(item); break; }
      if (held(item)) continue;
      let outcome;
      try { outcome = await processItem(item); }
      // `state.current` keeps showing the file until the next one starts; the item itself is no longer in work.
      finally { currentItem = null; }
      // Held back for the players: nothing was done yet.
      if (outcome === HELD) continue;
      processed++;
      if (pendingRewrites.size >= REWRITE_BATCH) await flushRewrites();
      await sleep(ITEM_GAP_MS);
    }
  }
  finally {
    try { await flushRewrites(); }
    catch (err) { warn("batched re-pointing failed", err); }
    state.phase = "idle";
    state.current = null;
    currentItem = null;
    flushLibrary();
  }
  // Another GM session took over: stop here, so the auto-start runs again when the role comes back.
  if (!isCoordinator()) state.active = false;
  if (state.active && !state.queue.length && !state.urgent.length) {
    state.active = false;
    if (processed) {
      log("backfill finished", state.run);
      ui.notifications?.info(t("Finished", state.run));
      // The dashboard's "what the world uses" table describes the last scan: refresh it once the run changed outcomes.
      rescanSoon();
    }
  }
}

/**
 * The scan the optimizer runs on its own after a run. Small runs follow each other all session (one dragged image
 * is a run), so it waits until RESCAN_MIN_MS have passed since the last scan.
 */
function rescanSoon() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => { if (!state.active) runScan(); },
    Math.max(0, state.scannedAt + RESCAN_MIN_MS - Date.now()));
}

/** Stay out of the way while this GM or any player is loading (bounded), then wait for an idle slot. */
async function waitForQuiet() {
  for (let i = 0; (i < QUIET_MAX_S) && (globalThis.canvas?.loading || othersBusy()); i++) await sleep(1000);
  await idle();
}

function othersBusy() {
  try { return !!playersBusy(); }
  catch { return false; }
}

/** Returned by processItem for a heavy conversion parked until the players leave. */
const HELD = Symbol("held");

async function processItem(item) {
  const { original } = item;
  currentItem = item;
  state.current = { original, kind: item.kind, progress: 0, urgent: !!item.urgent };
  const entry = getEntry(original);
  let info; // HEAD of the original: {fingerprint, bytes}, null when missing, undefined when not read yet
  if ((entry?.status === "done") && entry.optimized) {
    info = await headInfo(original).catch(() => undefined);
    // Emptied by the cleanup (marked now when the mark was lost): the optimized copy is the file.
    if (info?.bytes === 0) {
      if (!entry.cleaned) await markEmptied([original]);
      return queueRewrite(item, entry.optimized);
    }
    // Missing or unreadable: nothing says the copy is stale.
    if (!info) return queueRewrite(item, entry.optimized);
    // Content again under a name the cleanup emptied: someone put a file there since. Only the exact fingerprint
    // makes it the file that was converted (the mark was wrong); anything else is a new original, never the old
    // copy's. Until that one is converted the entry keeps its mark, so an undo never trades the old copy for it.
    const same = entry.cleaned ? (!!entry.source && (info.fingerprint === entry.source)) : sameOriginal(entry, info);
    if (same) {
      if (entry.cleaned) record({ original, cleaned: undefined });
      else if (entry.source !== info.fingerprint) record({ original, source: info.fingerprint });
      return queueRewrite(item, entry.optimized);
    }
  }
  else if (entry?.status === "skipped") return;
  // A converted original replaced on disk is a new conversion: in review mode it needs approval again.
  if ((entry?.status === "done") && !item.urgent && !mayConvert(original)) {
    state.current = null;
    currentItem = null;
    return toReview(item, info?.fingerprint);
  }
  return convertItem(item, entry, info);
}

/**
 * For re-pointing only: is the file at the original's path still the one that was converted? The fingerprint says
 * so, and so does an equal size: the fingerprint follows the modification time, which a module update, a restored
 * backup or a moved server changes on every file. Uncompressed formats are left out (another file of the same
 * length has the same size). The cleanup never uses this: emptying a file needs the exact fingerprint.
 * @param {{original: string, source?: string, originalBytes?: number}} entry
 * @param {{fingerprint: string, bytes: number|null}} info  HEAD of the original
 * @returns {boolean}
 */
export function sameOriginal(entry, info) {
  if (entry.source && (info.fingerprint === entry.source)) return true;
  if (FIXED_SIZE_EXT.has(extOf(entry.original))) return false;
  return (Number(entry.originalBytes) > 0) && (info.bytes === Number(entry.originalBytes));
}

/**
 * Audio that loops in play: an ambient sound always does, a playlist track when it is set to repeat. A converted
 * loop must keep its exact length, or the loop point ticks. A track that cannot be read counts as a loop.
 */
function loops(refs) {
  return (refs ?? []).some(r => {
    if (r.docName === "AmbientSound") return true;
    if (r.docName !== "PlaylistSound") return false;
    try { return !!foundry.utils.fromUuidSync(r.uuid)?.repeat; }
    catch { return true; }
  });
}

/** This browser cannot convert. Said once per kind, or once in all when the page itself is the reason. */
function notCapable(kind) {
  const insecure = conversionBlocker() === "insecure";
  state.lastError = { reason: insecure ? "insecureContext" : "notCapable" };
  const key = insecure ? "insecure" : kind;
  if (notCapableWarned.has(key)) return;
  notCapableWarned.add(key);
  ui.notifications?.warn(insecure ? t("NotCapableInsecure") : t("NotCapable", { kind: t(`Kind.${kind}`) }));
}

/**
 * @param {object} item
 * @param {object|null} entry
 * @param {{fingerprint: string, bytes: number|null}|null|undefined} info  HEAD of the original already read,
 *   missing (null), or not read yet (undefined)
 */
async function convertItem(item, entry, info) {
  const { original } = item;
  state.phase = "converting";
  if (!(await canConvertKind(item.kind))) return notCapable(item.kind);

  const controller = new AbortController();
  state.abort = controller;
  let stage = "encode";
  let optimized = null;
  // Stall watchdog: armed for the conversion only (the upload has its own timeout), re-armed by every progress report.
  const stalled = new Error("no conversion progress");
  let stall = null;
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(stalled), STALL_MS);
  };
  // Aborted by a pause or a player's arrival: back in line, not counted. A stall is a failure of this file.
  const interrupted = () => controller.signal.aborted && (controller.signal.reason !== stalled);
  try {
    if (info === undefined) info = await headInfo(original);
    if (info === null) return recordMissing(item);
    // Heavy work waits until no player is connected, or until the GM asks for it (runHeavyNow).
    item.heavy = isHeavy(item.kind, info.bytes);
    if (item.heavy && !heavyAllowed.has(original) && playersConnected()) {
      state.heavy.push(item);
      state.current = null;
      currentItem = null;
      return HELD;
    }
    const source = info.fingerprint;

    setCrashMarker(item);
    arm();
    const result = await optimizeUrl(original, {
      kind: item.kind,
      referenceKinds: referenceKinds(item.refs, item.kind),
      loop: (item.kind === "audio") && loops(item.refs),
      // Behind Cloudflare an upload over 100 MB is refused: such a file is skipped ("tooLarge") before it is encoded.
      maxOutputBytes: tunnelLimited() ? TUNNEL_LIMIT_BYTES : undefined,
      signal: controller.signal,
      onProgress: p => {
        arm();
        if (state.current?.original === original) state.current.progress = toProgress(p);
      }
    });
    clearTimeout(stall);
    if (interrupted()) return requeue(item);
    if (controller.signal.aborted) throw stalled;

    const kind = KINDS.includes(result?.kind) ? result.kind : item.kind;
    // A capability skip is about this browser, not the file: never persist it.
    if ((result?.status === "skipped") && (result.reason === "notCapable")) {
      capability.set(item.kind, Promise.resolve(false));
      state.lastError = { reason: "notCapable" };
      return;
    }
    if ((result?.status === "skipped") && (result.reason === "missing")) return recordMissing(item);
    if (result?.status === "skipped") {
      const reason = result.reason ?? "skipped";
      record({ ...CLEAR, original, kind, status: "skipped", reason, attempts: undefined,
        originalBytes: result.originalBytes, source: reason === "noSavings" ? source : undefined });
      state.run.skipped++;
      return;
    }
    if ((result?.status !== "done") || !(result.file instanceof Blob)) {
      throw new Error(result?.reason ?? t("ConvertFailed"));
    }

    state.current.progress = 1;
    // Past this point a pause no longer discards work: the upload and the entry are kept.
    stage = "upload";
    optimized = await storeResult(original, result.file);
    uploadStreak = [];
    // Not written yet: rewriteBatch stores the entries of a whole batch in one library write, right before it
    // re-points their documents. A crash before that only means this file converts again.
    record({
      original, optimized, kind, status: "done", reason: undefined, detail: undefined, refs: undefined,
      attempts: 0, rewritten: false, source, cleaned: undefined,
      sha256: result.sha256, bytes: result.bytes ?? result.file.size, originalBytes: result.originalBytes
    });
    state.run.done++;
  }
  catch (err) {
    if (interrupted()) return requeue(item);
    const before = (entry?.status === "failed" ? entry.attempts : 0) ?? 0;
    const reason = (err === stalled) ? "stalled" : (stage === "encode") ? "encodeError" : "uploadFailed";
    const detail = String(err?.message ?? err ?? t("ConvertFailed"));
    warn(`could not optimize ${original} (attempt ${before + 1}/${MAX_ATTEMPTS})`, err);
    state.lastError = { path: original, reason, detail };
    record({ ...CLEAR, original, kind: item.kind, status: "failed", reason, detail, attempts: before + 1 });
    state.run.failed++;
    if (stage === "upload") uploadFailed(original, before, detail);
  }
  finally {
    clearTimeout(stall);
    clearCrashMarker();
    if (state.abort === controller) state.abort = null;
  }
  // Outside the try: a re-pointing problem must not turn the converted entry into a failure.
  if (optimized) await queueRewrite(item, optimized);
}

/**
 * UPLOAD_BREAKER uploads failing one after another are the server's problem (a full disk, a tunnel that refuses
 * them), not the files': stop the run with one notice instead of encoding the whole queue for nothing, and give
 * those files their attempt back, so the next run tries them again.
 */
function uploadFailed(original, attempts, detail) {
  uploadStreak.push({ original, attempts });
  if (uploadStreak.length < UPLOAD_BREAKER) return;
  for (const f of uploadStreak) record({ original: f.original, attempts: f.attempts });
  uploadStreak = [];
  state.active = false;
  state.pausedByUser = true; // nothing starts it again on its own this session; Start does
  state.lastError = { path: original, reason: "uploadStopped", detail };
  warn(`${UPLOAD_BREAKER} uploads failed in a row: background optimization stopped`);
  ui.notifications?.error(t("UploadStopped", { count: UPLOAD_BREAKER }), { permanent: true });
}

function recordMissing(item) {
  const refs = [...new Set((item.refs ?? []).map(r => r.uuid))].slice(0, MISSING_REFS_MAX);
  record({ ...CLEAR, original: item.original, kind: item.kind, status: "skipped", reason: "missing", attempts: undefined,
    refs: refs.length ? refs : undefined });
  state.run.skipped++;
}

function requeue(item) {
  (item.urgent ? state.urgent : state.queue).unshift(item);
}

/** Urgent items re-point now; the rest wait for the next batch. Never throws. */
async function queueRewrite(item, to) {
  if (!item.urgent) {
    pendingRewrites.set(item.original, { to, refs: item.refs ?? [] });
    return;
  }
  state.phase = "rewriting";
  try {
    // Player requests carry no refs: the uploader assigns the file while it converts, so collect now (world only).
    const refs = item.refs ?? (await collectReferences({ includeCompendia: false })).get(item.original) ?? [];
    await rewriteBatch(new Map([[item.original, { to, refs }]]));
    if (!item.refs) setTimeout(() => recollect(item.original, to), URGENT_RECHECK_MS);
  }
  catch (err) {
    warn(`could not re-point references of ${item.original}`, err);
    state.lastError = { path: item.original, reason: "rewriteFailed", detail: String(err?.message ?? err) };
  }
}

async function flushRewrites() {
  if (!pendingRewrites.size) return;
  const batch = new Map(pendingRewrites);
  pendingRewrites.clear();
  state.phase = "rewriting";
  await rewriteBatch(batch);
}

/**
 * Re-point several originals with one rewriteReferences call (one update per document).
 * An original is re-pointed only when its `done` entry with that optimized path is stored on the server (one
 * library write here covers every entry of the batch that is not) and the copy is there, whole.
 * Protected refs are deferred; an entry is marked `rewritten` only when nothing failed and nothing is pending.
 * @param {Map<string, {to: string, refs: object[], failed?: boolean}>} batch
 */
async function rewriteBatch(batch) {
  const isStored = (original, to) => { const e = getStoredEntry(original); return (e?.status === "done") && (e.optimized === to); };
  if ([...batch].some(([original, b]) => !isStored(original, b.to))) await flushLibrary();

  const map = new Map(), refs = new Map();
  const failedBefore = new Set();
  const unchecked = new Set(); // every reference is in use: nothing to re-point now, so the copy is not asked for
  const broken = [];
  await eachLimited([...batch], HEAD_CONCURRENCY, async ([original, b]) => {
    if (!isStored(original, b.to)) {
      state.lastError = { path: original, reason: "notPersisted" };
      return;
    }
    // Refs still deferred from an earlier pass go along, so the outcome below covers all of them.
    const prior = state.deferred.get(original);
    const merge = prior && (prior !== b) && (prior.to === b.to);
    const list = merge ? [...(b.refs ?? []), ...prior.refs] : (b.refs ?? []);
    if (list.every(protect)) unchecked.add(original);
    else {
      try {
        if (!(await copyIntact(getStoredEntry(original)))) return void broken.push({ original, refs: list });
      }
      catch (err) {
        warn(`could not check the optimized copy of ${original}`, err);
        state.lastError = { path: original, reason: "rewriteFailed", detail: String(err?.message ?? err) };
        return;
      }
    }
    map.set(original, b.to);
    refs.set(original, list);
    if (b.failed || (merge && prior.failed)) failedBefore.add(original);
  });
  if (broken.length) await dropBroken(broken);
  if (!map.size) return;
  let res;
  // References of an unchecked copy all wait, also when their scene or sound stopped being used meanwhile.
  try { res = await rewriteReferences(map, { refs, protect: ref => unchecked.has(ref.from) || protect(ref) }); }
  catch (err) {
    warn("could not re-point references", err);
    res = { deferred: [], failedFrom: [...map.keys()] };
  }
  const failedNow = new Set(res.failedFrom);
  for (const [original, to] of map) {
    const deferred = res.deferred.filter(r => r.from === original);
    const failed = failedNow.has(original) || failedBefore.has(original);
    if (failedNow.has(original)) state.lastError = { path: original, reason: "rewriteFailed" };
    if (deferred.length) state.deferred.set(original, { to, refs: deferred, failed });
    else state.deferred.delete(original);
    const rewritten = !failed && !deferred.length;
    // No-op rewrites (still failing, or already done) must not touch the library.
    if (!!getEntry(original)?.rewritten !== rewritten) record({ original, rewritten });
  }
  await rewritePatterns([...map.keys()].flatMap(original => (refs.get(original) ?? []).filter(r => r.pattern)));
}

/** What a pattern may be: only `*` and `?` as wildcards, in the file name, ending in a literal extension. */
const RICH_PATTERN = /[[\]{}()!#\\]|\*\*/;
const PATTERN_EXT = /\.([a-z0-9]+)$/i;

/**
 * The pattern that picks the optimized copies of everything `pattern` picks, or null while that is not certain: every
 * file it matches has a `done` entry whose original is still the converted file and whose copy is whole, the copies sit
 * next to their originals and share one extension, and the same pattern with that extension lists exactly those copies
 * (so a name that sanitizing changed, or a stray file of the same name, keeps the pattern as it is).
 */
async function patternTarget(pattern) {
  if (RICH_PATTERN.test(pattern) || !PATTERN_EXT.test(pattern) || /[*?]/.test(dirName(pattern))) return null;
  const files = await matchPattern(pattern);
  if (!files?.size) return null;
  const copies = new Set(), exts = new Set();
  for (const path of files) {
    const entry = getStoredEntry(path);
    if ((entry?.status !== "done") || !entry.optimized) return null;
    const copy = normalizePath(entry.optimized);
    if ((copy === path) || (dirName(copy) !== dirName(path))) return null;
    try {
      const info = await headInfo(path);
      // Replaced since it was converted (a conversion is pending), or emptied by the cleanup (the copy is the file).
      const same = !!info && ((info.bytes === 0) || (entry.cleaned ? info.fingerprint === entry.source : sameOriginal(entry, info)));
      if (!same || !(await copyIntact(entry))) return null;
    }
    catch (err) {
      warn(`could not check ${path}`, err);
      return null;
    }
    copies.add(copy);
    exts.add(extOf(copy));
  }
  if (exts.size !== 1) return null;
  const next = pattern.replace(PATTERN_EXT, `.${[...exts][0]}`);
  const found = await matchPattern(next);
  return ((found?.size === copies.size) && [...found].every(p => copies.has(p))) ? next : null;
}

/**
 * Point the prototype tokens that pick random art by a pattern at the optimized copies, once `patternTarget` says every
 * file of the pattern is converted. The old pattern stays in the actor's flag, for undo and self-repair. Never throws;
 * a pattern that cannot move now is tried again by the next scan.
 * @param {object[]} list  Pattern references (`pattern` set)
 */
async function rewritePatterns(list) {
  if (!list.length) return;
  try {
    const targets = new Map(), items = new Map();
    for (const { uuid, pattern } of list) {
      if (!targets.has(pattern)) targets.set(pattern, await patternTarget(pattern));
      const to = targets.get(pattern);
      if (to) items.set(`${uuid}|${pattern}`, { uuid, from: pattern, to });
    }
    if (!items.size) return;
    const res = await setTokenPatterns([...items.values()]);
    if (res.failed) state.lastError = { reason: "rewriteFailed" };
    log("token art patterns re-pointed", res);
  }
  catch (err) { warn("could not re-point token art patterns", err); }
}

/**
 * Put back the original pattern of the prototype tokens whose files just went back to their originals (an undo, a
 * self-repair), from the flag they carry; once per actor, whatever the number of files. An actor keeps its optimized
 * pattern when one of its files could not go back (emptied by the cleanup, or its original is gone): the old pattern
 * would hand tokens an empty file.
 * @param {Map<string, object[]>} refs  The references as they were collected before the undo (copies are the keys)
 * @param {Set<string>} copies  Optimized copies whose documents were pointed back at their originals
 * @param {Set<string>} keep    Originals that stay optimized
 * @returns {Promise<number>} actors restored
 */
async function restorePatterns(refs, copies, keep) {
  try {
    const actors = new Map(); // uuid -> {pattern, hit, originals}
    for (const [key, list] of refs) {
      for (const ref of list) {
        if (!ref.pattern) continue;
        let a = actors.get(ref.uuid);
        if (!a) actors.set(ref.uuid, a = { pattern: ref.pattern, hit: false, originals: new Set() });
        a.originals.add(findByOptimized(key)?.original ?? key);
        if (copies.has(key)) a.hit = true;
      }
    }
    const items = [...actors].filter(([, a]) => a.hit && ![...a.originals].some(o => keep.has(o) || getEntry(o)?.cleaned))
      .map(([uuid, a]) => ({ uuid, from: a.pattern }));
    return items.length ? (await setTokenPatterns(items)).updated : 0;
  }
  catch (err) {
    warn("could not restore token art patterns", err);
    return 0;
  }
}

/**
 * A `done` entry whose copy is missing or cut short maps to nothing: forget it and convert the original again
 * (review mode asks again). Documents that already use the copy are pointed back by the next scan.
 * @param {{original: string, refs: object[]}[]} items
 */
async function dropBroken(items) {
  warn("optimized copies missing or incomplete; their originals convert again", items.map(i => i.original));
  for (const i of items) { state.deferred.delete(i.original); pendingRewrites.delete(i.original); }
  try { await removeEntries(items.map(i => i.original)); }
  catch (err) {
    warn("could not forget the entries of missing copies", err);
    return;
  }
  copiesChecked = false;
  let added = 0;
  for (const i of items) {
    const kind = mediaKind(i.original, i.refs);
    if (kind && addConvert({ type: "convert", original: i.original, kind, refs: i.refs })) added++;
  }
  if (!added) return;
  state.queue = sortQueue(state.queue);
  if (state.active) kick();
  else if (state.scannedAt && autoAllowed()) start().catch(err => warn("backfill start failed", err));
}

/** A player's freshly converted upload: catch a document assigned after the first collection. */
async function recollect(original, to) {
  try {
    if (!isCoordinator() || undoing) return;
    const e = getEntry(original);
    if ((e?.status !== "done") || (e.optimized !== to)) return;
    const refs = (await collectReferences({ includeCompendia: false })).get(original);
    if (!refs?.length || state.urgent.some(i => i.original === original)) return;
    state.urgent.push({ type: "rewrite", original, kind: e.kind, refs, urgent: true });
    kick();
  }
  catch (err) { warn(`could not re-check references of ${original}`, err); }
}

/** Retry deferred references whose scene/sound is no longer in use, in one batch. */
async function processDeferred() {
  if (!isCoordinator() || !state.deferred.size || deferredBusy || undoing) return;
  deferredBusy = true;
  try {
    const batch = new Map();
    for (const [original, d] of state.deferred) {
      const e = getEntry(original);
      if ((e?.status !== "done") || (e.optimized !== d.to)) state.deferred.delete(original);
      else batch.set(original, d);
    }
    if (batch.size) await rewriteBatch(batch);
  }
  catch (err) { warn("deferred re-pointing failed", err); }
  finally { deferredBusy = false; }
}

/**
 * Defer refs that would redraw what someone is looking at or hearing: any scene active or viewed
 * by a connected user, and playlist sounds currently playing.
 */
function protect(ref) {
  if (!getSetting("protectActiveScene")) return false;
  const uuid = String(ref.uuid ?? "");
  if (uuid.startsWith("Compendium.")) return false;
  const scenes = new Set([game.scenes?.active?.id, globalThis.canvas?.scene?.id]);
  for (const u of game.users ?? []) if (u.active && u.viewedScene) scenes.add(u.viewedScene);
  for (const id of scenes) {
    if (!id) continue;
    const prefix = `Scene.${id}`;
    if ((uuid === prefix) || uuid.startsWith(`${prefix}.`)) return true;
  }
  if (uuid.includes(".PlaylistSound.")) {
    try { if (foundry.utils.fromUuidSync(uuid)?.playing) return true; }
    catch { return true; }
  }
  return false;
}

/* -------------------------------------------- */
/*  Queue                                       */
/* -------------------------------------------- */

/** Queue item for a referenced path, or null when there is nothing to do. */
function classify(path, list) {
  if (isOptimizedPath(path) || ALREADY_OPTIMAL.has(extOf(path))) return null;
  const kind = mediaKind(path, list);
  if (!kind) return null;
  const entry = getEntry(path);
  // Done but still referenced: new references appeared or an earlier rewrite was partial.
  if ((entry?.status === "done") && entry.optimized) return { type: "rewrite", original: path, kind, refs: list };
  if (entry?.status === "skipped") return null;
  if ((entry?.status === "failed") && !retryable(entry)) return null;
  return { type: "convert", original: path, kind, refs: list, failed: entry?.status === "failed" };
}

/** Where a referenced file lives, for the scan report. */
export const ORIGINS = ["world", "module", "system", "core", "data", "otherWorld"];
function originOf(path) {
  const parts = path.split("/");
  if (parts[0] === "worlds") return parts[1] === game.world.id ? "world" : "otherWorld";
  if (parts[0] === "modules") return "module";
  if (parts[0] === "systems") return "system";
  if (CORE_PUBLIC_ROOTS.has(parts[0])) return "core";
  return "data";
}

/** What the scan can say about one referenced file. */
export const OUTCOMES = ["optimized", "light", "queued", "review", "skipped", "failed"];
function outcomeOf(path) {
  if (isOptimizedPath(path)) return "optimized";
  const e = getEntry(path);
  if (e?.status === "done") return "queued"; // converted, but this reference still points at the original
  if (ALREADY_OPTIMAL.has(extOf(path))) return "light";
  if (e?.status === "skipped") return "skipped";
  if ((e?.status === "failed") && !retryable(e)) return "failed";
  // Not converted yet: waits for the GM in review mode (until approved) and in "off".
  const mode = getSetting("backfillMode");
  return ((mode === "off") || ((mode === "review") && !isApproved(path))) ? "review" : "queued";
}

const EXAMPLES = 5;

/**
 * Summary of one scan for the dashboard: every referenced file by origin and outcome, the media the scan saw but
 * cannot process (other hosts, SVG), the compendia it does not open (module and system packs, Adventures; every
 * world pack when includeCompendia is off), and how many references this session's self-repair pointed back at
 * originals.
 */
function scanReport(refs, unread) {
  const byOrigin = Object.fromEntries(ORIGINS.map(o => [o, Object.fromEntries(OUTCOMES.map(k => [k, 0]))]));
  for (const path of refs.keys()) {
    // An optimized copy counts where its original lives, wherever the copy itself was stored. When the original is
    // still referenced too, the two are one file, counted once (as the original).
    const original = isOptimizedPath(path) ? findByOptimized(path)?.original : null;
    const elsewhere = original && (original !== path);
    if (elsewhere && refs.has(original)) continue;
    byOrigin[originOf(elsewhere ? original : path)][outcomeOf(path)]++;
  }
  const includeCompendia = !!getSetting("includeCompendia");
  // Module and system packs are never opened, and neither are Adventures (snapshots, re-pointed when imported).
  const unreadPacks = [...(game.packs ?? [])].filter(p => !includeCompendia || (p.metadata?.packageType !== "world")
    || (p.documentName === "Adventure"));
  return {
    at: Date.now(),
    total: refs.size,
    byOrigin,
    external: unread.external.size,
    externalExamples: [...unread.external].slice(0, EXAMPLES),
    vector: unread.vector.size,
    unreadPacks: unreadPacks.length,
    unreadPackDocuments: unreadPacks.reduce((n, p) => n + (p.index?.size ?? 0), 0),
    includeCompendia,
    repaired: state.repaired
  };
}

/**
 * Rewrites first, earlier failures last, then the order players will need the files in (the preload queue:
 * tiers 0–3 by the documents' own paths, see preloadRank), then kind, reference count and name.
 */
function sortQueue(items) {
  let rank = null;
  try { rank = preloadRank(); }
  catch (err) { warn("preload rank unavailable", err); }
  const r = p => rank?.get(p) ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => (a.type === b.type ? 0 : a.type === "rewrite" ? -1 : 1)
    || (Number(!!a.failed) - Number(!!b.failed))
    || (r(a.original) - r(b.original))
    || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || ((b.refs?.length ?? 0) - (a.refs?.length ?? 0))
    || a.original.localeCompare(b.original));
}

/** The preload queue rebuilds shortly after a next-scene/active-scene change; re-rank after it. */
function resortSoon() {
  clearTimeout(resortTimer);
  resortTimer = setTimeout(() => { if (state.queue.length) state.queue = sortQueue(state.queue); }, RESORT_DELAY_MS);
}

/* -------------------------------------------- */
/*  New references (document hooks)             */
/* -------------------------------------------- */

/** Re-point or queue media referenced by documents created or edited mid-session (imports, drags, edits). */
function watchDocuments() {
  for (const name of CONST.ALL_DOCUMENT_TYPES) {
    if (UNWATCHED_DOCUMENTS.has(name)) continue;
    Hooks.on(`create${name}`, (doc, options) => {
      notePackChange(doc);
      if (!options?.[MODULE_ID]?.rewrite) onDocumentChange(doc, true);
    });
    Hooks.on(`update${name}`, (doc, changed, options) => {
      notePackChange(doc);
      if (!options?.[MODULE_ID]?.rewrite && hasMediaValue(changed)) onDocumentChange(doc, false);
    });
    Hooks.on(`delete${name}`, doc => notePackChange(doc, true));
  }
}

/** Debounced per document. Children are walked on create (they fire no hooks of their own then). */
function onDocumentChange(doc, children) {
  if (!doc?.uuid || !isCoordinator()) return;
  if (waitingRequests) touched.add(doc.uuid);
  const prev = pendingDocs.get(doc.uuid);
  if (prev) clearTimeout(prev.timer);
  const next = { doc, children: children || !!prev?.children };
  next.timer = setTimeout(() => {
    pendingDocs.delete(doc.uuid);
    enqueueDocument(next.doc, next.children);
  }, DOC_DEBOUNCE_MS);
  pendingDocs.set(doc.uuid, next);
}

function enqueueDocument(doc, children) {
  if (!isCoordinator() || undoing || !getSetting("mediaEnabled")) return;
  if (doc.pack && !getSetting("includeCompendia")) return;
  let refs;
  try { refs = collectDocumentReferences(doc, { children }); }
  catch (err) { warn(`could not scan ${doc.uuid}`, err); return; }
  // Wildcard token art names no file here: its files are listed by the next scan.
  for (const key of [...refs.keys()]) if (isPatternKey(key)) refs.delete(key);
  if (known) for (const path of refs.keys()) known.add(path);
  if (getSetting("backfillMode") === "off") return;
  let rewrites = 0, converts = 0;
  for (const [path, list] of refs) {
    const item = classify(path, list);
    if (!item) continue;
    if (item.type === "rewrite") {
      state.urgent.push({ ...item, urgent: true });
      rewrites++;
    }
    else if (addConvert(item)) converts++;
  }
  if (converts) state.queue = sortQueue(state.queue);
  if (rewrites || (converts && state.active)) kick();
  // Converting needs the full session scan first; the auto-start does it when it has not run yet.
  else if (converts && state.scannedAt && autoAllowed()) {
    start().catch(err => warn("backfill start failed", err));
  }
}

/**
 * A conversion found outside the scan (a document hook, a copy that went missing): into the queue, or into the
 * review list while it is not approved. Returns whether it was queued; the caller sorts the queue.
 */
function addConvert(item) {
  const mode = getSetting("backfillMode");
  if (mode === "off") return false;
  const existing = [currentItem, ...state.urgent, ...state.queue, ...state.review, ...state.heavy]
    .find(i => i?.original === item.original);
  if (existing) {
    existing.refs?.push(...(item.refs ?? []));
    return false;
  }
  if ((mode === "review") && !isApproved(item.original)) {
    state.review.push(item);
    return false;
  }
  state.queue.push(item);
  return true;
}

function hasMediaValue(value, depth = 0) {
  if (typeof value === "string") return MEDIA_EXT.has(extOf(value.trim())) || /<(?:img|video|audio|source)\b|\]\(/i.test(value);
  if (!value || (typeof value !== "object") || (depth > 8)) return false;
  return Object.values(value).some(v => hasMediaValue(v, depth + 1));
}

/* -------------------------------------------- */
/*  Crash marker                                */
/* -------------------------------------------- */

/** A renderer crash skips every finally: the marker left behind says which file to blame. */
function setCrashMarker(item) {
  try { localStorage.setItem(CRASH_KEY, JSON.stringify({ world: game.world?.id, original: item.original, kind: item.kind })); }
  catch { /* storage unavailable */ }
}

function clearCrashMarker() {
  try { localStorage.removeItem(CRASH_KEY); }
  catch { /* storage unavailable */ }
}

async function recordInterrupted() {
  let marker = null;
  try { marker = JSON.parse(localStorage.getItem(CRASH_KEY) ?? "null"); }
  catch { return; }
  if (!marker || (marker.world !== game.world?.id)) return;
  clearCrashMarker();
  const original = normalizePath(marker.original);
  if (!original) return;
  const prev = getEntry(original);
  const attempts = ((prev?.status === "failed" ? prev.attempts : 0) ?? 0) + 1;
  // Final after one attempt (see retryable): only "Try again" in the dashboard converts it again.
  warn(`the conversion of ${original} was interrupted; it will not be tried again on its own`);
  await record({ ...CLEAR, original, kind: KINDS.includes(marker.kind) ? marker.kind : prev?.kind, status: "failed",
    reason: "interrupted", attempts }, { durable: true });
}

/* -------------------------------------------- */
/*  Storage                                     */
/* -------------------------------------------- */

/**
 * Upload the optimized file into the output location (same folder, or the mirror for read-only places)
 * and return its normalized path. The name carries the content's hash, so a file already there under that name is
 * the same file, but only when it is whole: an upload cut short (a full disk) leaves the name too. Hence the sizes:
 * an existing file is reused only at the expected size, and a new one is checked after the upload.
 */
async function storeResult(original, file) {
  const { dir } = outputLocation(original);
  const target = dir ? `${dir}/${file.name}` : file.name;
  // Asked past the CDN: a "not found" cached at the edge would be served to players after the upload.
  const existing = await headInfo(target, { fresh: true }).catch(() => null);
  if (existing?.bytes === file.size) return normalizePath(target);
  await ensureDirectory(dir);
  // The name carries the .of- marker, so the upload hook passes it through untouched.
  const upload = FP().upload("data", encodeSegments(dir), file, {}, { notify: false });
  const response = await withTimeout(upload, UPLOAD_TIMEOUT_MS + (file.size / UPLOAD_MIN_BYTES_PER_SEC) * 1000, t("UploadTimeout"));
  if (!response?.path) throw new Error(t("UploadFailed"));
  const stored = normalizePath(response.path);
  const whole = info => !!info && ((info.bytes === null) || (info.bytes === file.size));
  // `bytes` is null when a proxy hides the stored size; then the server's answer to the upload is all there is.
  if (!whole(await headInfo(stored)) && !whole(await headInfo(stored, { fresh: true }))) throw new Error(t("UploadIncomplete"));
  return stored;
}

/** The promise's result, or a rejection after `ms`: a server that never answers must not hang the worker. */
function withTimeout(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Run `fn` over the items, at most `limit` at a time. `fn` must not throw. */
async function eachLimited(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * HEAD the file: `{fingerprint, bytes}`, null on 404/410; throws otherwise. Foundry serves Data with
 * express.static, which sends the ETag, Last-Modified and the length.
 * `bytes` is the stored file's size, or null when the answer cannot tell it: no length, or a proxy that re-encodes
 * what it serves (Content-Encoding, Cloudflare Polish).
 * @param {string} path
 * @param {{fresh?: boolean}} [options]  fresh: add a one-off query so a CDN asks the server instead of answering
 *   from its cache (only where a stale answer would mislead; behind a caching CDN it makes the edge fetch the file).
 * @returns {Promise<{fingerprint: string, bytes: number|null}|null>}
 */
export async function headInfo(path, { fresh = false } = {}) {
  let url = toFetchUrl(path);
  if (fresh) url += `${url.includes("?") ? "&" : "?"}of-fresh=${Date.now().toString(36)}`;
  const res = await fetch(url, { method: "HEAD", cache: "no-store" });
  if ((res.status === 404) || (res.status === 410)) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = res.headers.get("content-length");
  const exact = (len !== null) && !res.headers.get("content-encoding") && !res.headers.get("cf-polished");
  return { fingerprint: fingerprintOf(res.headers), bytes: exact ? Number(len) : null };
}

/** Record originals found at 0 bytes as emptied (a cleanup whose mark was lost). */
export async function markEmptied(originals) {
  await putEntries(originals.map(original => ({ original, cleaned: Date.now() })), { now: true })
    .catch(err => warn("could not mark emptied originals", err));
}

/**
 * Exclusive section for the cleanup: false while an undo runs. While it is held, undo() refuses to start.
 * @returns {boolean}
 */
export function beginCleanup() {
  if (undoing || cleaning) return false;
  cleaning = true;
  return true;
}

export function endCleanup() {
  cleaning = false;
}

/** The `source` fingerprint stored with a converted entry, from a HEAD response's headers. */
export function fingerprintOf(h) {
  return h.get("etag") || [h.get("last-modified"), h.get("content-length")].filter(Boolean).join("|") || "present";
}

/**
 * Persist a partial entry (merged field by field by the library). Only `durable` writes are awaited; the others
 * ride the library's batched write (rewriteBatch stores `done` entries before it re-points to them). Returns
 * whether it was stored.
 */
async function record(partial, { durable = false } = {}) {
  const entry = { ...partial, original: normalizePath(partial.original) };
  if (!durable) {
    putEntries(entry).catch(err => warn("could not persist library entry", err));
    return true;
  }
  try {
    await putEntries(entry, { now: true });
    return true;
  }
  catch (err) {
    warn("could not persist library entry", err);
    return false;
  }
}

/* -------------------------------------------- */
/*  Socket handlers (coordinator)               */
/* -------------------------------------------- */

/**
 * A player whose browser cannot convert uploaded an original and asks for its conversion.
 * A file no document used before is that new upload: it runs at once, whatever the mode, like every upload.
 * A path the documents already use is an existing file, which a request must not push past the game master's
 * choices: it stays where the scan put it (the review list, the queue behind the pause, or nowhere when existing
 * files are off). Exported for the tests.
 * @returns {Promise<{queued: boolean}|undefined>} queued: the conversion runs on this request
 */
export async function onConvertRequest(payload, fromUserId) {
  if (!isCoordinator()) return undefined;
  if (!getSetting("optimizeUploads")) return { queued: false };
  const user = game.users.get(fromUserId);
  if (!user?.can?.("FILES_UPLOAD")) return { queued: false };
  const original = normalizePath(payload?.path);
  if (!original || /^[a-z][a-z0-9+.-]*:/i.test(original) || isOptimizedPath(original)) return { queued: false };
  if (ALREADY_OPTIMAL.has(extOf(original))) return { queued: false };
  const kind = mediaKind(original, null);
  if (!kind) return { queued: false };
  const final = e => !!e && ((e.status !== "failed") || (e.reason === "interrupted"));
  if (final(getEntry(original))) return { queued: false };

  const used = await usedBefore(original);
  if (used) {
    // Read just now (no scan ran yet this session): sorted the way a document hook would sort it.
    const item = Array.isArray(used) ? classify(original, used) : null;
    if ((item?.type === "convert") && addConvert(item)) state.queue = sortQueue(state.queue);
    return { queued: false };
  }
  // The world may have been read meanwhile: look again.
  if (final(getEntry(original))) return { queued: false };
  const waiting = i => i?.urgent && (i.original === original);
  if (state.urgent.some(waiting) || state.heavy.some(waiting) || waiting(currentItem)) return { queued: true };
  // refs: null -> collected after conversion, when the uploader has assigned the file to a document.
  state.urgent.push({ type: "convert", original, kind, refs: null, urgent: true });
  kick();
  return { queued: true };
}

/**
 * Did documents use this path before the request arrived? Answered from the paths the last read and the document
 * hooks saw. Before the session's first read the world is read now, leaving out the documents that changed while it
 * was read: that is the uploader giving the new file to a document, which must not make it an existing file.
 * @returns {Promise<false|true|object[]>} the references, when they were read for this request
 */
async function usedBefore(original) {
  if (known) return known.has(original);
  waitingRequests++;
  try {
    const { refs } = await (indexing ??= collect(false).finally(() => { indexing = null; }));
    const changed = uuid => [...touched].some(t => (uuid === t) || String(uuid).startsWith(`${t}.`));
    const before = (refs.get(original) ?? []).filter(r => !changed(r.uuid));
    return before.length ? before : false;
  }
  finally {
    if (!--waitingRequests) touched.clear();
  }
}

/**
 * A browser converted its own upload and registers the result. Such an entry is keyed by the stored optimized path
 * itself (`original === optimized`: no original exists on the server), the only shape the upload hook sends.
 * Anything else is refused: a player could otherwise map an existing world file to a file of their own, and the
 * cleanup would offer to empty it. An entry that exists is never replaced either: its hash is what players check
 * the files they share against. Nothing references the file yet, so the write is batched. Exported for the tests.
 * @returns {Promise<boolean|undefined>}
 */
export async function onRegisterOptimized(payload, fromUserId) {
  if (!isCoordinator()) return undefined;
  const user = game.users.get(fromUserId);
  if (!user?.can?.("FILES_UPLOAD")) return false;
  const optimized = normalizePath(payload?.optimized);
  const kind = payload?.kind;
  if (!optimized || (normalizePath(payload?.original) !== optimized)) return false;
  if (!isOptimizedPath(optimized) || !KINDS.includes(kind)) return false;
  if (getEntry(optimized) || findByOptimized(optimized)) return false;
  const num = v => (Number.isFinite(v) && (v >= 0) ? v : undefined);
  return record({
    original: optimized, optimized, kind, status: "done", attempts: 0, rewritten: true,
    sha256: /^[0-9a-f]{64}$/i.test(payload?.sha256 ?? "") ? payload.sha256.toLowerCase() : undefined,
    bytes: num(payload?.bytes), originalBytes: num(payload?.originalBytes),
    uploadedName: String(payload?.uploadedName ?? "").slice(0, 255) || undefined
  });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function mediaKind(path, refs) {
  const ext = extOf(path);
  const image = EXT.image.includes(ext), video = EXT.video.includes(ext), audio = EXT.audio.includes(ext);
  if (image) return "image";
  if (video && audio) return (refs?.length && refs.every(r => r.kind === "audio")) ? "audio" : "video"; // webm
  if (video) return "video";
  if (audio) return "audio";
  return null;
}

/** Field kinds that will consume the output. HTML, Markdown and untyped strings count as the most restrictive kind. */
function referenceKinds(refs, kind) {
  const set = new Set();
  for (const r of refs ?? []) set.add(["image", "texture", "video", "audio"].includes(r.kind) ? r.kind : kind);
  if (!set.size) set.add(kind);
  return set;
}

function canConvertKind(kind) {
  if (!capability.has(kind)) {
    capability.set(kind, Promise.resolve().then(() => canConvert(kind)).then(Boolean, () => false));
  }
  return capability.get(kind);
}

function toProgress(p) {
  let v = p;
  if (p && typeof p === "object") v = p.progress ?? p.ratio ?? (p.total ? p.done / p.total : undefined);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : (state.current?.progress ?? 0);
}
