import { OUTPUT, warn } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { normalizePath } from "../library.mjs";
import { REASON, LOOP_BUFFER_SECONDS, kindFromName, skipByName, sameLoopLength, clamp } from "./formats.mjs";
import { baseName, optimizedName, toFetchUrl } from "./naming.mjs";

/**
 * Page side of the converter. The conversion itself runs in a module worker (converter-worker.mjs), so a large map
 * or a long encode never blocks the canvas; this file keeps what needs the page: Foundry settings and routes,
 * naming the output, and the loop check (decodeAudioData does not exist in workers). There is no in-page
 * conversion: a browser without module workers or the encoders simply cannot convert.
 *
 * @typedef {object} OptimizeResult
 * @property {"done"|"skipped"|"failed"} status
 * @property {"image"|"video"|"audio"|null} kind  Output kind when done ("video" for an animated GIF turned WebM),
 *                                                  source kind otherwise
 * @property {File} [file]          Optimized file, named `<stem>.of-<hash8>.<ext>` (status "done" only)
 * @property {string} [sha256]      Hex SHA-256 of `file`
 * @property {number} [bytes]       Size of `file` (also set on "noSavings" skips, for reporting)
 * @property {number} originalBytes
 * @property {string} [reason]      REASON code, or the error message for failures
 *
 * Aborting through `signal` rejects with the signal's AbortError instead of resolving.
 *
 * @typedef {object} OptimizeOptions
 * @property {"image"|"video"|"audio"} [kind]  Decided from the references (an audio-only use of a .webm)
 * @property {Set<string>} [referenceKinds]    Field kinds that will show the output (animated GIF/APNG)
 * @property {AbortSignal} [signal]            Aborting terminates the worker: the conversion stops at once
 * @property {(pct: number) => void} [onProgress]
 * @property {boolean} [loop]                  The sound is looped: skip (`loopLength`) unless the output decodes to
 *                                             the length of the source
 * @property {number} [maxOutputBytes]         Skip (`tooLarge`), before encoding, when the predicted output is bigger
 */

const WORKER_URL = new URL("./converter-worker.mjs", import.meta.url);
/** decodeAudioData resamples to its context's rate; a low one keeps the decoded loops small while they are compared. */
const LOOP_PROBE_RATE = 8000;

/* -------------------------------------------- */
/*  Workers                                     */
/* -------------------------------------------- */

/**
 * The warm worker `{worker, busy}`: kept between conversions so its code (and Mediabunny, once loaded) stays ready.
 * A call that arrives while it is busy (an upload during a background conversion) gets a worker of its own, which
 * ends with that call.
 */
let warm = null;

function acquire() {
  if ( warm && !warm.busy ) {
    warm.busy = true;
    return warm;
  }
  const slot = { worker: new Worker(WORKER_URL, { type: "module", name: "optimal-foundry-converter" }), busy: true };
  warm ??= slot;
  return slot;
}

function release(slot, stop) {
  slot.busy = false;
  if ( (slot === warm) && !stop ) return;
  slot.worker.terminate();
  if ( slot === warm ) warm = null;
}

/**
 * Send one message to a converter worker and resolve with its result. An abort or a worker error terminates that
 * worker: it is the only way to stop an encoder, and it frees whatever the conversion held.
 * @param {object} message
 * @param {{signal?: AbortSignal, onProgress?: (pct: number) => void}} [options]
 */
function call(message, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const slot = acquire();
    const { worker } = slot;
    const settle = (fn, value, stop) => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      release(slot, stop);
      fn(value);
    };
    const onMessage = ({ data }) => {
      if ( data?.type === "progress" ) onProgress?.(data.value);
      else if ( data?.type === "result" ) settle(resolve, data.result, false);
    };
    const onError = event => settle(reject, new Error(event?.message || "the converter worker stopped"), true);
    const onAbort = () => settle(reject, abortReason(signal), true);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { worker.postMessage(message); }
    catch(err) { settle(reject, err, true); }
  });
}

/* -------------------------------------------- */
/*  Capabilities                                */
/* -------------------------------------------- */

/** What the worker can encode: a promise of `{image, video, audio}`, or of null when no worker can run. */
let capabilities = null;
/** The settled value of `capabilities` (undefined until the first probe ends). */
let probed;

function probeWorker() {
  capabilities ??= (async () => {
    if ( pageBlocker() ) return null;
    try {
      return await call({ type: "probe" });
    } catch(err) {
      warn("the converter worker could not start", err);
      return null;
    }
  })().then(caps => (probed = caps));
  return capabilities;
}

/**
 * Can this browser convert media of this kind? Memoized; the first call starts the worker.
 * @param {"image"|"video"|"audio"} kind
 * @returns {Promise<boolean>}
 */
export function canConvert(kind) {
  return probeWorker().then(caps => !!caps?.[kind]);
}

/**
 * Why this browser cannot convert anything at all, or null when it can (or may: the per-kind answer is canConvert).
 * "insecure": the page is not HTTPS or localhost, so the browser offers neither the encoders nor hashing.
 * "unsupported": no module workers, no encoder API, or a worker that could not start or found nothing it can encode.
 * @returns {null|"insecure"|"unsupported"}
 */
export function conversionBlocker() {
  const blocker = pageBlocker();
  if ( blocker ) return blocker;
  // Known only once a worker was asked.
  if ( (probed === null) || (probed && !Object.values(probed).some(Boolean)) ) return "unsupported";
  return null;
}

/** The part of conversionBlocker() the page can tell without starting a worker. */
function pageBlocker() {
  if ( !globalThis.isSecureContext ) return "insecure";
  if ( !globalThis.crypto?.subtle || !moduleWorkers() ) return "unsupported";
  // Workers and windows expose the same encoders; with none of them here, the worker would have none either.
  const encoders = [globalThis.OffscreenCanvas, globalThis.VideoEncoder, globalThis.AudioEncoder];
  return encoders.some(api => typeof api === "function") ? null : "unsupported";
}

let moduleWorkerSupport = null;

/**
 * Module workers have no feature flag: a browser that knows them reads the `type` option of the constructor.
 * The probe worker has an empty script and is terminated at once.
 */
function moduleWorkers() {
  if ( moduleWorkerSupport === null ) {
    let asked = false;
    try {
      new Worker("data:text/javascript,", { get type() { asked = true; return "module"; } }).terminate();
    } catch {
      asked = false;
    }
    moduleWorkerSupport = asked;
  }
  return moduleWorkerSupport;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Optimize an in-memory file.
 * @param {File|Blob} file
 * @param {OptimizeOptions & {name?: string}} [options]
 * @returns {Promise<OptimizeResult>}
 */
export async function optimizeFile(file, options = {}) {
  const name = options.name ?? file?.name ?? "media";
  const size = file?.size ?? 0;
  try {
    if ( !(file instanceof Blob) ) throw new Error("optimizeFile expects a File or Blob");
    const early = skipByName(name);
    if ( early && !(options.kind && early.reason === REASON.unsupported) ) return skipped(early.kind, size, early.reason);
    return await convert({ name, blob: file, url: null, size }, options);
  } catch(err) {
    return failed(err, options.signal, options.kind ?? kindFromName(name), size);
  }
}

/**
 * Optimize a file stored on the server (or another origin).
 * Images are downloaded; video/audio are read with ranged requests when the server allows it.
 * @param {string} path
 * @param {OptimizeOptions} [options]
 * @returns {Promise<OptimizeResult>}
 */
export async function optimizeUrl(path, options = {}) {
  const name = baseName(normalizePath(path)) || "media";
  try {
    const early = skipByName(name);
    if ( early ) return skipped(early.kind, 0, early.reason);
    // Absolute, because the worker resolves relative URLs against its own script, not against the page.
    const url = new URL(toFetchUrl(path), globalThis.location.href).href;
    return await convert({ name, blob: null, url, size: 0 }, options);
  } catch(err) {
    return failed(err, options.signal, options.kind ?? kindFromName(name), 0);
  }
}

/* -------------------------------------------- */
/*  Conversion                                  */
/* -------------------------------------------- */

/** Snapshot of the settings the worker needs (it has no `game`). */
function readConfig() {
  return {
    keepResolution: !!getSetting("keepResolution"),
    maxImageSide: Number(getSetting("maxImageSide")),
    maxVideoHeight: Number(getSetting("maxVideoHeight")),
    imageQuality: clamp(Number(getSetting("imageQuality")) || 0.85, 0.01, 1),
    videoQuality: getSetting("videoQuality"),
    videoStripAudio: !!getSetting("videoStripAudio"),
    audioBitrate: (Number(getSetting("audioBitrate")) || 128) * 1000,
    skipMp3BelowKbps: Number(getSetting("skipMp3BelowKbps")) || 0,
    minSavingsPct: clamp(Number(getSetting("minSavingsPct")) || 0, 0, 99),
    convertAnimatedGif: !!getSetting("convertAnimatedGif")
  };
}

/**
 * Run one conversion in a worker and turn its answer into an OptimizeResult.
 * @param {{name: string, blob: Blob|null, url: string|null, size: number}} source
 * @param {OptimizeOptions} options
 */
async function convert(source, options) {
  const { signal } = options;
  const kind = options.kind ?? kindFromName(source.name);
  signal?.throwIfAborted();
  if ( !(await probeWorker()) ) return skipped(kind, source.size, REASON.notCapable);
  signal?.throwIfAborted();

  const job = {
    ...source,
    kind: options.kind ?? null,
    referenceKinds: options.referenceKinds instanceof Set ? options.referenceKinds : null,
    maxOutputBytes: Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : null,
    cfg: readConfig()
  };
  const { buffer, seconds, ...result } = await call({ type: "convert", job }, options);
  if ( result.status !== "done" ) return result;

  const { ext, mime } = OUTPUT[result.kind];
  result.file = new File([buffer], optimizedName(source.name, result.sha256, ext), { type: mime });
  // Longer sounds stream through an audio element in Foundry, which loops with a gap whatever the format.
  const buffered = options.loop && (result.kind === "audio") && !(seconds > LOOP_BUFFER_SECONDS);
  if ( buffered && !(await loopsLikeSource(source, buffer, signal)) ) {
    return skipped("audio", result.originalBytes, REASON.loopLength);
  }
  return result;
}

/**
 * Does the converted sound decode to the length of its source? Foundry decodes a short sound into an AudioBuffer
 * and loops it sample-exactly, so a few milliseconds more or less tick at every restart. Both files are decoded
 * here as Foundry will decode them. A sound that cannot be compared counts as different: the original stays.
 * @param {{name: string, blob: Blob|null, url: string|null}} source
 * @param {ArrayBuffer} output  The converted file; detached by the decode
 * @param {AbortSignal} [signal]
 */
async function loopsLikeSource(source, output, signal) {
  try {
    const original = source.blob ? await source.blob.arrayBuffer() : await download(source.url, signal);
    // One after the other: each decode holds the whole sound in memory.
    const before = await decodedSeconds(original);
    signal?.throwIfAborted();
    const after = await decodedSeconds(output);
    signal?.throwIfAborted();
    return sameLoopLength(before, after);
  } catch(err) {
    if ( signal?.aborted ) throw err;
    warn(`could not compare the loop length of ${source.name} with its conversion`, err);
    return false;
  }
}

async function download(url, signal) {
  const res = await fetch(url, { cache: "no-store", signal });
  if ( !res.ok ) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.arrayBuffer();
}

async function decodedSeconds(bytes) {
  const context = new OfflineAudioContext(1, 1, LOOP_PROBE_RATE);
  return (await context.decodeAudioData(bytes)).duration;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const skipped = (kind, originalBytes, reason) => ({ status: "skipped", kind, originalBytes, reason });

function failed(err, signal, kind, originalBytes) {
  if ( signal?.aborted ) throw abortReason(signal);
  warn("media conversion failed", err);
  return { status: "failed", kind: kind ?? null, originalBytes, reason: String(err?.message ?? err) };
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
