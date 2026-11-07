import { MODULE_ID, EXT, MIRROR_ROOT, log, warn, extOf, isOptimizedPath } from "../constants.mjs";
import { getSetting, setSetting } from "../settings.mjs";
import { on, MSG, isCoordinator } from "../socket.mjs";
import { getEntry, getLibrary, putEntries, removeEntries, flushLibrary, normalizePath, findByOptimized, isApproved, forgetApproved } from "../library.mjs";
import { collectReferences, collectDocumentReferences, rewriteReferences } from "./references.mjs";
import { optimizeUrl, canConvert } from "./converter.mjs";
import { outputLocation, ensureDirectory, encodeSegments, toFetchUrl, CORE_PUBLIC_ROOTS } from "./naming.mjs";
import { playersBusy } from "../net/scheduler.mjs";
import { preloadRank } from "../net/preload.mjs";

/**
 * Background optimization of existing world media, run by the coordinating GM session only.
 * One item at a time: check the original -> convert -> upload next to it (or the mirror) -> persist -> re-point.
 * Re-pointing is batched (one update per document per batch); player requests and new references run at once.
 */

const MAX_ATTEMPTS = 3;
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
  refs: undefined, detail: undefined };

const state = {
  active: false,          // the backfill should be working through the queue
  pausedByUser: false,
  phase: "idle",
  current: null,          // {original, kind, progress, urgent}
  queue: [],              // items from the last scan (plus new references found by the document hooks)
  review: [],             // review mode: conversions waiting for the GM's approval (dashboard)
  urgent: [],             // player convert requests and new references to converted files, run even while paused
  deferred: new Map(),    // original -> {to, refs, failed}
  lastError: null,        // {path?, reason, detail?}
  scannedAt: 0,
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
let currentItem = null;
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
    watchDocuments();
    setInterval(() => { if (state.deferred.size) processDeferred(); }, DEFERRED_RECHECK_MS);
    scheduleAutoStart(AUTO_START_MS);
  }
  catch (err) {
    warn("background optimization failed to initialize", err);
  }
}

/**
 * Collect references and rebuild the queue. Coordinator only, and only while media optimization is on.
 * @returns {Promise<{paths: number, convert: number, rewrite: number, kinds: {image: number, audio: number, video: number}}|null>}
 */
export function scan() {
  if (!isCoordinator() || !getSetting("mediaEnabled")) return Promise.resolve(null);
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      await recordInterrupted();
      const unread = { external: new Set(), vector: new Set() };
      const refs = await collectReferences({ includeCompendia: !!getSetting("includeCompendia"), unread });
      const items = [];
      for (const [path, list] of refs) {
        if (state.deferred.has(path) || pendingRewrites.has(path) || (state.current?.original === path)) continue;
        const item = classify(path, list);
        if (item) items.push(item);
      }
      const { queue, review } = splitForReview(items);
      state.queue = sortQueue(queue);
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
  if (!state.queue.length || !state.scannedAt) await scan();
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

/** Approvals are only needed until the original has a final library entry. */
function pruneApproved() {
  writeApprovals(list => list.filter(p => {
    const e = getEntry(p);
    return !e || ((e.status === "failed") && ((e.attempts ?? 0) < MAX_ATTEMPTS));
  })).catch(err => warn("could not prune approvals", err));
}

/** May this original be converted now? Always in auto mode; in review mode once the GM approved it. */
function mayConvert(path) {
  const mode = getSetting("backfillMode");
  return (mode === "auto") || ((mode === "review") && isApproved(path));
}

/** Back to the review list (review mode only; "off" just drops it). */
function toReview(item) {
  if ((getSetting("backfillMode") === "review") && !state.review.some(i => i.original === item.original)) {
    state.review.push({ ...item, type: "convert", urgent: false });
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
  await scan();
  scheduleAutoStart(5000);
}

/** Conversions waiting for the GM in review mode: original, kind and the uuids of the documents that use it. */
export function reviewList() {
  // A player's request may have converted one meanwhile.
  state.review = state.review.filter(i => { const e = getEntry(i.original); return !e || (e.status === "failed"); });
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
    mode: getSetting("backfillMode"),
    waitingWelcome: !getSetting("welcomeDone"),
    run: { ...state.run },
    deferred: state.deferred.size,
    lastError: state.lastError ? { ...state.lastError } : undefined
  };
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
    const keys = originals ? [...new Set([].concat(originals).map(normalizePath))] : Object.keys(lib);
    const map = new Map(); // optimized -> original
    const kept = [];
    const emptied = [];
    for (const key of keys) {
      const entry = lib[key];
      if ((entry?.status !== "done") || !entry.optimized) continue;
      // Client-converted uploads (original === optimized) have no original to go back to.
      if (normalizePath(entry.optimized) === key) continue;
      // The cleanup emptied this original: the file still exists, but its content is gone.
      if (entry.cleaned) { kept.push(key); continue; }
      const info = await headInfo(key).catch(() => null);
      if (!info) { kept.push(key); continue; }
      // Empty without the mark (a cleanup that could not record it): never point documents at it.
      if (info.bytes === 0) { kept.push(key); emptied.push(key); continue; }
      map.set(normalizePath(entry.optimized), key);
    }

    // Nothing may re-point these to the optimized copy while (or after) they are reverted.
    const undone = new Set(map.values());
    for (const k of undone) { state.deferred.delete(k); pendingRewrites.delete(k); }
    state.queue = state.queue.filter(i => !undone.has(i.original));
    state.urgent = state.urgent.filter(i => !undone.has(i.original));

    let res = { updated: 0, failed: 0, failedFrom: [] };
    if (map.size) {
      state.phase = "rewriting";
      try {
        const refs = await collectReferences({ includeCompendia: !!getSetting("includeCompendia") });
        res = await rewriteReferences(map, { refs, protect: () => false });
      }
      catch (err) {
        warn("undo failed", err);
        res = { updated: 0, failed: map.size, failedFrom: [...map.keys()] };
      }
      finally { state.phase = "idle"; }
    }
    const failed = new Set(res.failedFrom);
    const restored = [];
    for (const [optimized, original] of map) (failed.has(optimized) ? kept : restored).push(original);
    if (restored.length) {
      try {
        await putEntries(restored.map(original => ({ original, status: "skipped", reason: "restored", rewritten: false,
          detail: undefined })), { now: true });
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
  if (refreshReport && !wasActive) scan(); // start() scans when it restarts
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
  await scan();
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
    if (getSetting("mediaEnabled") && (getSetting("backfillMode") !== "off") && getSetting("welcomeDone") && !state.scannedAt) scan();
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
      await processItem(item);
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
      scan();
    }
  }
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

async function processItem(item) {
  const { original } = item;
  currentItem = item;
  state.current = { original, kind: item.kind, progress: 0, urgent: !!item.urgent };
  const entry = getEntry(original);
  let source;
  if ((entry?.status === "done") && entry.optimized) {
    // An emptied original has no content left: the optimized copy is the file now.
    if (entry.cleaned) return queueRewrite(item, entry.optimized);
    // A replaced original (same name, new bytes) must not be re-pointed to the stale copy.
    const info = await headInfo(original).catch(() => undefined);
    source = info === undefined ? undefined : (info?.fingerprint ?? null);
    if (info?.bytes === 0) {
      await markEmptied([original]);
      return queueRewrite(item, entry.optimized);
    }
    const unchanged = entry.source && (source === entry.source);
    if (unchanged || (source === null) || (source === undefined)) return queueRewrite(item, entry.optimized);
  }
  else if (entry?.status === "skipped") return;
  // A converted original replaced on disk is a new conversion: in review mode it needs approval again.
  if ((entry?.status === "done") && !item.urgent && !mayConvert(original)) {
    state.current = null;
    currentItem = null;
    return toReview(item);
  }
  return convertItem(item, entry, source);
}

/**
 * @param {object} item
 * @param {object|null} entry
 * @param {string|null|undefined} source  Fingerprint already read (string), missing (null), or unknown (undefined)
 */
async function convertItem(item, entry, source) {
  const { original } = item;
  state.phase = "converting";
  if (!(await canConvertKind(item.kind))) {
    state.lastError = { reason: "notCapable" };
    if (!notCapableWarned.has(item.kind)) {
      notCapableWarned.add(item.kind);
      ui.notifications?.warn(t("NotCapable", { kind: t(`Kind.${item.kind}`) }));
    }
    return;
  }

  const controller = new AbortController();
  state.abort = controller;
  let stage = "encode";
  let optimized = null;
  try {
    if (source === undefined) source = await urlExists(original);
    if (source === null) return recordMissing(item);

    setCrashMarker(item);
    const result = await optimizeUrl(original, {
      kind: item.kind,
      referenceKinds: referenceKinds(item.refs, item.kind),
      signal: controller.signal,
      onProgress: p => { if (state.current?.original === original) state.current.progress = toProgress(p); }
    });
    if (controller.signal.aborted) return requeue(item);

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
    await record({
      original, optimized, kind, status: "done", reason: undefined, detail: undefined, refs: undefined,
      attempts: 0, rewritten: false, source,
      sha256: result.sha256, bytes: result.bytes ?? result.file.size, originalBytes: result.originalBytes
    }, { durable: true });
    state.run.done++;
  }
  catch (err) {
    if (controller.signal.aborted) return requeue(item);
    const attempts = ((entry?.status === "failed" ? entry.attempts : 0) ?? 0) + 1;
    const reason = stage === "encode" ? "encodeError" : "uploadFailed";
    const detail = String(err?.message ?? err ?? t("ConvertFailed"));
    warn(`could not optimize ${original} (attempt ${attempts}/${MAX_ATTEMPTS})`, err);
    state.lastError = { path: original, reason, detail };
    record({ ...CLEAR, original, kind: item.kind, status: "failed", reason, detail, attempts });
    state.run.failed++;
  }
  finally {
    clearCrashMarker();
    if (state.abort === controller) state.abort = null;
  }
  // Outside the try: a re-pointing problem must not turn the converted entry into a failure.
  if (optimized) await queueRewrite(item, optimized);
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
 * An original is re-pointed only when its `done` entry with that optimized path is persisted.
 * Protected refs are deferred; an entry is marked `rewritten` only when nothing failed and nothing is pending.
 * @param {Map<string, {to: string, refs: object[], failed?: boolean}>} batch
 */
async function rewriteBatch(batch) {
  const map = new Map(), refs = new Map();
  const failedBefore = new Set();
  for (const [original, b] of batch) {
    const e = getEntry(original);
    if ((e?.status !== "done") || (e.optimized !== b.to)) {
      state.lastError = { path: original, reason: "notPersisted" };
      continue;
    }
    map.set(original, b.to);
    // Refs still deferred from an earlier pass go along, so the outcome below covers all of them.
    const prior = state.deferred.get(original);
    const merge = prior && (prior !== b) && (prior.to === b.to);
    refs.set(original, merge ? [...(b.refs ?? []), ...prior.refs] : (b.refs ?? []));
    if (b.failed || (merge && prior.failed)) failedBefore.add(original);
  }
  if (!map.size) return;
  let res;
  try { res = await rewriteReferences(map, { refs, protect }); }
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
  if ((entry?.status === "failed") && ((entry.attempts ?? 0) >= MAX_ATTEMPTS)) return null;
  return { type: "convert", original: path, kind, refs: list, failed: entry?.status === "failed" };
}

/** Where a referenced file lives, for the scan report. Mirrored copies count where their original lives. */
export const ORIGINS = ["world", "module", "system", "core", "data", "otherWorld"];
function originOf(path) {
  const parts = path.split("/");
  if (parts[0] === MIRROR_ROOT && parts.length > 2) return originOf(parts.slice(1).join("/"));
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
  if ((e?.status === "failed") && ((e.attempts ?? 0) >= MAX_ATTEMPTS)) return "failed";
  // Not converted yet: waits for the GM in review mode (until approved) and in "off".
  const mode = getSetting("backfillMode");
  return ((mode === "off") || ((mode === "review") && !isApproved(path))) ? "review" : "queued";
}

const EXAMPLES = 5;

/**
 * Summary of one scan for the dashboard: every referenced file by origin and outcome, the media the scan saw but
 * cannot process (other hosts, SVG), and the compendia it does not open (module and system packs; world packs too
 * when includeCompendia is off).
 */
function scanReport(refs, unread) {
  const byOrigin = Object.fromEntries(ORIGINS.map(o => [o, Object.fromEntries(OUTCOMES.map(k => [k, 0]))]));
  for (const path of refs.keys()) {
    // An optimized copy whose original is still referenced too is one file, counted once (as its original).
    if (isOptimizedPath(path) && refs.has(findByOptimized(path)?.original)) continue;
    byOrigin[originOf(path)][outcomeOf(path)]++;
  }
  const includeCompendia = !!getSetting("includeCompendia");
  const packs = [...(game.packs ?? [])].filter(p => !includeCompendia || (p.metadata?.packageType !== "world"));
  return {
    at: Date.now(),
    total: refs.size,
    byOrigin,
    external: unread.external.size,
    externalExamples: [...unread.external].slice(0, EXAMPLES),
    vector: unread.vector.size,
    unreadPacks: packs.length,
    unreadPackDocuments: packs.reduce((n, p) => n + (p.index?.size ?? 0), 0),
    includeCompendia
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
      if (!options?.[MODULE_ID]?.rewrite) onDocumentChange(doc, true);
    });
    Hooks.on(`update${name}`, (doc, changed, options) => {
      if (!options?.[MODULE_ID]?.rewrite && hasMediaValue(changed)) onDocumentChange(doc, false);
    });
  }
}

/** Debounced per document. Children are walked on create (they fire no hooks of their own then). */
function onDocumentChange(doc, children) {
  if (!doc?.uuid || !isCoordinator()) return;
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
  const mode = getSetting("backfillMode");
  if (mode === "off") return;
  if (doc.pack && !getSetting("includeCompendia")) return;
  let refs;
  try { refs = collectDocumentReferences(doc, { children }); }
  catch (err) { warn(`could not scan ${doc.uuid}`, err); return; }
  let rewrites = 0, converts = 0;
  for (const [path, list] of refs) {
    const item = classify(path, list);
    if (!item) continue;
    if (item.type === "rewrite") {
      state.urgent.push({ ...item, urgent: true });
      rewrites++;
      continue;
    }
    const existing = [currentItem, ...state.urgent, ...state.queue, ...state.review].find(i => i?.original === path);
    if (existing) { existing.refs?.push(...list); continue; }
    if ((mode === "review") && !isApproved(path)) { state.review.push(item); continue; }
    state.queue.push(item);
    converts++;
  }
  if (converts) state.queue = sortQueue(state.queue);
  if (rewrites || (converts && state.active)) kick();
  // Converting needs the full session scan first; the auto-start does it when it has not run yet.
  else if (converts && state.scannedAt && autoAllowed()) {
    start().catch(err => warn("backfill start failed", err));
  }
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
  warn(`the conversion of ${original} was interrupted (attempt ${attempts}/${MAX_ATTEMPTS})`);
  await record({ ...CLEAR, original, kind: KINDS.includes(marker.kind) ? marker.kind : prev?.kind, status: "failed",
    reason: "interrupted", attempts }, { durable: true });
}

/* -------------------------------------------- */
/*  Storage                                     */
/* -------------------------------------------- */

/**
 * Upload the optimized file into the output location (same folder, or the mirror for read-only places)
 * and return its normalized path. Content-hashed names make an existing file with that name identical.
 */
async function storeResult(original, file) {
  const { dir } = outputLocation(original);
  const target = dir ? `${dir}/${file.name}` : file.name;
  if (await urlExists(target).catch(() => null)) return normalizePath(target);
  await ensureDirectory(dir);
  // The name carries the .of- marker, so the upload hook passes it through untouched.
  const response = await FP().upload("data", encodeSegments(dir), file, {}, { notify: false });
  if (!response?.path) throw new Error(t("UploadFailed"));
  return normalizePath(response.path);
}

/**
 * HEAD the file. Returns its fingerprint (ETag, or Last-Modified|length), null on 404/410; throws otherwise.
 * Foundry serves Data with express.static, which sends both headers.
 */
async function urlExists(path) {
  return (await headInfo(path))?.fingerprint ?? null;
}

/** HEAD the file: `{fingerprint, bytes}` (bytes null when not sent), null on 404/410; throws otherwise. */
async function headInfo(path) {
  const res = await fetch(toFetchUrl(path), { method: "HEAD", cache: "no-store" });
  if ((res.status === 404) || (res.status === 410)) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = res.headers.get("content-length");
  return { fingerprint: fingerprintOf(res.headers), bytes: len === null ? null : Number(len) };
}

/** Record originals found at 0 bytes as emptied (a cleanup whose mark was lost). */
async function markEmptied(originals) {
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
 * Persist a partial entry (merged field by field by the library). Only `durable` writes are awaited:
 * a `done` entry must be stored before references are re-pointed to it. Returns whether it was stored.
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

function onConvertRequest(payload, fromUserId) {
  if (!isCoordinator()) return undefined;
  if (!getSetting("optimizeUploads")) return { queued: false };
  const user = game.users.get(fromUserId);
  if (!user?.can?.("FILES_UPLOAD")) return { queued: false };
  const original = normalizePath(payload?.path);
  if (!original || /^[a-z][a-z0-9+.-]*:/i.test(original) || isOptimizedPath(original)) return { queued: false };
  if (ALREADY_OPTIMAL.has(extOf(original))) return { queued: false };
  const kind = mediaKind(original, null);
  if (!kind) return { queued: false };
  const entry = getEntry(original);
  if (entry && (entry.status !== "failed")) return { queued: false };
  if (state.urgent.some(i => i.original === original) || (state.current?.original === original)) return { queued: true };
  state.queue = state.queue.filter(i => i.original !== original);
  state.review = state.review.filter(i => i.original !== original);
  // refs: null -> collected after conversion, when the uploader has assigned the file to a document.
  state.urgent.push({ type: "convert", original, kind, refs: null, urgent: true });
  kick();
  return { queued: true };
}

async function onRegisterOptimized(payload, fromUserId) {
  if (!isCoordinator()) return undefined;
  const user = game.users.get(fromUserId);
  if (!user?.can?.("FILES_UPLOAD")) return false;
  const original = normalizePath(payload?.original);
  const optimized = normalizePath(payload?.optimized);
  const kind = payload?.kind;
  if (!original || !optimized || !isOptimizedPath(optimized) || !KINDS.includes(kind)) return false;
  // Uploads converted by the player are keyed by their own stored path (no original exists on the server).
  const upload = original === optimized;
  if (!upload && (getEntry(original)?.status === "done")) return false;
  const num = v => (Number.isFinite(v) && (v >= 0) ? v : undefined);
  return record({
    original, optimized, kind, status: "done", reason: undefined, attempts: 0, rewritten: true,
    sha256: /^[0-9a-f]{64}$/i.test(payload?.sha256 ?? "") ? payload.sha256.toLowerCase() : undefined,
    bytes: num(payload?.bytes), originalBytes: num(payload?.originalBytes),
    ...(upload ? { uploadedName: String(payload?.uploadedName ?? "").slice(0, 255) || undefined } : {})
  }, { durable: true });
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
