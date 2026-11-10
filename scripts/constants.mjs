export const MODULE_ID = "optimal-foundry";
export const SOCKET = `module.${MODULE_ID}`;
export const MODULE_PATH = `modules/${MODULE_ID}`;

/** Marker inserted in every optimized file name: `<stem>.of-<hash8>.<ext>`. The CDN cache rule matches it. */
export const OPTIMIZED_MARKER = ".of-";
export const OPTIMIZED_RE = /\.of-([0-9a-f]{8})\.[a-z0-9]+$/i;

/** Folder, inside the world's folder, that receives optimized copies of files living in read-only places (modules/, systems/, core folders, other hosts). */
export const MIRROR_ROOT = "optimal-foundry";

export const EXT = {
  image: ["png", "jpg", "jpeg", "bmp", "gif", "webp", "avif", "tif", "tiff"],
  video: ["mp4", "m4v", "mov", "webm", "ogv"],
  audio: ["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus", "webm"]
};

/** Output formats. Audio uses .ogg (not .webm, which Foundry treats as video too). */
export const OUTPUT = {
  image: { ext: "webp", mime: "image/webp" },
  video: { ext: "webm", mime: "video/webm" },
  audio: { ext: "ogg", mime: "audio/ogg" }
};

export const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
export const warn = (...args) => console.warn(`${MODULE_ID} |`, ...args);

export function extOf(path) {
  const clean = String(path).split(/[?#]/)[0];
  const i = clean.lastIndexOf(".");
  return i < 0 ? "" : clean.slice(i + 1).toLowerCase();
}

export function isOptimizedPath(path) {
  return OPTIMIZED_RE.test(String(path).split(/[?#]/)[0]);
}

/** Hex SHA-256 of an ArrayBuffer or typed array. */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
