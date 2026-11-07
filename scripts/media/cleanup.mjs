import { MODULE_ID, warn, isOptimizedPath, sha256Hex } from "../constants.mjs";
import { getLibrary, putEntries, flushLibrary, normalizePath } from "../library.mjs";
import { isCoordinator } from "../socket.mjs";
import { toFetchUrl, encodeSegments } from "./naming.mjs";
import { fingerprintOf, beginCleanup, endCleanup } from "./backfill.mjs";
import { skipUploadHook } from "./upload-hook.mjs";

/**
 * Cleanup of originals the optimizer replaced. Foundry's server cannot delete files (manageFiles only browses,
 * creates directories and configures paths), but its upload overwrites an existing file whose extension is a media
 * type, without looking at the content. So the cleanup EMPTIES each original: it uploads a 0-byte file with the same
 * name over it. The name stays in the folder, the space is freed, and there is no way back.
 *
 * Library entries keep `status: "done"` and gain `cleaned`: the backfill re-points any later reference to the
 * original to the optimized copy, and undo keeps them. `cleaned` is written BEFORE the upload, so no emptied file is
 * ever left unmarked; when the upload verifiably did not happen, the mark is removed again.
 *
 * "Used" is decided by a text search over every world document (chat, macros and settings included, but not the
 * module's own library) and every world compendium, as written, encoded and lowercase: any mention keeps the file.
 * Other worlds are not searched; only files in this world's folder are offered.
 */

const HEAD_CONCURRENCY = 6;
const WORK_CONCURRENCY = 3;
/** Items checked, marked and emptied together: one library write before and at most one after each group. */
const CHUNK = 10;
const YIELD_EVERY = 200;

const worldPrefix = () => `worlds/${game.world.id}/`;

/** Foundry overwrites only files whose extension maps to a media MIME type (server files.mjs). */
function overwritable(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const mime = CONST.UPLOADABLE_FILE_EXTENSIONS?.[ext];
  return !!mime && !!CONST.MEDIA_MIME_TYPES?.includes(mime);
}

/**
 * Library entries the cleanup may touch: converted, not yet emptied, original in this world's folder. Keys are
 * already normalized and are used as they are: normalizing again would cut a decoded "#" or "?" out of a name, and
 * such names are never offered, because URL handling would make every check read another path. Nor are paths with
 * empty, "." or ".." segments (the server resolves them, possibly into another world).
 */
function eligible(e) {
  if (e?.status !== "done" || !e.optimized || e.cleaned) return false;
  const original = String(e.original ?? "");
  return original !== e.optimized && original.startsWith(worldPrefix()) && !isOptimizedPath(original)
    && !/[?#]/.test(original) && !original.split("/").some(s => !s || s === "." || s === "..")
    && overwritable(original);
}

/**
 * @returns {Promise<{candidates: CleanupItem[], inUse: number, outsideWorld: number, brokenCopy: number, gone: number}>}
 * @typedef {{original: string, optimized: string, originalBytes: number, optimizedBytes: number, kind?: string}} CleanupItem
 */
export async function findCleanupCandidates({ signal } = {}) {
  assertCoordinator();
  await flushLibrary();
  const report = { candidates: [], inUse: 0, outsideWorld: 0, brokenCopy: 0, gone: 0 };
  // Client-converted uploads (original === optimized) have no separate original.
  const done = Object.values(getLibrary()).filter(e => e?.status === "done" && e.optimized && !e.cleaned
    && e.optimized !== e.original);
  const inWorld = done.filter(eligible);
  report.outsideWorld = done.length - inWorld.length;
  if (!inWorld.length) return report;

  const used = await usageText(signal);
  const free = inWorld.filter(e => {
    if (!mentions(used, e.original)) return true;
    report.inUse++;
    return false;
  });

  const gone = [];
  await eachLimited(free, HEAD_CONCURRENCY, async e => {
    if (signal?.aborted) return;
    const [orig, opt] = await Promise.all([head(e.original, signal), head(e.optimized, signal)]);
    // Already gone or already empty (deleted by hand, or emptied by a run that could not finish).
    if (orig.status === 404 || (orig.ok && orig.bytes === 0)) { gone.push(e.original); return; }
    if (!orig.ok || !opt.ok || (Number(e.bytes) > 0 && opt.bytes !== null && opt.bytes !== Number(e.bytes))) {
      report.brokenCopy++;
      return;
    }
    report.candidates.push({
      original: e.original,
      optimized: e.optimized,
      originalBytes: orig.bytes ?? (Number(e.originalBytes) || 0),
      optimizedBytes: Number(e.bytes) || opt.bytes || 0,
      kind: e.kind
    });
  });
  if (gone.length) {
    report.gone = gone.length;
    await mark(gone, Date.now()).catch(err => warn("could not mark removed originals", err));
  }
  report.candidates.sort((a, b) => b.originalBytes - a.originalBytes);
  return report;
}

/**
 * Empty the given originals after checking each one again. Irreversible.
 * @param {CleanupItem[]} items
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<{emptied: string[], kept: {original: string, reason: string}[], freedBytes: number}>}
 */
export async function emptyOriginals(items, { signal, onProgress } = {}) {
  assertCoordinator();
  const list = [...new Set([].concat(items ?? []).map(i => i?.original).filter(o => typeof o === "string" && o))];
  const result = { emptied: [], kept: [], freedBytes: 0 };
  if (!list.length) return result;
  if (!beginCleanup()) throw new Error("An undo is running: try the cleanup again when it ends.");
  let done = 0;
  const report = (original, outcome) => {
    if (typeof outcome === "number") {
      result.emptied.push(original);
      result.freedBytes += outcome;
    } else result.kept.push({ original, reason: outcome });
    onProgress?.(++done, list.length);
  };
  try {
    await flushLibrary();
    for (let i = 0; i < list.length && !signal?.aborted; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      // Documents can change during a long run: search again for every group.
      const used = await usageText(signal);
      const checked = [];
      await eachLimited(chunk, WORK_CONCURRENCY, async original => {
        const outcome = await safely(original, () => check(original, used, signal), signal);
        if (outcome && typeof outcome === "object") checked.push(outcome);
        else report(original, outcome);
      });
      const gone = result.kept.filter(k => k.reason === "gone" && chunk.includes(k.original)).map(k => k.original);
      if (gone.length) await mark(gone, Date.now()).catch(err => warn("could not mark removed originals", err));
      if (!checked.length || signal?.aborted) {
        for (const c of checked) report(c.original, "error");
        continue;
      }

      // Durable first: if the page dies mid-upload, every file that may be empty is already marked.
      try { await mark(checked.map(c => c.original), Date.now()); }
      catch (err) {
        warn("cleanup: could not record the files about to be emptied; nothing was emptied", err);
        for (const c of checked) report(c.original, "error");
        continue;
      }
      const untouched = [];
      await eachLimited(checked, WORK_CONCURRENCY, async c => {
        const outcome = await safely(c.original, () => overwrite(c), null);
        if (outcome === "uploadFailed" || outcome === "changed") untouched.push(c.original);
        report(c.original, outcome);
      });
      if (untouched.length) await mark(untouched, undefined).catch(err => warn("could not clear cleanup marks", err));
    }
  } finally {
    endCleanup();
  }
  return result;
}

/** Everything that must hold right before an original is emptied. Returns what overwrite() needs, or a reason. */
async function check(original, used, signal) {
  const e = getLibrary()[original];
  if (!eligible(e)) return "notEligible";
  if (mentions(used, original)) return "inUse";

  // Unchanged since it was converted: same fingerprint (ETag, or Last-Modified|length), else same size.
  const res = await fetch(toFetchUrl(original), { method: "HEAD", cache: "no-store", signal });
  if (res.status === 404) return "gone";
  if (!res.ok) return "error";
  const len = res.headers.get("content-length");
  if (len === null) return "unknownSize";
  const bytes = Number(len);
  if (bytes === 0) return "gone";
  const fingerprint = fingerprintOf(res.headers);
  if (e.source) { if (fingerprint !== e.source) return "changed"; }
  else if (!(Number(e.originalBytes) > 0) || Number(e.originalBytes) !== bytes) return "changed";

  // The optimized copy is the only content left afterwards: it must be intact.
  if (!/^[0-9a-f]{64}$/i.test(e.sha256 ?? "")) return "noHash";
  const copy = await fetch(toFetchUrl(e.optimized), { cache: "no-store", signal });
  if (!copy.ok) return "copyMissing";
  const buf = await copy.arrayBuffer();
  if (Number(e.bytes) > 0 && buf.byteLength !== Number(e.bytes)) return "copySize";
  if (await sha256Hex(buf) !== e.sha256.toLowerCase()) return "copyHash";
  return { original, bytes, fingerprint };
}

/**
 * Upload the empty file and decide from the file itself what happened: emptied (bytes freed), untouched
 * ("uploadFailed", or "changed" when someone else rewrote it), or "uncertain" when it cannot be read back.
 */
async function overwrite({ original, bytes, fingerprint }) {
  const cut = original.lastIndexOf("/");
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const empty = skipUploadHook(new File([], original.slice(cut + 1)));
  let up = null;
  try { up = await FilePicker.upload("data", encodeSegments(original.slice(0, cut)), empty, {}, { notify: false }); }
  catch (err) { warn(`cleanup: upload of the empty ${original} failed`, err); }
  if (up?.path && normalizePath(up.path) !== original) warn(`cleanup: the server reported ${up.path} for ${original}`);

  // A failed response does not prove the server did not write (a proxy timeout after the write), so read it back.
  let after = await head(original);
  if (!after.ok && after.status !== 404) after = await new Promise(r => setTimeout(r, 1000)).then(() => head(original));
  if (after.ok && after.bytes === 0) return bytes;
  if (after.ok && after.bytes > 0) return after.fingerprint === fingerprint ? "uploadFailed" : "changed";
  return "uncertain"; // stays marked: undo never points documents at a file that may be empty
}

/** Run a step; a thrown error becomes a reason (the abort of a whole run becomes "error" too). */
async function safely(original, fn, signal) {
  try { return await fn(); }
  catch (err) {
    if (!signal?.aborted) warn(`cleanup: ${original}`, err);
    return "error";
  }
}

/**
 * Lowercase NFC text of every world document and world compendium document, as stored. The module's own settings
 * (the library lists every original) and fog exploration (image data) are left out.
 */
async function usageText(signal) {
  const parts = [];
  let n = 0;
  const add = async source => {
    parts.push(JSON.stringify(source));
    if (++n % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0));
      signal?.throwIfAborted();
    }
  };
  for (const collection of game.collections ?? []) {
    const type = collection.documentName;
    if (type === "FogExploration") continue;
    for (const doc of collection) {
      if (type === "Setting" && String(doc.key ?? "").startsWith(`${MODULE_ID}.`)) continue;
      await add(doc._source ?? doc);
    }
  }
  for (const pack of game.packs ?? []) {
    if (pack.metadata?.packageType !== "world") continue;
    let docs;
    try { docs = await pack.getDocuments(); }
    catch (err) { throw new Error(`could not read compendium ${pack.collection}: ${err?.message ?? err}`); }
    for (const d of docs) await add(d._source ?? d);
  }
  return parts.join("\n").normalize("NFC").toLowerCase();
}

/** Whether the text mentions the path in any of the forms a document may hold it in. */
function mentions(text, path) {
  const p = path.normalize("NFC");
  const forms = new Set([p, encodeSegments(p), encodeURI(p), p.replaceAll("&", "&amp;")]);
  for (const f of forms) if (text.includes(f.toLowerCase())) return true;
  return false;
}

/** Set (time) or clear (undefined) `cleaned`, durably. Throws when the write fails. */
async function mark(originals, cleaned) {
  await putEntries(originals.map(original => ({ original, cleaned })), { now: true });
}

function assertCoordinator() {
  if (!game.user.isGM || !isCoordinator()) throw new Error("Only the coordinating GM session can run the cleanup.");
}

async function head(path, signal) {
  try {
    const res = await fetch(toFetchUrl(path), { method: "HEAD", cache: "no-store", signal });
    const len = res.headers.get("content-length");
    return { ok: res.ok, status: res.status, bytes: res.ok && len !== null ? Number(len) : null,
      fingerprint: res.ok ? fingerprintOf(res.headers) : null };
  } catch {
    return { ok: false, status: 0, bytes: null, fingerprint: null };
  }
}

async function eachLimited(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
