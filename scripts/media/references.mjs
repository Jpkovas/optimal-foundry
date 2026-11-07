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
 */

const MEDIA_EXT = new Set([...EXT.image, ...EXT.video, ...EXT.audio]);
/** World documents never scanned: our own library lives in a Setting; chat and fog are history, not content. */
const SKIP_DOCUMENTS = new Set(["ChatMessage", "FogExploration", "Setting"]);
const HTML_HINT = /<(?:img|video|audio|source|a)\b/i;
const TAG_RE = /<(img|video|audio|source|a)\b[^>]*>/gi;
const ATTR_RE = /(\s)(src|href|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** Markdown image/link targets: `![alt](target)` and `[text](target)`; group 1 keeps everything before the target. */
const MD_RE = /(!?\[[^\]]*\]\(\s*<?)([^)\s>]+)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PLAIN_DEPTH = 16;
const YIELD_EVERY = 40;

const yieldTick = () => new Promise(resolve => setTimeout(resolve, 0));

/* -------------------------------------------- */
/*  Collection                                  */
/* -------------------------------------------- */

/**
 * Walk every world document (and world compendium documents when asked) and return the media they reference.
 * @param {{includeCompendia?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<Map<string, Ref[]>>} normalized path -> references
 */
export async function collectReferences({ includeCompendia = false, signal, unread } = {}) {
  const out = new Map();
  let count = 0;
  const visit = async doc => {
    try { walkDocument(doc, out, true, unread); }
    catch (err) { warn(`could not scan ${doc?.uuid}`, err); }
    if (++count % YIELD_EVERY === 0) {
      await yieldTick();
      signal?.throwIfAborted();
    }
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
  if (!schema || !doc._source) return;
  const ctx = { uuid: doc.uuid, docName: doc.documentName, out, inSystem: false, unread };
  walkSchema(schema, doc._source, "", null, ctx, 0);
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

  // Delta collections hold partial data whose semantics differ from plain arrays: never touch them.
  if (field instanceof F.EmbeddedCollectionDeltaField) return;
  if (field instanceof F.EmbeddedCollectionField) {
    // Top level of a live document: children are walked as documents. Deeper (e.g. Adventure contents): raw data.
    if (depth === 0) return;
    if (!Array.isArray(value)) return;
    const up = updatePath ?? path;
    value.forEach((v, i) => walkSchema(field.schema, v, join(path, i), up, ctx, depth + 1));
    return;
  }
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

function push(out, key, ref) {
  let list = out.get(key);
  if (!list) out.set(key, list = []);
  list.push(ref);
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
 * Re-point references. Each document is updated once with all its changed fields, then read back.
 * Counts are per reference (field occurrence).
 * @param {Map<string, string>} map   from path -> to path (any form; normalized here)
 * @param {{refs: Map<string, Ref[]>|Ref[], protect?: (ref: Ref) => boolean}} options
 *   refs: the collection result (or a plain list).
 *   protect: return true to defer a reference (returned in `deferred`, untouched).
 * @returns {Promise<{updated: number, skipped: number, failed: number, deferred: Ref[], failedFrom: string[]}>}
 */
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
    let deferred = false;
    try { deferred = !!protect?.(ref); }
    catch (err) { warn("protect() failed, deferring", err); deferred = true; }
    if (deferred) { result.deferred.push(ref); continue; }
    let group = byDoc.get(ref.uuid);
    if (!group) byDoc.set(ref.uuid, group = []);
    group.push(ref);
  }

  const failedFrom = new Set();
  const unlocked = new Map(); // pack -> previous `locked` config value
  try {
    for (const [uuid, group] of byDoc) {
      try { await rewriteDocument(uuid, group, norm, result, failedFrom, unlocked); }
      catch (err) {
        warn(`rewrite failed for ${uuid}`, err);
        for (const r of group) { result.failed++; if (r.from) failedFrom.add(r.from); }
      }
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

async function rewriteDocument(uuid, refs, map, result, failedFrom, unlocked) {
  const fail = (items, why, err) => {
    warn(`rewrite failed for ${uuid}: ${why}`, err ?? "");
    for (const it of items) {
      result.failed++;
      for (const k of it.keys ?? [it.from]) if (k) failedFrom.add(k);
    }
  };

  const doc = await resolveDoc(uuid);
  if (!doc) return fail(refs, "document not found");

  if (doc.pack) {
    const pack = game.packs.get(doc.pack);
    if (!pack || (pack.metadata?.packageType !== "world")) { result.skipped += refs.length; return; }
    if (pack.locked && !unlocked.has(pack)) {
      try {
        const previous = pack.config?.locked;
        await pack.configure({ locked: false });
        unlocked.set(pack, previous);
      }
      catch (err) { return fail(refs, "compendium is locked", err); }
    }
  }

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

  if (!expectations.length) return;
  if (Object.keys(changes).length) {
    // A local _onUpdate side effect can throw after the server already stored the change
    // (e.g. PlaylistSound before audio is unlocked), so only the read-back below decides.
    try { await doc.update(changes, { [MODULE_ID]: { rewrite: true } }); }
    catch (err) { warn(`update of ${uuid} threw; verifying what was stored`, err); }
  }

  // v14 silently drops writes to some fields (deprecated shims): verify against the stored source.
  const fresh = (await resolveDoc(uuid)) ?? doc;
  for (const e of expectations) {
    const now = foundry.utils.getProperty(fresh._source, e.fieldPath);
    const hasKey = e.markdown ? markdownHasKey : htmlHasKey;
    const ok = e.keys
      ? (typeof now === "string") && !e.keys.some(k => hasKey(now, k))
      : now === e.value;
    if (ok) result.updated++;
    else fail([e], `${e.fieldPath} did not persist`);
  }
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
