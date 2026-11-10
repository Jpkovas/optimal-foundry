import { EXT, extOf } from "../constants.mjs";

/** WebP cannot store more than 16383 px per side. */
export const WEBP_MAX_SIDE = 16383;
/**
 * Largest image the converter decodes, in source pixels. Each decoded RGBA copy costs 4 bytes per pixel and a
 * conversion holds about three (bitmap, canvas, encoder snapshot), next to Foundry's own canvas.
 */
export const IMAGE_PIXEL_BUDGET = 100_000_000;
/** `navigator.deviceMemory` (GB) at or below which the pixel budget is halved. */
export const LOW_MEMORY_GB = 4;

/** Images that are already in an efficient format. */
export const IMAGE_OPTIMAL_EXT = new Set(["webp", "avif"]);
/** Never touched: vector or texture-compressed formats. */
export const IMAGE_NEVER_EXT = new Set(["svg", "basis", "ktx2"]);
/** Lossless sources: WebP is encoded both lossless and lossy and the smaller kept (flat map art wins lossless). */
export const LOSSLESS_SOURCE_EXT = new Set(["png", "gif", "bmp", "tif", "tiff"]);
/** Lossless output is kept unless it is more than this much larger than the lossy one (it is pixel-exact). */
export const LOSSLESS_PREFERENCE = 1.15;
/** Image containers that may be animated (GIF, APNG). */
export const ANIMATABLE_EXT = new Set(["gif", "png"]);

export const AUDIO_OPTIMAL_EXT = new Set(["ogg", "opus"]);
export const AUDIO_OPTIMAL_CODECS = new Set(["opus", "vorbis"]);
export const VIDEO_OPTIMAL_CODECS = new Set(["vp9", "av1"]);
/** Extensions Foundry lists as both audio and video: the real kind depends on the tracks. */
export const AMBIGUOUS_EXT = new Set(["webm"]);

export const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  webp: "image/webp", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff"
};

/** Bits per pixel per frame for each `videoQuality` choice. */
const VIDEO_BPP = { low: 0.04, medium: 0.06, high: 0.09 };
export const VIDEO_BITRATE_MIN = 500_000;
export const VIDEO_BITRATE_MAX = 20_000_000;
/** Animated GIF/APNG loops are tiny; the video floor would inflate them. */
export const ANIMATION_BITRATE_MIN = 64_000;

/** Opus always runs at 48 kHz; the converter resamples every source to it. */
export const OPUS_SAMPLE_RATE = 48000;
/**
 * Foundry decodes sounds up to this long into an AudioBuffer and loops them sample-exactly
 * (Sound.MAX_BUFFER_DURATION); longer ones stream through an audio element, which never loops gaplessly.
 */
export const LOOP_BUFFER_SECONDS = 600;
/** A converted loop may differ from its source by at most this much before the loop point is audible. */
export const LOOP_TOLERANCE_MS = 1;

/**
 * Reason codes stored in OptimizeResult.reason / LibraryEntry.reason.
 * Each has a label at OPTIMALFOUNDRY.Media.Reason.<code>. Failures carry the error message instead.
 */
export const REASON = Object.freeze({
  notCapable: "notCapable",
  alreadyOptimized: "alreadyOptimized",
  vector: "vector",
  unsupported: "unsupported",
  undecodable: "undecodable",
  tooLarge: "tooLarge",
  noSavings: "noSavings",
  lowBitrate: "lowBitrate",
  missing: "missing",
  noVideoTrack: "noVideoTrack",
  noAudioTrack: "noAudioTrack",
  audioNotEncodable: "audioNotEncodable",
  animatedGif: "animatedGif",
  animatedGifImageField: "animatedGifImageField",
  animatedGifDisabled: "animatedGifDisabled",
  loopLength: "loopLength"
});

/**
 * Media kind implied by a file name. `webm` reports "video"; the converter re-routes audio-only WebM.
 * @returns {"image"|"video"|"audio"|null}
 */
export function kindFromName(name) {
  const ext = extOf(name);
  if (!ext || IMAGE_NEVER_EXT.has(ext)) return null;
  if (EXT.image.includes(ext)) return "image";
  if (EXT.video.includes(ext)) return "video";
  if (EXT.audio.includes(ext)) return "audio";
  return null;
}

/**
 * Skip decision that needs only the name, so callers avoid downloading files that will not change.
 * @returns {{kind: string|null, reason: string}|null}
 */
export function skipByName(name) {
  const ext = extOf(name);
  if (IMAGE_NEVER_EXT.has(ext)) return { kind: "image", reason: REASON.vector };
  const kind = kindFromName(name);
  if (!kind) return { kind: null, reason: REASON.unsupported };
  if (kind === "image" && IMAGE_OPTIMAL_EXT.has(ext)) return { kind, reason: REASON.alreadyOptimized };
  if (kind === "audio" && AUDIO_OPTIMAL_EXT.has(ext)) return { kind, reason: REASON.alreadyOptimized };
  return null;
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Anchor of the bitrate curve: at 1080p30 the target is exactly bpp × pixels × fps. */
const REF_PIXELS = 1920 * 1080;
const REF_FPS = 30;
/** VP9 matches H.264 quality at roughly 70% of its bitrate; aiming higher than that only inflates the file. */
const SOURCE_RATIO = 0.7;

/**
 * Target VP9 bitrate in bits per second. Sublinear in both axes: bigger frames carry more spatial redundancy
 * (exponent 0.75, the usual codec rule of thumb) and higher frame rates leave less motion between frames
 * (exponent 0.5). 4K60 lands near 15 Mbps instead of hitting the 20 Mbps cap, and 720p keeps a few more bits per
 * pixel than the linear model. `sourceBitrate` (the source's video bitrate, when known) caps the target, so a
 * lean source is not re-encoded into a bigger file that finish() would throw away after a full encode.
 */
export function videoBitrate(width, height, fps, quality, min = VIDEO_BITRATE_MIN, sourceBitrate = null) {
  const bpp = VIDEO_BPP[quality] ?? VIDEO_BPP.medium;
  const pixels = Math.max(1, width * height);
  const frames = clamp(fps || REF_FPS, 1, 60);
  let rate = bpp * REF_PIXELS * REF_FPS * ((pixels / REF_PIXELS) ** 0.75) * ((frames / REF_FPS) ** 0.5);
  if ( sourceBitrate > 0 ) rate = Math.min(rate, sourceBitrate * SOURCE_RATIO);
  return Math.round(clamp(rate, min, VIDEO_BITRATE_MAX));
}

const even = v => Math.max(2, Math.round(v / 2) * 2);

/**
 * Output video size. With keepResolution the source size is kept; otherwise the SHORT side is capped at
 * maxVideoHeight ("1080p" also means 1080x1920 for portrait clips). Never upscales.
 * @returns {{width: number, height: number, resized: boolean}}
 */
export function videoSize(width, height, { keepResolution, maxVideoHeight }) {
  const max = Number(maxVideoHeight) || 1080;
  const short = Math.min(width, height);
  if (keepResolution || short <= max) return { width, height, resized: false };
  const s = max / short;
  return { width: even(width * s), height: even(height * s), resized: true };
}

/**
 * Output image size: keepResolution keeps the size (caller must reject > WEBP_MAX_SIDE),
 * otherwise fit the longest side within maxImageSide.
 * @returns {{width: number, height: number, resized: boolean}}
 */
export function imageSize(width, height, { keepResolution, maxImageSide }) {
  const limit = keepResolution ? WEBP_MAX_SIDE : Math.min(Number(maxImageSide) || 8192, WEBP_MAX_SIDE);
  const longest = Math.max(width, height);
  if (longest <= limit) return { width, height, resized: false };
  const s = limit / longest;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)), resized: true };
}

/**
 * Is a source image too big to decode on this device? The budget counts SOURCE pixels (a resize still decodes the
 * whole image first) and is halved on devices reporting 4 GB of memory or less. Browsers without
 * `navigator.deviceMemory` (Firefox) get the full budget.
 * @param {number} width
 * @param {number} height
 * @param {number} [deviceMemory]  `navigator.deviceMemory`, in GB
 */
export function overPixelBudget(width, height, deviceMemory) {
  const low = (deviceMemory > 0) && (deviceMemory <= LOW_MEMORY_GB);
  return width * height > (low ? IMAGE_PIXEL_BUDGET / 2 : IMAGE_PIXEL_BUDGET);
}

/**
 * Output size, in bytes, an encode at these target bitrates will produce. Encoders treat the bitrate as a target,
 * so this is an estimate; it is what lets a file that cannot be uploaded be skipped before a long encode.
 * @param {number} seconds     Duration of the media
 * @param {...number} bitrates Target bitrates in bits per second (video, audio)
 */
export function predictedBytes(seconds, ...bitrates) {
  const rate = bitrates.reduce((sum, b) => sum + (b > 0 ? b : 0), 0);
  return Math.ceil((Math.max(0, seconds) * rate) / 8);
}

/** Would a converted sound of `outputSeconds` loop like its `sourceSeconds` source? (both as the browser decodes them) */
export function sameLoopLength(sourceSeconds, outputSeconds) {
  return Math.abs(sourceSeconds - outputSeconds) * 1000 <= LOOP_TOLERANCE_MS;
}
