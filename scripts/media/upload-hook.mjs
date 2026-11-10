import { MODULE_ID, isOptimizedPath, log, warn } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { emit, activeGM, isCoordinator, MSG } from "../socket.mjs";
import { putEntries, normalizePath } from "../library.mjs";
import { isLocalOrigin, behindCloudflare } from "../net/cdn.mjs";
import { optimizeFile, conversionBlocker } from "./converter.mjs";
import { REASON, kindFromName } from "./formats.mjs";

const TARGET = "foundry.applications.apps.FilePicker.upload";
/** Cloudflare rejects request bodies over 100 MB (form fields included, so stay a little under it). */
export const TUNNEL_LIMIT_BYTES = 100_000_000;
/** Warn a little before the limit. */
const TUNNEL_WARN_BYTES = 95_000_000;
const MB = 1_048_576;
const PROGRESS_DELAY_MS = 1500;
/** A conversion that reports no progress for this long is abandoned and the original is uploaded. */
const STALL_MS = 90_000;
/** Success toasts of a multi-file drop are merged into one. */
const SUMMARY_DELAY_MS = 3000;

/**
 * Files already processed. FilePicker.upload re-enters itself through FilePicker.implementation.upload when
 * CONFIG.ux.FilePicker is a subclass (file-picker.mjs:436), so both the original and the converted file are marked.
 */
const handled = new WeakSet();

/**
 * Whether this browser's uploads go through Cloudflare, which caps them at 100 MB: the CDN probe saw Cloudflare and
 * this page is not on a local origin (a game master on the server machine uploads straight to Foundry).
 */
export const tunnelLimited = () => behindCloudflare() && !isLocalOrigin();

/** Let a module-internal upload (the cleanup's empty files) through without conversion or bookkeeping. */
export function skipUploadHook(file) {
  handled.add(file);
  return file;
}

/** Wrap the static FilePicker.upload. Called at `init`. */
export function initUploadHook() {
  try {
    libWrapper.register(MODULE_ID, TARGET, uploadWrapper, "WRAPPER");
  } catch(err) {
    warn("could not wrap FilePicker.upload: upload optimization disabled", err);
  }
}

/** Signature of FilePicker.upload(source, path, file, body={}, options={}); always continues the chain. */
async function uploadWrapper(wrapped, source, path, file, body = {}, options = {}) {
  if ( !shouldProcess(file, body) ) return wrapped(source, path, file, body, options);
  handled.add(file);
  const notify = options?.notify ?? true;
  const plan = await prepare(file, notify);
  handled.add(plan.file);
  if ( (plan.file.size > TUNNEL_WARN_BYTES) && tunnelLimited() ) {
    const format = { name: plan.file.name, size: (plan.file.size / MB).toFixed(0) };
    ui.notifications.warn("OPTIMALFOUNDRY.Media.UploadTooLarge", { format, permanent: true });
  }
  const response = await wrapped(source, path, plan.file, body, options);
  afterUpload(plan, response, notify).catch(err => warn("post-upload bookkeeping failed", err));
  return response;
}

function shouldProcess(file, body) {
  try {
    if ( !(file instanceof Blob) || handled.has(file) ) return false;
    if ( !getSetting("mediaEnabled") || !getSetting("optimizeUploads") ) return false;
    if ( !game.user?.hasPermission("FILES_UPLOAD") ) return false;
    const name = file.name ?? "";
    // Already-optimized outputs (e.g. the background optimizer uploading its result) pass through untouched.
    if ( isOptimizedPath(name) ) return false;
    const kind = kindFromName(name);
    if ( !kind ) return false;
    // ProseMirror uploads (body.uuid) accept images only; the server stores them under the world assets folder.
    if ( body?.uuid && (kind !== "image") ) return false;
    return true;
  } catch(err) {
    warn("upload hook check failed", err);
    return false;
  }
}

/**
 * Convert the file; on any problem keep the original. Never throws.
 * The upload never waits on a stuck encoder: a click on the progress notice or a stall aborts the conversion,
 * and the race settles even if the encoder ignores the abort.
 */
async function prepare(file, notify) {
  const name = file.name;
  const ctl = new AbortController();
  const progress = progressNotice(name, notify, ctl);
  const aborted = new Promise((_, reject) => {
    ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
  });
  let result;
  try {
    result = await Promise.race([optimizeFile(file, { name, signal: ctl.signal, onProgress: progress.update }), aborted]);
  } catch(err) {
    result = { status: "failed", kind: kindFromName(name), originalBytes: file.size, reason: String(err?.message ?? err),
      canceled: err?.name === "AbortError" };
  } finally {
    progress.done();
  }
  if ( (result.status === "done") && (result.file instanceof File) ) return { file: result.file, result, originalName: name };
  if ( result.status === "failed" ) {
    warn(`could not optimize ${name}; uploading the original`, result.reason);
    if ( notify && !result.canceled ) ui.notifications.warn("OPTIMALFOUNDRY.Media.ConvertFailed", { format: { name } });
  }
  return { file, result, originalName: name };
}

/**
 * Progress bar shown only when a conversion takes longer than PROGRESS_DELAY_MS; clicking it skips the conversion.
 * A watchdog aborts when no progress arrives for STALL_MS.
 */
function progressNotice(name, notify, ctl) {
  let notice = null;
  let pct = 0;
  let stall = null;
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(new Error(`no conversion progress for ${STALL_MS / 1000} s`)), STALL_MS);
  };
  arm();
  const timer = notify ? setTimeout(() => {
    notice = ui.notifications.info("OPTIMALFOUNDRY.Media.Converting", { format: { name }, progress: true });
    notice.update({ pct });
    // Foundry removes a notice on click; the click also cancels the conversion.
    notice.element?.addEventListener("click", () => ctl.abort(new DOMException("canceled", "AbortError")), { once: true });
  }, PROGRESS_DELAY_MS) : null;
  return {
    update: p => {
      arm();
      pct = Math.min(0.99, Math.max(0, Number(p) || 0));
      notice?.update({ pct });
    },
    done: () => {
      clearTimeout(timer);
      clearTimeout(stall);
      notice?.update({ pct: 1 });
    }
  };
}

const summary = { files: 0, saved: 0, original: 0, last: null, timer: null };

function reportOptimized(name, result) {
  summary.files += 1;
  summary.original += result.originalBytes;
  summary.saved += result.originalBytes - result.bytes;
  summary.last = name;
  clearTimeout(summary.timer);
  summary.timer = setTimeout(flushSummary, SUMMARY_DELAY_MS);
}

function flushSummary() {
  const { files, saved, original, last } = summary;
  Object.assign(summary, { files: 0, saved: 0, original: 0, last: null, timer: null });
  if ( files === 1 ) {
    const pct = Math.round((saved / original) * 100);
    ui.notifications.info("OPTIMALFOUNDRY.Media.Optimized", { format: { name: last, saved: pct } });
  }
  else ui.notifications.info("OPTIMALFOUNDRY.Media.OptimizedBatch", { format: { count: files, mb: (saved / MB).toFixed(1) } });
}

async function afterUpload(plan, response, notify) {
  const stored = response?.path;
  if ( !stored ) return;
  const { result } = plan;
  if ( result.status === "done" ) {
    if ( notify && (result.originalBytes > 0) ) reportOptimized(plan.originalName, result);
    return register(plan, stored);
  }
  if ( (result.reason === REASON.notCapable) || (result.status === "failed") ) {
    if ( (result.reason === REASON.notCapable) && notify ) {
      // On plain HTTP no browser can convert: say what the page needs instead of blaming the browser.
      const key = conversionBlocker() === "insecure" ? "OPTIMALFOUNDRY.Media.NotCapableInsecure" : "OPTIMALFOUNDRY.Media.NotCapable";
      ui.notifications.info(key, { format: { name: plan.originalName } });
    }
    requestConversion(stored);
  }
}

/**
 * Record a client-converted upload. No original exists on the server, so the entry is keyed by the stored
 * optimized path itself (undo is then a no-op and a same-named real file elsewhere is never shadowed).
 * `uploadedName` (the file name the user picked) marks such entries. Only the coordinator writes the library;
 * everyone else (players, other GM sessions) asks it. Nothing references the file yet, so the write is batched.
 */
function register(plan, stored) {
  const { result } = plan;
  const optimized = normalizePath(stored);
  const entry = {
    original: optimized,
    optimized,
    kind: result.kind,
    sha256: result.sha256,
    bytes: result.bytes,
    originalBytes: result.originalBytes,
    uploadedName: plan.originalName
  };
  if ( isCoordinator() ) {
    putEntries({ ...entry, status: "done" }).catch(err => warn(`could not register ${optimized} in the library`, err));
    return;
  }
  const gm = activeGM();
  if ( gm ) emit(MSG.REGISTER_OPTIMIZED, entry, gm.id);
  else log(`no GM online; ${optimized} was not registered in the library`);
}

/** Ask the active GM to optimize an original this client could not convert. */
function requestConversion(stored) {
  const gm = activeGM();
  // The active GM's own background optimizer picks the file up once it is referenced.
  if ( !gm || (gm.id === game.user.id) ) return;
  emit(MSG.CONVERT_REQUEST, { path: normalizePath(stored) }, gm.id);
}
