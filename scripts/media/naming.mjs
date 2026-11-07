import { MIRROR_ROOT, OPTIMIZED_RE } from "../constants.mjs";
import { normalizePath } from "../library.mjs";

/** Top-level folders served from Foundry's own public directory, not from the Data root. */
export const CORE_PUBLIC_ROOTS = new Set([
  "canvas", "cards", "css", "docs", "fonts", "icons", "lang", "nue", "scripts", "sounds", "toolclips", "tours", "ui"
]);
const READ_ONLY_ROOTS = new Set(["modules", "systems"]);
const MAX_STEM = 120;
const isUrl = p => /^[a-z][a-z0-9+.-]*:/i.test(p);
/** Folders created or found this session (each createDirectory of an existing folder is a server error). */
const knownDirs = new Set();

/** The server decodeURIComponent()s browse/upload/createDirectory targets, so each segment is sent encoded. */
export const encodeSegments = path => String(path ?? "").split("/").map(encodeURIComponent).join("/");

/** Last path segment (no query/hash). */
export function baseName(path) {
  const clean = String(path ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** Everything before the last segment, without trailing slash ("" at the root). */
export function dirName(path) {
  const clean = String(path ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}

/**
 * File stem made safe for every storage backend: NFD, diacritics stripped, spaces to "-",
 * only [A-Za-z0-9._-] kept. A previous optimized marker is removed so names never stack markers.
 */
export function sanitizeStem(name) {
  let stem = String(name ?? "").split("/").pop();
  if (OPTIMIZED_RE.test(stem)) stem = stem.replace(OPTIMIZED_RE, "");
  else if (stem.includes(".")) stem = stem.slice(0, stem.lastIndexOf("."));
  stem = stem.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return stem.slice(0, MAX_STEM) || "media";
}

/** `<sanitized-stem>.of-<first 8 hex of sha256>.<ext>` */
export function optimizedName(originalName, sha256Hex, ext) {
  return `${sanitizeStem(originalName)}.of-${String(sha256Hex).slice(0, 8).toLowerCase()}.${ext}`;
}

/**
 * Where the optimized copy of an original goes. Same folder, except originals inside modules/, systems/,
 * Foundry's core public folders or another origin, which are mirrored under `optimal-foundry/<original dir>/`
 * at the Data root (module/system updates would wipe files written there).
 * @returns {{source: "data", dir: string, mirrored: boolean}}
 */
export function outputLocation(originalPath) {
  const p = normalizePath(originalPath);
  if (isUrl(p)) {
    let host = "external", dir = "";
    try { const u = new URL(p); host = u.hostname || host; dir = dirName(decodeURIComponent(u.pathname)).replace(/^\/+/, ""); } catch {}
    return { source: "data", dir: [MIRROR_ROOT, host, dir].filter(Boolean).join("/"), mirrored: true };
  }
  const dir = dirName(p);
  const top = p.split("/")[0];
  if (READ_ONLY_ROOTS.has(top) || CORE_PUBLIC_ROOTS.has(top)) {
    return { source: "data", dir: [MIRROR_ROOT, dir].filter(Boolean).join("/"), mirrored: true };
  }
  return { source: "data", dir, mirrored: false };
}

/**
 * Create every missing folder of `dir` in the Data root (GM/Assistant only). The server uses a
 * non-recursive mkdir and decodes the target with decodeURIComponent, hence one call per segment, encoded.
 */
export async function ensureDirectory(dir) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const parts = normalizePath(dir).split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    if (knownDirs.has(sub)) continue;
    try { await FilePicker.createDirectory("data", encodeSegments(sub), {}); }
    catch (err) { if (!/EEXIST|already exists/i.test(String(err?.message ?? err))) throw err; }
    knownDirs.add(sub);
  }
}

/** Fetchable URL for a stored path: segments percent-encoded and the route prefix applied. */
export function toFetchUrl(path) {
  const raw = String(path ?? "").trim();
  if (/^(blob|data):/i.test(raw)) return raw;
  const p = normalizePath(raw);
  if (isUrl(p)) return p;
  return foundry.utils.getRoute(encodeSegments(p));
}
