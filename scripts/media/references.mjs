import { MODULE_ID, EXT, warn, extOf } from "../constants.mjs";
import { normalizePath } from "../library.mjs";

/**
 * Media reference discovery and rewriting.
 *
 * @typedef {object} Ref
 * @property {string} uuid         Document that holds the reference
 * @property {string} fieldPath    Dotted path of the string inside the document source (array indices included)
 * @property {"image"|"texture"|"video"|"audio"|"html"|"markdown"|"string"} kind
 * @property {string} docName      Document type
 * @property {string} updatePath   Key used in doc.update: equals fieldPath, or the outermost array containing it
 *                                 (arrays cannot be patched by index, they are replaced whole)
 * @property {string[]} [categories] FilePathField categories, used to validate the new extension
 * @property {string} [pattern]    Set on a "pattern reference": the field holds this wildcard pattern (wildcard token art),
 *                                 not the file the reference is listed under. Such a reference is never re-pointed by path.
 */

const MEDIA_EXT = new Set([...EXT.image, ...EXT.video, ...EXT.audio]);
/** A media (or SVG) extension at the end of the value or right before its query: the cheap test before normalizing. */
const MEDIA_HINT = new RegExp(`\\.(?:${[...MEDIA_EXT, "svg"].join("|")})(?:[?#]|$)`, "i");
/**
 * Documents never scanned: our own library lives in a Setting; chat and fog are history, not content. An Adventure is
 * a snapshot waiting to be imported: re-pointing one replaces its whole `scenes`/`actors` arrays (megabytes per
 * update), and the documents it creates on import are re-pointed by the document hooks anyway.
 */
const SKIP_DOCUMENTS = new Set(["ChatMessage", "FogExploration", "Setting", "Adventure"]);
const HTML_HINT = /<(?:img|video|audio|source|a)\b/i;
const TAG_RE = /<(img|video|audio|source|a)\b[^>]*>/gi;
const ATTR_RE = /(\s)(src|href|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** Markdown image/link targets: `![alt](target)` and `[text](target)`; group 1 keeps everything before the target. */
const MD_RE = /(!?\[[^\]]*\]\(\s*<?)([^)\s>]+)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PLAIN_DEPTH = 16;
/** Main-thread work between two yields to the browser (a frame at 60 fps is 16 ms). */
const SLICE_MS = 12;
/** One grouped update is one request, broadcast to every client: keep each one modest. */
const GROUP_MAX_DOCS = 200;
const GROUP_MAX_CHARS = 1_000_000;
/** The field of an actor that holds the art (or the pattern of the art) of its tokens, and where the old pattern is kept. */
const TOKEN_ART = "prototypeToken.texture.src";
const PATTERN_FLAG = `flags.${MODULE_ID}.tokenPattern`;

/**
 * For long loops: returns a function to await after each item. It yields to the browser once about SLICE_MS of work
 * has passed since the last yield, however many items that took, and then honours the abort signal.
 * @param {AbortSignal} [signal]
 * @returns {() => Promise<void>}
 */
export function pacer(signal) {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    since = performance.now();
  };
}

/* -------------------------------------------- */
/*  Collection                                  */
/* -------------------------------------------- */

/**
 * Walk every world document (and world compendium documents when asked) and return the media they reference.
 * The art pattern of an actor whose prototype token picks a random image (`tokens/goblin-*.png`) is listed under the
 * pattern itself (a key with a `*`, which no file path has); `expandPatterns` swaps it for the files it matches.
 * @param {{includeCompendia?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<Map<string, Ref[]>>} normalized path -> references
 */
export async function collectReferences({ includeCompendia = false, signal, unread } = {}) {
  const out = new Map();
  // By elapsed time, not by count: forty actors with hundreds of items each are one long task.
  const pace = pacer(signal);
  const visit = async doc => {
    try { walkDocument(doc, out, true, unread); }
    catch (err) { warn(`could not scan ${doc?.uuid}`, err); }
    await pace();
  };

  for (const collection of game.collections ?? []) {
    if (SKIP_DOCUMENTS.has(collection.documentName)) continue;
    for (const doc of collection) await visit(doc);
  }

  if (includeCompendia) {
    for (const pack of game.packs ?? []) {
      if (pack.metadata?.packageType !== "world" || SKIP_DOCUMENTS.has(pack.documentName)) continue;
      let docs;
      try { docs = await pack.getDocuments(); }
      catch (err) { warn(`could not load compendium ${pack.collection}`, err); continue; }
      // getDocuments returns fresh instances even when the pack already caches one; prefer the cached instance.
      for (const d of docs) await visit(pack.get(d.id) ?? d);
    }
  }
  return out;
}

/**
 * References held by one document. Embedded children are walked when `children` is true (a create: children
 * created with their parent fire no hooks of their own); an update of a parent leaves them out.
 * @param {foundry.abstract.Document} doc
 * @param {{children?: boolean}} [options]
 * @returns {Map<string, Ref[]>}
 */
export function collectDocumentReferences(doc, { children = true } = {}) {
  const out = new Map();
  walkDocument(doc, out, children);
  return out;
}

function walkDocument(doc, out, children, unread) {
  const schema = doc?.constructor?.schema;
  if (!schema || !doc._source || SKIP_DOCUMENTS.has(doc.documentName)) return;
  const ctx = { uuid: doc.uuid, docName: doc.documentName, out, inSystem: false, unread };
  walkSchema(schema, doc._source, "", null, ctx, 0);
  if (doc.documentName === "Actor") addTokenPattern(ctx, doc._source.prototypeToken);
  if (!children) return;

  // Live embedded documents carry their own uuid and are updated on their own.
  for (const [name, field] of Object.entries(doc.constructor.hierarchy ?? {})) {
    const F = foundry.data.fields;
    if (!(field instanceof F.EmbeddedCollectionField) || (field instanceof F.EmbeddedCollectionDeltaField)) continue;
    const collection = doc[name];
    if (!collection) continue;
    for (const child of collection) walkDocument(child, out, true, unread);
  }
}

function walkSchema(schema, source, path, updatePath, ctx, depth) {
  if (!source || typeof source !== "object") return;
  for (const [name, field] of schema.entries()) {
    walkField(field, source[name], join(path, name), updatePath, source, ctx, depth);
  }
}

function walkField(field, value, path, updatePath, parentSource, ctx, depth) {
  if (value === null || value === undefined) return;
  const F = foundry.data.fields;

  // Children are walked as documents of their own (walkDocument). Delta collections (an unlinked token's changes to
  // its actor's items) hold partial data whose semantics differ from plain arrays: never touched.
  if (field instanceof F.EmbeddedCollectionField) return;
  if (field instanceof F.ArrayField) {
    if (!Array.isArray(value)) return;
    const up = updatePath ?? path;
    const el = field.element;
    value.forEach((v, i) => {
      if (el instanceof F.DataField) walkField(el, v, join(path, i), up, value, ctx, depth + 1);
      else walkPlain(v, join(path, i), up, ctx, depth + 1);
    });
    return;
  }
  if (field instanceof F.TypeDataField) {
    const model = field.getModelForType(parentSource?.type);
    const sub = { ...ctx, inSystem: true };
    if (model?.schema) walkSchema(model.schema, value, path, updatePath, sub, depth + 1);
    else walkPlain(value, path, updatePath, sub, depth + 1);
    return;
  }
  if (field instanceof F.SchemaField) {
    walkSchema(field, value, path, updatePath, ctx, depth + 1);
    return;
  }
  if (field instanceof F.HTMLField) {
    if (typeof value === "string") addHtml(ctx, value, path, updatePath);
    return;
  }
  if (field instanceof F.FilePathField) {
    const kind = kindFromCategories(field.categories);
    if (kind) addFile(ctx, value, path, updatePath, kind, [...field.categories]);
    return;
  }
  if ((field instanceof F.JavaScriptField) || (field instanceof F.JSONField)) return;
  if (field instanceof F.StringField) {
    if (typeof value !== "string") return;
    // JournalEntryPage#src is a plain StringField holding the image/video path.
    if ((depth === 0) && (path === "src") && (ctx.docName === "JournalEntryPage")) {
      const kind = { image: "image", video: "video" }[parentSource?.type] ?? "string";
      addFile(ctx, value, path, updatePath, kind);
    }
    // Markdown pages: the server rebuilds text.content from text.markdown on every update, so both are rewritten.
    else if ((path === "text.markdown") && (ctx.docName === "JournalEntryPage")
      && (parentSource?.format === CONST.JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN)) addMarkdown(ctx, value, path, updatePath);
    // System models sometimes store paths or HTML in plain StringFields.
    else if (ctx.inSystem) addString(ctx, value, path, updatePath);
    return;
  }
  if (field instanceof F.TypedObjectField) {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (!safeKey(k) || ((depth === 0) && (path === "flags") && (k === MODULE_ID))) continue;
      walkField(field.element, v, join(path, k), updatePath, value, ctx, depth + 1);
    }
    return;
  }
  if ((field instanceof F.ObjectField) || (field instanceof F.AnyField) || (field instanceof F.TypedSchemaField)) {
    walkPlain(value, path, updatePath, ctx, depth + 1);
  }
}

/** Untyped data (flags, legacy template.json systems): exact media-path strings and HTML only. */
function walkPlain(value, path, updatePath, ctx, depth) {
  if (depth > MAX_PLAIN_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") return addString(ctx, value, path, updatePath);
  if (Array.isArray(value)) {
    const up = updatePath ?? path;
    value.forEach((v, i) => walkPlain(v, join(path, i), up, ctx, depth + 1));
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return;
  for (const [k, v] of Object.entries(value)) {
    if (safeKey(k)) walkPlain(v, join(path, k), updatePath, ctx, depth + 1);
  }
}

/**
 * Wildcard token art: a prototype token with `randomImg` whose art holds a `*`. Every placed token loads one of the files
 * the pattern matches (the document holds the pattern, never a file), so those files are references of this actor.
 */
function addTokenPattern(ctx, token) {
  const pattern = token?.texture?.src;
  if ((token?.randomImg !== true) || (typeof pattern !== "string")) return;
  const key = pattern.trim();
  if (!key.includes("*") || key.startsWith("#") || SCHEME_RE.test(key) || key.startsWith("//")) return;
  push(ctx.out, key, { uuid: ctx.uuid, fieldPath: TOKEN_ART, updatePath: TOKEN_ART, kind: "texture", docName: "Actor", pattern: key });
}

function addString(ctx, value, path, updatePath) {
  if (HTML_HINT.test(value)) return addHtml(ctx, value, path, updatePath);
  if ((value.length > 2048) || /[\n\r<>"]/.test(value)) return;
  addFile(ctx, value, path, updatePath, "string");
}

function addFile(ctx, raw, path, updatePath, kind, categories) {
  const key = mediaKey(raw, ctx.unread);
  if (!key) return;
  push(ctx.out, key, { uuid: ctx.uuid, fieldPath: path, updatePath: updatePath ?? path, kind, docName: ctx.docName, categories });
}

function addHtml(ctx, html, path, updatePath) {
  if (!HTML_HINT.test(html)) return;
  const seen = new Set();
  for (const raw of htmlValues(html)) {
    const key = mediaKey(decodeEntities(raw), ctx.unread);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    push(ctx.out, key, { uuid: ctx.uuid, fieldPath: path, updatePath: updatePath ?? path, kind: "html", docName: ctx.docName });
  }
}

function addMarkdown(ctx, md, path, updatePath) {
  const seen = new Set();
  for (const raw of markdownValues(md)) {
    const key = mediaKey(decodeEntities(raw), ctx.unread);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    push(ctx.out, key, { uuid: ctx.uuid, fieldPath: path, updatePath: updatePath ?? path, kind: "markdown", docName: ctx.docName });
  }
}

function push(out, key, ...refs) {
  let list = out.get(key);
  if (!list) out.set(key, list = []);
  list.push(...refs);
}

/**
 * Normalized key of a local media path, or null for virtual, wildcard, base64, foreign or non-media values.
 * `unread` ({external: Set, vector: Set}), when given, collects media the scan sees but cannot process: files on
 * another host (S3, CDN, another site) and SVG images.
 */
function mediaKey(raw, unread) {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.startsWith("#") || v.startsWith("data:") || v.includes("*")) return null;
  // Most strings a document holds are not files: reject them before paying for normalizePath. Exact for anything
  // without percent-encoding (normalizing only cuts the query and decodes); encoded values take the full path below.
  if (!MEDIA_HINT.test(v) && !v.includes("%")) return null;
  // Other hosts, judged on the raw value: normalizePath strips the leading slashes of "//host/a.png".
  if (SCHEME_RE.test(v) || v.startsWith("//")) {
    if (unread && MEDIA_EXT.has(extOf(v.split(/[?#]/)[0]))) unread.external.add(v);
    return null;
  }
  const key = normalizePath(v);
  if (!key) return null;
  const ext = extOf(key);
  if (SCHEME_RE.test(key)) return null;
  if (MEDIA_EXT.has(ext)) return key;
  if (unread && ext === "svg") unread.vector.add(key);
  return null;
}

/** Is this key of a reference map a wildcard pattern (see collectReferences) and not a file? Real keys never hold a `*`. */
export const isPatternKey = key => String(key).includes("*");

/**
 * The media files a pattern matches, the way Foundry lists the art of a wildcard token (the server's browse with
 * `wildcard`). Null when the server cannot say, so a caller never mistakes "unknown" for "no files".
 * @param {string} pattern  As written in the field
 * @returns {Promise<Set<string>|null>} normalized paths
 */
export async function matchPattern(pattern) {
  try {
    const result = await foundry.applications.apps.FilePicker.implementation.browse("data", pattern, { wildcard: true });
    return new Set((result?.files ?? []).map(file => mediaKey(file)).filter(Boolean));
  }
  catch (err) {
    warn(`could not list the files of ${pattern}`, err);
    return null;
  }
}

/**
 * Replace each pattern key of a collection result by the files it matches: the pattern references join the references
 * of those files (they keep `pattern`), so a file behind wildcard token art is optimized like any other.
 * @param {Map<string, Ref[]>} refs  Changed in place
 */
export async function expandPatterns(refs) {
  for (const key of [...refs.keys()].filter(isPatternKey)) {
    const list = refs.get(key);
    refs.delete(key);
    for (const file of (await matchPattern(key)) ?? []) push(refs, file, ...list);
  }
}

function kindFromCategories(categories = []) {
  const c = new Set(categories);
  if (c.has("TEXTURE") || (c.has("IMAGE") && c.has("VIDEO"))) return "texture";
  if (c.has("VIDEO")) return "video";
  if (c.has("IMAGE")) return "image";
  if (c.has("AUDIO")) return "audio";
  return null;
}

function* htmlValues(html) {
  for (const [tag] of html.matchAll(TAG_RE)) {
    for (const m of tag.matchAll(ATTR_RE)) yield m[4] ?? m[5] ?? m[6] ?? "";
  }
}

/** Markdown targets plus raw HTML tags written inside the Markdown. */
function* markdownValues(md) {
  for (const m of md.matchAll(MD_RE)) yield m[2];
  yield* htmlValues(md);
}

/* -------------------------------------------- */
/*  Rewriting                                   */
/* -------------------------------------------- */

/**
 * Installed on every client. Core's PlaylistSound#_onUpdate recreates the Sound when `path` changes and throws while
 * game audio is locked (a player who has not clicked yet), so each rewrite of a playlist track would surface as an
 * uncaught error on those clients. Sounds are created lazily (`sound ||= _createSound()`) once audio unlocks, so the
 * eager recreation is skipped while locked.
 */
export function installRewriteGuards() {
  libWrapper.register(MODULE_ID, "foundry.documents.PlaylistSound.prototype._onUpdate", function (wrapped, changed, ...args) {
    if (!game.audio?.locked || !(("path" in changed) || ("channel" in changed))) return wrapped(changed, ...args);
    this.sound?.stop();
    this.sound = null;
    this._createSound = () => null; // instance shadow for this synchronous call only
    try { return wrapped(changed, ...args); }
    finally { delete this._createSound; }
  }, "WRAPPER");
}

/**
 * Re-point references. Each document gets all its changed fields in one update, and the documents are sent in
 * groups: one request per document type under the same parent (an actor's items, a scene's tokens), and one per
 * top-level type in the world or in a compendium. A hundred items sharing an icon are one broadcast and one
 * re-preparation of their actor on every client instead of a hundred. Every value is then read back from the stored
 * source, which alone decides success. Counts are per reference (field occurrence).
 * @param {Map<string, string>} map   from path -> to path (any form; normalized here)
 * @param {{refs: Map<string, Ref[]>|Ref[], protect?: (ref: Ref) => boolean}} options
 *   refs: the collection result (or a plain list).
 *   protect: return true to defer a reference (returned in `deferred`, untouched).
 * @returns {Promise<{updated: number, skipped: number, failed: number, deferred: Ref[], failedFrom: string[]}>}
 */
export async function rewriteReferences(map, { refs, protect }) {
  const result = { updated: 0, skipped: 0, failed: 0, deferred: [], failedFrom: [] };
  const norm = new Map();
  for (const [from, to] of map ?? []) {
    const f = normalizePath(from), t = normalizePath(to);
    if (f && t && (f !== t)) norm.set(f, t);
  }
  if (!norm.size) return result;

  let list;
  if (refs instanceof Map) list = [...norm.keys()].flatMap(k => (refs.get(k) ?? []).map(r => ({ ...r, from: k })));
  else {
    const only = norm.size === 1 ? norm.keys().next().value : null;
    list = (Array.isArray(refs) ? refs : []).map(r => ({ ...r, from: r.from ?? only }));
  }

  const byDoc = new Map();
  for (const ref of list) {
    // A pattern reference holds a wildcard, not the file: the pattern is changed as a whole (setTokenPatterns).
    if (ref.pattern) continue;
    // Adventures are never re-pointed (see SKIP_DOCUMENTS): the collection leaves them out, and a list built
    // elsewhere is held to the same rule.
    if (ref.docName === "Adventure") { result.skipped++; continue; }
    let deferred = false;
    try { deferred = !!protect?.(ref); }
    catch (err) { warn("protect() failed, deferring", err); deferred = true; }
    if (deferred) { result.deferred.push(ref); continue; }
    let group = byDoc.get(ref.uuid);
    if (!group) byDoc.set(ref.uuid, group = []);
    group.push(ref);
  }

  const failedFrom = new Set();
  const fail = (uuid, items, why, err) => {
    warn(`rewrite failed for ${uuid}: ${why}`, err ?? "");
    for (const it of items) {
      result.failed++;
      for (const k of it.keys ?? [it.from]) if (k) failedFrom.add(k);
    }
  };
  const unlocked = new Map(); // pack -> previous `locked` config value
  try {
    // Documents that can share one request: the same type under the same parent, or the same top-level type in the
    // world or in one compendium.
    const targets = new Map();
    for (const [uuid, group] of byDoc) {
      let doc = null;
      try { doc = await resolveTarget(uuid, group, result, fail, unlocked); }
      catch (err) { fail(uuid, group, "could not load the document", err); }
      if (!doc) continue;
      const key = `${doc.documentName}|${doc.parent?.uuid ?? ""}|${doc.pack ?? ""}`;
      let target = targets.get(key);
      if (!target) targets.set(key, target = []);
      target.push({ uuid, doc, refs: group });
    }

    // Each document is planned from its source right before its group is sent (arrays are replaced whole, so a plan
    // must not sit around while the document is edited). A group is cut at GROUP_MAX_DOCS documents or about
    // GROUP_MAX_CHARS of changed data: journal pages carry their whole HTML.
    const plans = [];
    for (const target of targets.values()) {
      let batch = [], size = 0;
      const send = async () => {
        if (batch.length) await updateGroup(batch);
        batch = [];
        size = 0;
      };
      for (const { uuid, doc, refs: group } of target) {
        let plan = null;
        try { plan = planDocument(uuid, doc, group, norm, result); }
        catch (err) { fail(uuid, group, "could not prepare the update", err); }
        if (!plan) continue;
        plans.push(plan);
        if (!Object.keys(plan.changes).length) continue;
        batch.push(plan);
        size += JSON.stringify(plan.changes).length;
        if ((batch.length >= GROUP_MAX_DOCS) || (size >= GROUP_MAX_CHARS)) await send();
      }
      await send();
    }

    // v14 silently drops writes to some fields (deprecated shims): verify against the stored source.
    for (const plan of plans) {
      const fresh = (await resolveDoc(plan.uuid)) ?? plan.doc;
      const missing = unmet(fresh, plan.expectations);
      result.updated += plan.expectations.length - missing.length;
      for (const e of missing) fail(plan.uuid, [e], `${e.fieldPath} did not persist`);
    }
  }
  finally {
    for (const [pack, previous] of unlocked) {
      try { await pack.configure({ locked: previous }); }
      catch (err) { warn(`could not re-lock compendium ${pack.collection}`, err); }
    }
  }
  result.failedFrom = [...failedFrom];
  return result;
}

/**
 * The document behind a uuid, ready to be written: null when it is gone, or lives in a compendium that is never
 * written (a module's or the system's) or that cannot be unlocked. A locked world compendium is unlocked here and
 * recorded in `unlocked`, so the caller locks it again.
 */
async function resolveTarget(uuid, refs, result, fail, unlocked) {
  const doc = await resolveDoc(uuid);
  if (!doc) { fail(uuid, refs, "document not found"); return null; }
  if (!doc.pack) return doc;
  const pack = game.packs.get(doc.pack);
  if (!pack || (pack.metadata?.packageType !== "world")) { result.skipped += refs.length; return null; }
  if (pack.locked && !unlocked.has(pack)) {
    try {
      const previous = pack.config?.locked;
      await pack.configure({ locked: false });
      unlocked.set(pack, previous);
    }
    catch (err) { fail(uuid, refs, "compendium is locked", err); return null; }
  }
  return doc;
}

/**
 * What one document needs: the changes to send and what the stored source must hold afterwards. Null when none of
 * its references needs a change.
 * @returns {{uuid: string, doc: foundry.abstract.Document, changes: object, expectations: object[]}|null}
 */
function planDocument(uuid, doc, refs, map, result) {
  // One change per update key; arrays are cloned once and edited in place.
  const changes = {};
  const expectations = []; // {fieldPath, value} for paths, {fieldPath, keys} for HTML
  const byUpdate = new Map();
  for (const ref of refs) {
    let g = byUpdate.get(ref.updatePath);
    if (!g) byUpdate.set(ref.updatePath, g = []);
    g.push(ref);
  }

  for (const [updatePath, group] of byUpdate) {
    const current = foundry.utils.getProperty(doc._source, updatePath);
    const nested = group.some(r => r.fieldPath !== updatePath);
    let next = nested ? foundry.utils.deepClone(current) : current;
    let changed = false;
    const htmlDone = new Map(); // fieldPath -> keys replaced in that field

    for (const ref of group) {
      const rel = ref.fieldPath === updatePath ? null : ref.fieldPath.slice(updatePath.length + 1);
      const leaf = rel === null ? next : foundry.utils.getProperty(next, rel);
      if (typeof leaf !== "string") { result.skipped++; continue; }

      let out;
      if ((ref.kind === "html") || (ref.kind === "markdown")) {
        const markdown = ref.kind === "markdown";
        let replaced = htmlDone.get(ref.fieldPath);
        const first = !replaced;
        if (first) {
          replaced = new Set();
          out = markdown ? rewriteMarkdown(leaf, map, replaced) : rewriteHtml(leaf, map, replaced);
          htmlDone.set(ref.fieldPath, replaced);
        }
        const keys = ref.from ? (replaced.has(ref.from) ? [ref.from] : []) : [...replaced];
        if (!keys.length) { result.skipped++; continue; }
        expectations.push({ fieldPath: ref.fieldPath, keys, markdown });
        if (!first || (out === leaf)) continue;
      }
      else {
        const key = normalizePath(leaf);
        const to = map.get(key);
        if (!to || (ref.from && (ref.from !== key))) { result.skipped++; continue; } // value changed since the scan
        if (ref.categories?.length && !extAllowed(to, ref.categories)) {
          warn(`not re-pointing ${uuid} ${ref.fieldPath}: .${extOf(to)} is not accepted by that field`);
          result.skipped++;
          continue;
        }
        out = formatLike(leaf, to);
        expectations.push({ fieldPath: ref.fieldPath, value: out, from: key });
      }
      if (rel === null) next = out;
      else foundry.utils.setProperty(next, rel, out);
      changed = true;
    }
    if (changed) changes[updatePath] = next;
  }

  return expectations.length ? { uuid, doc, changes, expectations } : null;
}

/** The operation options of every rewrite; the backfill's document hooks ignore updates that carry the flag. */
const rewriteOperation = () => ({ [MODULE_ID]: { rewrite: true } });

/**
 * Change the art pattern of actors' prototype tokens, each in one update that carries the rewrite flag.
 * With `to`, the field becomes `to` and the old pattern (`from`) is remembered in the actor's flag
 * `flags.optimal-foundry.tokenPattern`; without it, the remembered pattern is put back and the flag removed.
 * An actor whose field no longer holds `from` (edited since the scan), or has nothing to put back, is left alone.
 * The stored source alone decides success.
 * @param {{uuid: string, from: string, to?: string}[]} items
 * @returns {Promise<{updated: number, skipped: number, failed: number}>}
 */
export async function setTokenPatterns(items) {
  const result = { updated: 0, skipped: 0, failed: 0 };
  const fail = (uuid, _refs, why, err) => { warn(`token art pattern of ${uuid}: ${why}`, err ?? ""); result.failed++; };
  const unlocked = new Map();
  try {
    for (const { uuid, from, to } of items) {
      try {
        const doc = await resolveTarget(uuid, [], result, fail, unlocked);
        if (!doc) continue;
        const next = to ?? foundry.utils.getProperty(doc._source, PATTERN_FLAG);
        if ((foundry.utils.getProperty(doc._source, TOKEN_ART) !== from) || (typeof next !== "string") || (next === from)) {
          result.skipped++;
          continue;
        }
        const flag = to ? { [PATTERN_FLAG]: from } : { flags: { [MODULE_ID]: { tokenPattern: new foundry.data.operators.ForcedDeletion() } } };
        const changes = { [TOKEN_ART]: next, ...flag };
        try { await doc.update(changes, rewriteOperation()); }
        catch (err) { warn(`update of ${uuid} threw; verifying what was stored`, err); }
        const stored = (await resolveDoc(uuid)) ?? doc;
        if (foundry.utils.getProperty(stored._source, TOKEN_ART) === next) result.updated++;
        else fail(uuid, [], `${TOKEN_ART} did not persist`);
      }
      catch (err) { fail(uuid, [], "could not update the actor", err); }
    }
  }
  finally {
    for (const [pack, previous] of unlocked) {
      try { await pack.configure({ locked: previous }); }
      catch (err) { warn(`could not re-lock compendium ${pack.collection}`, err); }
    }
  }
  return result;
}

/** Send one group: what `doc.update()` does for one document (same class, parent and pack), for all of them. */
async function updateGroup(plans) {
  const { doc } = plans[0];
  try {
    await doc.constructor.updateDocuments(plans.map(p => ({ _id: p.doc.id, ...p.changes })),
      { ...rewriteOperation(), parent: doc.parent, pack: doc.pack });
  }
  catch (err) {
    // A local _onUpdate side effect can throw after the server already stored the change
    // (e.g. PlaylistSound before audio is unlocked), so only the read-back decides.
    warn(`update of ${plans.length} ${doc.documentName} document(s) threw; verifying what was stored`, err);
    if (plans.length === 1) return;
    // An error before the request left (one document's _preUpdate, or a preUpdate hook, throwing) stops the whole
    // group. Whatever was not stored gets its own update, so one bad document fails alone, as it did ungrouped.
    for (const plan of plans) {
      if (!unmet(plan.doc, plan.expectations).length) continue;
      try { await plan.doc.update(plan.changes, rewriteOperation()); }
      catch (e) { warn(`update of ${plan.uuid} threw; verifying what was stored`, e); }
    }
  }
}

/** The expectations the stored source of a document does not meet. */
function unmet(doc, expectations) {
  return expectations.filter(e => {
    const now = foundry.utils.getProperty(doc._source, e.fieldPath);
    if (!e.keys) return now !== e.value;
    const hasKey = e.markdown ? markdownHasKey : htmlHasKey;
    return (typeof now !== "string") || e.keys.some(k => hasKey(now, k));
  });
}

/** fromUuid loads world, compendium and embedded documents on demand. */
async function resolveDoc(uuid) {
  try { return (await foundry.utils.fromUuid(uuid)) ?? null; }
  catch { return null; }
}

function extAllowed(path, categories) {
  const ext = extOf(path);
  return categories.some(c => (c !== "MEDIA") && (ext in (CONST.FILE_CATEGORIES[c] ?? {})));
}

function rewriteHtml(html, map, replaced) {
  return html.replace(TAG_RE, tag => tag.replace(ATTR_RE, (match, space, name, eq, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare ?? "";
    const decoded = decodeEntities(raw);
    const key = normalizePath(decoded.trim());
    const to = map.get(key);
    if (!to) return match;
    replaced.add(key);
    return `${space}${name}${eq}"${escapeAttr(formatLike(decoded, to))}"`;
  }));
}

function htmlHasKey(html, key) {
  for (const raw of htmlValues(html)) if (normalizePath(decodeEntities(raw).trim()) === key) return true;
  return false;
}

function rewriteMarkdown(md, map, replaced) {
  const out = md.replace(MD_RE, (match, before, target) => {
    const decoded = decodeEntities(target);
    const key = normalizePath(decoded.trim());
    const to = map.get(key);
    if (!to) return match;
    replaced.add(key);
    // Markdown targets cannot hold spaces unless encoded.
    return `${before}${formatLike(decoded, to).replace(/ /g, "%20")}`;
  });
  return rewriteHtml(out, map, replaced);
}

function markdownHasKey(md, key) {
  for (const raw of markdownValues(md)) if (normalizePath(decodeEntities(raw).trim()) === key) return true;
  return false;
}

/** Write `to` in the same style as the original value (leading slash, origin, route prefix, percent-encoding). */
function formatLike(raw, to) {
  const v = raw.trim();
  let decoded = v;
  try { decoded = decodeURI(v); } catch { /* keep as is */ }
  const body = decoded !== v ? encodeURI(to) : to;
  const prefix = globalThis.ROUTE_PREFIX ? String(globalThis.ROUTE_PREFIX).replace(/^\/+|\/+$/g, "") : "";
  const keepPrefix = p => (prefix && p.replace(/^\/+/, "").startsWith(`${prefix}/`)) ? `${prefix}/` : "";
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return `${u.origin}/${keepPrefix(u.pathname)}${body}`;
    } catch { return body; }
  }
  if (v.startsWith("/")) return `/${keepPrefix(v)}${body}`;
  return body;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const join = (path, key) => (path ? `${path}.${key}` : String(key));
const safeKey = k => !!k && !k.includes(".");
