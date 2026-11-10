import { MODULE_ID, warn, isOptimizedPath, sha256Hex } from "../constants.mjs";
import { getLibrary, getEntry, putEntries, flushLibrary, normalizePath } from "../library.mjs";
import { isCoordinator } from "../socket.mjs";
import { toFetchUrl, encodeSegments } from "./naming.mjs";
import { fingerprintOf, beginCleanup, endCleanup } from "./backfill.mjs";
import { skipUploadHook } from "./upload-hook.mjs";
import { pacer } from "./references.mjs";

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
 * Emptying cannot be undone, so "nothing uses this file" has to fail safe: whatever cannot be read or decided keeps
 * the file. "Used" is a text search, as written, encoded and lowercase, over everything the world loads: the
 * manifests of the world, its system and its active modules (a world's background and description live only there),
 * every world document (chat, macros and settings included, but not the module's own library), and every document of
 * every compendium, the system's and the modules' too. Any mention keeps the file. So does a file pattern that
 * matches it (wildcard token art names no file: see `collectPatterns`). Other worlds are not searched; only files in
 * this world's folder are offered.
 */

const HEAD_CONCURRENCY = 6;
const WORK_CONCURRENCY = 3;
/** Items checked, marked and emptied together: one library write before and at most one after each group. */
const CHUNK = 10;
/** Characters per piece of the searched text: a piece is normalized, and later searched, in a few milliseconds. */
const TEXT_PIECE = 1 << 20;
/** How long the text read by an analysis is kept for the run that usually follows it. */
const USAGE_KEEP_MS = 10 * 60_000;
/** Every spelling of a file in a world folder starts with this (segments are encoded one by one, never the slash). */
const ANCHOR = "worlds/";
/** Trie key that holds the paths ending at a node; no character of the text can equal it. */
const END = "";

const worldPrefix = () => `worlds/${game.world.id}/`;
const t = (key, data = {}) => game.i18n.format(`OPTIMALFOUNDRY.Cleanup.Error.${key}`, data);

/** Foundry overwrites only files whose extension maps to a media MIME type (server files.mjs). */
function overwritable(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const mime = CONST.UPLOADABLE_FILE_EXTENSIONS?.[ext];
  return !!mime && !!CONST.MEDIA_MIME_TYPES?.includes(mime);
}

/**
 * Library entries the cleanup may touch: converted by this module's own optimizer (`source` is the fingerprint it
 * read from the original; an entry registered without one proves nothing about that file), not yet emptied, original
 * in this world's folder. Keys are already normalized and are used as they are: normalizing again would cut a decoded
 * "#" or "?" out of a name, and such names are never offered, because URL handling would make every check read
 * another path. Nor are paths with empty, "." or ".." segments (the server resolves them, possibly into another
 * world).
 */
function eligible(e) {
  if (e?.status !== "done" || !e.optimized || !e.source || e.cleaned) return false;
  const original = String(e.original ?? "");
  return original !== e.optimized && original.startsWith(worldPrefix()) && !isOptimizedPath(original)
    && !/[?#]/.test(original) && !original.split("/").some(s => !s || s === "." || s === "..")
    && overwritable(original);
}

/**
 * Look for originals that can be emptied. Nothing is changed, except that originals found at 0 bytes are recorded as
 * emptied. `outsideWorld` counts every converted original that is never offered (another folder, a name the checks
 * cannot read, an entry without a fingerprint); `missing` counts originals that are not on the server right now
 * (nothing to empty, and nothing is recorded: a renamed folder or an unmounted drive comes back).
 * @returns {Promise<{candidates: CleanupItem[], inUse: number, outsideWorld: number, brokenCopy: number, gone: number,
 *   missing: number}>}
 * @typedef {{original: string, optimized: string, originalBytes: number, optimizedBytes: number, kind?: string}} CleanupItem
 */
export async function findCleanupCandidates({ signal } = {}) {
  assertCoordinator();
  await flushLibrary();
  const report = { candidates: [], inUse: 0, outsideWorld: 0, brokenCopy: 0, gone: 0, missing: 0 };
  // Client-converted uploads (original === optimized) have no separate original.
  const done = Object.values(getLibrary()).filter(e => e?.status === "done" && e.optimized && !e.cleaned
    && e.optimized !== e.original);
  const inWorld = done.filter(eligible);
  report.outsideWorld = done.length - inWorld.length;
  if (!inWorld.length) return report;

  const used = await usedPaths(await readUsage(signal), inWorld.map(e => e.original), signal);
  const free = inWorld.filter(e => !used.has(e.original));
  report.inUse = inWorld.length - free.length;

  const gone = [];
  await eachLimited(free, HEAD_CONCURRENCY, async e => {
    if (signal?.aborted) return;
    const [orig, opt] = await Promise.all([head(e.original, signal), head(e.optimized, signal)]);
    if (orig.status === 404) { report.missing++; return; }
    // Already empty (emptied by a run that could not finish, or by hand): the only state recorded as emptied.
    if (orig.ok && orig.bytes === 0) { gone.push(e.original); return; }
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
    await mark(gone, Date.now()).catch(err => warn("could not mark emptied originals", err));
  }
  report.candidates.sort((a, b) => b.originalBytes - a.originalBytes);
  return report;
}

/**
 * Empty the given originals after checking each one again. Irreversible. Stops when this session is no longer the
 * coordinator: the originals it did not reach are returned in `kept` with the reason "notCoordinator".
 * @param {CleanupItem[]} items
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<{emptied: string[], kept: {original: string, reason: string}[], freedBytes: number}>}
 */
export async function emptyOriginals(items, { signal, onProgress } = {}) {
  assertCoordinator();
  const list = [...new Set([].concat(items ?? []).map(i => i?.original).filter(o => typeof o === "string" && o))];
  const result = { emptied: [], kept: [], freedBytes: 0 };
  if (!list.length) return result;
  if (!beginCleanup()) throw new Error(t("UndoRunning"));
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
    let searched = null, used = null;
    for (let i = 0; i < list.length && !signal?.aborted; i += CHUNK) {
      // Another GM session may have taken over meanwhile (a co-GM logged in). It runs the optimizer now and its undo
      // is not held back by this session's lock, so this session stops emptying.
      if (!isCoordinator()) {
        for (const original of list.slice(i)) report(original, "notCoordinator");
        break;
      }
      const chunk = list.slice(i, i + CHUNK);
      // Documents can change during a long run, so usage is settled again right before each group. The text is read
      // again only where a document changed since (readUsage), and the rest of the list is searched again only then.
      const current = await readUsage(signal);
      if (current !== searched) {
        searched = current;
        used = await usedPaths(current, list.slice(i), signal);
      }
      const checked = [];
      await eachLimited(chunk, WORK_CONCURRENCY, async original => {
        const outcome = await safely(original, () => check(original, used, signal), signal);
        if (outcome && typeof outcome === "object") checked.push(outcome);
        else report(original, outcome);
      });
      const gone = result.kept.filter(k => k.reason === "gone" && chunk.includes(k.original)).map(k => k.original);
      if (gone.length) await mark(gone, Date.now()).catch(err => warn("could not mark emptied originals", err));
      if (!checked.length || signal?.aborted) {
        for (const c of checked) report(c.original, "error");
        continue;
      }
      // The checks download every optimized copy, which takes a while: the role is confirmed again before any write.
      if (!isCoordinator()) {
        for (const c of checked) report(c.original, "notCoordinator");
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
  // One entry, not the whole library rebuilt per file. A key that does not survive normalization (a literal "#"
  // or "?") would read another file's entry, so it is never eligible.
  const e = getEntry(original);
  if (e?.original !== original || !eligible(e)) return "notEligible";
  if (used.has(original)) return "inUse";

  // Unchanged since it was converted: the same fingerprint (ETag, or Last-Modified|length).
  const res = await fetch(toFetchUrl(original), { method: "HEAD", cache: "no-store", signal });
  // Not there (folder renamed, drive unmounted): nothing to empty and nothing to record, the file may come back.
  if (res.status === 404) return "missing";
  if (!res.ok) return "error";
  const len = res.headers.get("content-length");
  if (len === null) return "unknownSize";
  const bytes = Number(len);
  if (bytes === 0) return "gone";
  const fingerprint = fingerprintOf(res.headers);
  if (fingerprint !== e.source) return "changed";

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

/* -------------------------------------------- */
/*  What the world still uses                   */
/* -------------------------------------------- */

/**
 * @typedef {object} Usage
 * @property {string[]} texts  Lowercase NFC JSON of everything that was read, in pieces of about TEXT_PIECE
 * @property {{under: string[], dirs: Set<string>, names: Map<string, RegExp[]>}} globs  What the file patterns
 *   found in it protect (see globIndex)
 */

/** Key of the world's own part. Compendium ids always hold a dot. */
const WORLD = "world";
/** WORLD | compendium id -> {texts: string[], patterns: string[]}: what was read, kept for USAGE_KEEP_MS. */
const parts = new Map();
/** Keys whose documents changed since they were read. */
const stale = new Set();
/** @type {Usage|null} Built from `parts`; the same object for as long as nothing changed. */
let usage = null;
let watching = false;
let forgetTimer = null;

function forgetUsage() {
  parts.clear();
  usage = null;
}

const ownSetting = doc => String(doc?.key ?? "").startsWith(`${MODULE_ID}.`);

/**
 * Mark what a document change makes stale: the world's part, or the part of the compendium the document is in.
 * Registered once, the first time the cleanup reads the world. Fog exploration and the module's own settings are
 * never read, so their (frequent) writes change nothing.
 */
function watchChanges() {
  if (watching) return;
  watching = true;
  for (const name of CONST.ALL_DOCUMENT_TYPES) {
    if (name === "FogExploration") continue;
    for (const event of ["create", "update", "delete"]) {
      Hooks.on(`${event}${name}`, doc => {
        if (name !== "Setting" || !ownSetting(doc)) stale.add(doc?.pack || WORLD);
      });
    }
  }
  // Changes made while the connection was down never reach this session, and a short drop does not reload the page.
  game.socket?.on("disconnect", forgetUsage);
}

/**
 * Everything that can mention a file. Reading it means serializing the whole world and downloading every compendium,
 * so it is done once and kept: a later call reads again only the parts whose documents changed since (document
 * hooks). Returns the same object while nothing changed, which tells the caller its last search still holds.
 * Throws when something cannot be read: the cleanup then empties nothing.
 * @returns {Promise<Usage>}
 */
async function readUsage(signal) {
  watchChanges();
  clearTimeout(forgetTimer);
  forgetTimer = setTimeout(forgetUsage, USAGE_KEEP_MS);
  forgetTimer.unref?.(); // Node (the unit tests): a pending timer must not keep the process alive
  const pace = pacer(signal);
  const sources = [[WORLD, () => readWorld(pace)]];
  for (const pack of game.packs ?? []) sources.push([pack.collection, () => readPack(pack, pace)]);

  let changed = !usage;
  for (const [key, read] of sources) {
    if (parts.has(key) && !stale.has(key)) continue;
    // Cleared before reading: a change that arrives while this part is being read marks it stale again.
    stale.delete(key);
    parts.delete(key);
    parts.set(key, await read());
    changed = true;
  }
  const live = new Set(sources.map(([key]) => key));
  for (const key of [...parts.keys()]) {
    if (live.has(key)) continue;
    parts.delete(key); // a compendium that no longer exists
    changed = true;
  }
  if (changed) {
    const all = [...parts.values()];
    usage = { texts: all.flatMap(p => p.texts), globs: globIndex(all.flatMap(p => p.patterns)) };
  }
  return usage;
}

/** Collects the JSON of documents into text pieces, and the file patterns their data holds. */
function newPart() {
  const texts = [], patterns = [];
  let pending = [], size = 0;
  const flush = () => {
    if (pending.length) texts.push(pending.join("\n").normalize("NFC").toLowerCase());
    pending = [];
    size = 0;
  };
  return {
    add(source) {
      const json = JSON.stringify(source);
      // Few documents hold a pattern: only those are walked value by value.
      if (json.includes("*") || json.includes("\"randomImg\":true")) collectPatterns(source, patterns);
      pending.push(json);
      if ((size += json.length) >= TEXT_PIECE) flush();
    },
    done() {
      flush();
      return { texts, patterns };
    }
  };
}

/** The manifests of the world, its system and its active modules, and every document of every world collection. */
async function readWorld(pace) {
  const part = newPart();
  // Not documents: a world's background, description and compendium banners live only in its manifest. A package
  // that does not expose its manifest makes this throw, and nothing is emptied.
  part.add(game.world._source);
  part.add(game.system._source);
  for (const module of game.modules.values()) if (module.active) part.add(module._source);
  for (const collection of game.collections ?? []) {
    const type = collection.documentName;
    // Fog exploration is image data; the module's own settings list every original (the library).
    if (type === "FogExploration") continue;
    for (const doc of collection) {
      if (type === "Setting" && ownSetting(doc)) continue;
      part.add(doc._source ?? doc);
      await pace();
    }
  }
  return part.done();
}

/**
 * Every document of one compendium (the world's, the system's or a module's), as the server stores it. This is the
 * request `CompendiumCollection#getDocuments` sends, with the answer used raw: turning a system's tens of thousands
 * of entries into Document instances, only to read their text, would prepare every one of them and keep them all in
 * memory. A compendium that cannot be read stops the cleanup.
 */
async function readPack(pack, pace) {
  const part = newPart();
  let docs;
  try {
    const response = await foundry.helpers.SocketInterface.dispatch("modifyDocument", {
      type: pack.documentName, action: "get", operation: { pack: pack.collection, query: {}, broadcast: false }
    });
    docs = response?.result;
    if (!Array.isArray(docs)) throw new Error("the server sent no documents");
  }
  catch (err) { throw new Error(t("Compendium", { pack: pack.collection, error: err?.message ?? String(err) })); }
  for (const folder of pack.folders ?? []) part.add(folder._source ?? folder);
  for (const doc of docs) {
    part.add(doc);
    await pace();
  }
  return part.done();
}

/* -------------------------------------------- */
/*  File patterns (wildcard token art)          */
/* -------------------------------------------- */

/** Wildcard syntax of the server's matcher (minimatch) in a path. */
const GLOB = /[*?[{]|[+@!]\(/;
/** Syntax that is not evaluated here: classes, braces, `**`, extglob groups, a negated or comment pattern. */
const RICH = /[[{]|\*\*|[?*+@!]\(|^[!#]/;
/** Where a path written inside code, HTML or JSON text ends; an apostrophe is tried too (see worldPaths). */
const PATH_END = /["`<>\\\n\r\t]/;
const PATH_END_OR_APOSTROPHE = /["'`<>\\\n\r\t]/;

const decoded = text => {
  try { return decodeURIComponent(text); }
  catch { return text; }
};

/**
 * File patterns in a document's data. A token whose art is `tokens/goblin-*.png` names no file: placed tokens hold
 * the files it picked, those are converted and re-pointed, and then no text mentions `goblin-1.png` any more while
 * the pattern still hands it to every new goblin. So any string with a "*" may be a pattern, and so is the art of a
 * prototype token set to pick a random image, whatever wildcard it uses. Only patterns into this world's folder are
 * kept; a path without wildcard syntax is left to the text search. Once the optimizer has re-pointed such a pattern at
 * the optimized copies (`goblin-*.webp`), it matches no original any more and they are offered.
 */
function collectPatterns(value, out) {
  if (typeof value === "string") {
    if (value.includes("*")) for (const path of worldPaths(value)) if (path.includes("*")) out.push(path);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.randomImg === true && typeof value.texture?.src === "string") {
    for (const path of worldPaths(value.texture.src)) {
      if (GLOB.test(path) || RICH.test(path.slice(path.lastIndexOf("/") + 1))) out.push(path);
    }
  }
  // This module's own flags are skipped: the pattern it replaced is kept there (flags.optimal-foundry.tokenPattern) so
  // that undo can put it back, and it must not keep protecting the originals the new pattern no longer matches.
  for (const [key, v] of Object.entries(value)) if (key !== MODULE_ID) collectPatterns(v, out);
}

/**
 * The paths into this world's folder that a string holds, lowercase NFC, in each spelling it can be read in: as
 * written, percent-decoded, and with `&amp;` undone. A path runs from the world's prefix to the end of the string,
 * or to the first character that ends a path written inside code, HTML or JSON. An apostrophe ends a path in code
 * but is also a legal character of a file name, so both readings are returned. A backslash is an escaped quote in
 * JSON text but escapes a character inside a pattern: what follows it is unknown, so it is read as "anything".
 */
function worldPaths(text) {
  const out = new Set();
  if (!/worlds/i.test(text)) return out;
  const prefix = worldPrefix().toLowerCase();
  for (const plain of [text, text.replaceAll("&amp;", "&")]) {
    for (const spelling of [plain, decoded(plain)]) {
      const s = spelling.normalize("NFC").toLowerCase();
      for (let at = s.indexOf(prefix); at !== -1; at = s.indexOf(prefix, at + 1)) {
        const rest = s.slice(at);
        for (const end of [PATH_END, PATH_END_OR_APOSTROPHE]) {
          const cut = rest.search(end);
          out.add(cut < 0 ? rest : rest.slice(0, cut) + (rest[cut] === "\\" ? "*" : ""));
        }
      }
    }
  }
  return out;
}

/**
 * What the patterns protect, never less than Foundry's server would match (minimatch over the names in the
 * pattern's folder; here without regard to case):
 * - `names`: folder -> name tests, for patterns that only use "*" and "?" in the file name. "?" is read as "*": the
 *   server matches names as the disk spells them, where an accented letter can be two characters.
 * - `dirs`: folders in which everything counts as used, for patterns with syntax that is not evaluated here.
 * - `under`: path prefixes below which everything counts as used, for a wildcard in a folder name (the server cannot
 *   expand those, but whatever wrote the pattern may).
 */
function globIndex(patterns) {
  const index = { under: [], dirs: new Set(), names: new Map() };
  for (const pattern of new Set(patterns)) {
    const cut = pattern.lastIndexOf("/");
    const dir = pattern.slice(0, cut), name = pattern.slice(cut + 1);
    const first = pattern.search(GLOB);
    if ((first !== -1) && (first < cut)) index.under.push(pattern.slice(0, first));
    else if (RICH.test(name)) index.dirs.add(dir);
    else {
      const literal = name.split(/[*?]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      let tests = index.names.get(dir);
      if (!tests) index.names.set(dir, tests = []);
      tests.push(new RegExp(`^${literal.join(".*")}$`, "s"));
    }
  }
  return index;
}

function matchesGlob(globs, spelling) {
  if (globs.under.some(prefix => spelling.startsWith(prefix))) return true;
  const cut = spelling.lastIndexOf("/");
  const dir = spelling.slice(0, cut), name = spelling.slice(cut + 1);
  return globs.dirs.has(dir) || !!globs.names.get(dir)?.some(test => test.test(name));
}

/* -------------------------------------------- */
/*  Search                                      */
/* -------------------------------------------- */

/** The forms a document may hold a path in, lowercase NFC like the searched text. */
function spellingsOf(path) {
  const p = path.normalize("NFC");
  return [...new Set([p, encodeSegments(p), encodeURI(p), p.replaceAll("&", "&amp;")].map(s => s.toLowerCase()))];
}

/**
 * The paths among `paths` that the world still uses: mentioned somewhere in its text in any spelling, or matched by
 * a file pattern. A path that cannot be searched for counts as used.
 *
 * All paths are searched in one pass. Every spelling starts with ANCHOR, so the spellings go into a character trie
 * and the trie is walked from each place the text holds ANCHOR: the cost follows the size of the text, not the size
 * of the text times the number of files (a full-text search per file freezes the tab on a big world). The loop
 * yields between the pieces of the text.
 * @param {Usage} usage
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 * @returns {Promise<Set<string>>}
 */
async function usedPaths(usage, paths, signal) {
  const used = new Set();
  const root = new Map();
  for (const path of paths) {
    let spellings = [];
    try { spellings = spellingsOf(path); }
    catch { /* encodeURI refuses a lone surrogate */ }
    if (!spellings.length || !spellings.every(s => s.startsWith(ANCHOR))
      || spellings.some(s => matchesGlob(usage.globs, s))) {
      used.add(path);
      continue;
    }
    for (const spelling of spellings) {
      let node = root;
      for (let i = ANCHOR.length; i < spelling.length; i++) {
        let next = node.get(spelling[i]);
        if (!next) node.set(spelling[i], next = new Map());
        node = next;
      }
      if (!node.has(END)) node.set(END, []);
      node.get(END).push(path);
    }
  }

  const pace = pacer(signal);
  for (const text of usage.texts) {
    for (let at = text.indexOf(ANCHOR); at !== -1; at = text.indexOf(ANCHOR, at + 1)) {
      // Every spelling that the text continues with from here is a mention, also as the start of a longer name.
      for (let node = root, i = at + ANCHOR.length; node; node = node.get(text[i++])) {
        for (const path of node.get(END) ?? []) used.add(path);
      }
    }
    await pace();
  }
  return used;
}

/* -------------------------------------------- */

/** Set (time) or clear (undefined) `cleaned`, durably. Throws when the write fails. */
async function mark(originals, cleaned) {
  await putEntries(originals.map(original => ({ original, cleaned })), { now: true });
}

function assertCoordinator() {
  if (!game.user.isGM || !isCoordinator()) throw new Error(t("NotCoordinator"));
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
