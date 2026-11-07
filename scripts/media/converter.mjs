import { OUTPUT, extOf, warn, sha256Hex } from "../constants.mjs";
import { getSetting } from "../settings.mjs";
import { normalizePath } from "../library.mjs";
import {
  REASON, WEBP_MAX_SIDE, LOSSLESS_SOURCE_EXT, LOSSLESS_PREFERENCE, ANIMATABLE_EXT, AMBIGUOUS_EXT, AUDIO_OPTIMAL_CODECS,
  VIDEO_OPTIMAL_CODECS, IMAGE_MIME, ANIMATION_BITRATE_MIN, kindFromName, skipByName, videoBitrate,
  videoSize, imageSize, clamp
} from "./formats.mjs";
import { baseName, optimizedName, toFetchUrl } from "./naming.mjs";

/**
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
 */

/* -------------------------------------------- */
/*  Capabilities                                */
/* -------------------------------------------- */

const probes = new Map();

/** Memoized capability probe. A naming hash needs crypto.subtle, which only exists in secure contexts. */
export function canConvert(kind) {
  if (!probes.has(kind)) {
    probes.set(kind, probe(kind).catch(err => {
      warn(`capability probe for ${kind} failed`, err);
      return false;
    }));
  }
  return probes.get(kind);
}

async function probe(kind) {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) return false;
  switch ( kind ) {
    case "image": {
      if ( typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function" ) return false;
      const canvas = new OffscreenCanvas(2, 2);
      const ctx = canvas.getContext("2d");
      if ( !ctx ) return false;
      ctx.fillRect(0, 0, 1, 1);
      // Safari silently returns PNG instead of WebP.
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
      return blob.type === "image/webp";
    }
    case "video": {
      if ( typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined" ) return false;
      const r = await VideoEncoder.isConfigSupported({
        codec: "vp09.00.40.08", width: 1920, height: 1080, bitrate: 2_500_000, framerate: 30
      });
      return !!r?.supported;
    }
    case "audio": {
      if ( typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined" ) return false;
      const r = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 });
      return !!r?.supported;
    }
    default: return false;
  }
}

let mediabunny = null;
function loadMediabunny() {
  mediabunny ??= import("../../vendor/mediabunny.min.mjs").catch(err => { mediabunny = null; throw err; });
  return mediabunny;
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Optimize an in-memory file.
 * @param {File|Blob} file
 * @param {{name?: string, kind?: "image"|"video"|"audio", referenceKinds?: Set<string>, signal?: AbortSignal,
 *          onProgress?: (pct: number) => void}} [options]
 * @returns {Promise<OptimizeResult>}
 */
export async function optimizeFile(file, options = {}) {
  const name = options.name ?? file?.name ?? "media";
  const size = file?.size ?? 0;
  try {
    if ( !(file instanceof Blob) ) throw new Error("optimizeFile expects a File or Blob");
    const early = skipByName(name);
    if ( early && !(options.kind && early.reason === REASON.unsupported) ) return skipped(early.kind, size, early.reason);
    return await run({ ...options, name, blob: file, size });
  } catch(err) {
    return failed(err, options.signal, options.kind ?? kindFromName(name), size);
  }
}

/**
 * Optimize a file stored on the server (or another origin).
 * Images are downloaded; video/audio are read with ranged requests when the server allows it.
 * @param {string} path
 * @param {{kind?: "image"|"video"|"audio", referenceKinds?: Set<string>, signal?: AbortSignal,
 *   onProgress?: (pct: number) => void}} [options]  kind: decided from the references (audio-only use of a .webm)
 * @returns {Promise<OptimizeResult>}
 */
export async function optimizeUrl(path, options = {}) {
  const { signal } = options;
  const name = baseName(normalizePath(path)) || "media";
  const kind = options.kind ?? kindFromName(name);
  let size = 0;
  try {
    const early = skipByName(name);
    if ( early ) return skipped(early.kind, 0, early.reason);
    const url = toFetchUrl(path);
    if ( (kind === "image") && !(await canConvert("image")) ) return skipped(kind, 0, REASON.notCapable);
    if ( kind !== "image" ) {
      const info = await headInfo(url, signal);
      if ( info.missing ) return skipped(kind, 0, REASON.missing);
      if ( info.size > 0 && info.ranges ) {
        size = info.size;
        return await run({ ...options, name, url, size });
      }
    }
    const res = await fetch(url, { cache: "no-store", signal });
    if ( (res.status === 404) || (res.status === 410) ) return skipped(kind, 0, REASON.missing);
    if ( !res.ok ) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const blob = await res.blob();
    size = blob.size;
    return await run({ ...options, name, blob, size });
  } catch(err) {
    return failed(err, signal, kind, size);
  }
}

/* -------------------------------------------- */
/*  Dispatch                                    */
/* -------------------------------------------- */

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

/** ctx: {name, size, blob?|url?, kind?, referenceKinds?, signal?, onProgress?} */
async function run(ctx) {
  ctx.signal?.throwIfAborted();
  const cfg = readConfig();
  const kind = ctx.kind ?? kindFromName(ctx.name);
  if ( kind === "image" ) return optimizeImage(ctx, cfg);
  if ( (kind === "video") || (kind === "audio") ) return optimizeAV(ctx, cfg, kind);
  return skipped(null, ctx.size, REASON.unsupported);
}

/* -------------------------------------------- */
/*  Images                                      */
/* -------------------------------------------- */

async function optimizeImage(ctx, cfg) {
  const { name, size, signal } = ctx;
  const ext = extOf(name);
  if ( !(await canConvert("image")) ) return skipped("image", size, REASON.notCapable);
  const blob = ctx.blob ?? await fetchBlob(ctx.url, signal);

  if ( ANIMATABLE_EXT.has(ext) ) {
    const anim = await inspectAnimation(blob, ext);
    if ( anim.animated ) {
      try { return await optimizeAnimation(ctx, cfg, anim.decoder); }
      finally { anim.decoder?.close(); }
    }
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" });
  } catch(err) {
    warn(`cannot decode ${name}`, err);
    return skipped("image", size, REASON.undecodable);
  }

  let canvas;
  try {
    if ( cfg.keepResolution && (Math.max(bitmap.width, bitmap.height) > WEBP_MAX_SIDE) ) {
      return skipped("image", size, REASON.tooLarge);
    }
    const { width, height } = imageSize(bitmap.width, bitmap.height, cfg);
    canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d", { alpha: true });
    if ( !g ) throw new Error("2D canvas unavailable");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    ctx.onProgress?.(0.5);

    signal?.throwIfAborted();
    let out = await canvas.convertToBlob({ type: "image/webp", quality: cfg.imageQuality });
    if ( out.type !== "image/webp" ) throw new Error(`WebP encoder returned ${out.type || "nothing"}`);
    // Flat art (maps, tokens, UI) stored as PNG often grows 2-3x as lossy WebP but shrinks 80-90% as lossless
    // WebP (quality 1 selects Chromium's lossless encoder). Photos go the other way, so both are tried.
    if ( LOSSLESS_SOURCE_EXT.has(ext) ) {
      signal?.throwIfAborted();
      const lossless = await canvas.convertToBlob({ type: "image/webp", quality: 1 });
      if ( (lossless.type === "image/webp") && (lossless.size <= out.size * LOSSLESS_PREFERENCE) ) out = lossless;
    }
    ctx.onProgress?.(1);
    return await finish("image", out, name, size, cfg);
  } finally {
    bitmap.close();
    if ( canvas ) canvas.width = canvas.height = 0;
  }
}

/**
 * Animated GIF or APNG? GIF needs ImageDecoder; without it a GIF is assumed animated (kept as-is).
 * APNG is detected by its acTL chunk, which must precede the first IDAT.
 * @returns {Promise<{animated: boolean, decoder: ImageDecoder|null}>}
 */
async function inspectAnimation(blob, ext) {
  if ( (ext === "png") && !(await isApng(blob)) ) return { animated: false, decoder: null };
  const type = IMAGE_MIME[ext];
  if ( (typeof ImageDecoder === "undefined") || !(await ImageDecoder.isTypeSupported(type).catch(() => false)) ) {
    return { animated: ext === "gif", decoder: null };
  }
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const animated = !!track?.animated && (track.frameCount > 1);
    if ( animated ) return { animated, decoder };
  } catch(err) {
    warn("ImageDecoder could not read the image", err);
  }
  decoder.close();
  return { animated: false, decoder: null };
}

async function isApng(blob) {
  const buf = new DataView(await blob.slice(0, 1 << 20).arrayBuffer());
  let offset = 8; // PNG signature
  while ( offset + 8 <= buf.byteLength ) {
    const length = buf.getUint32(offset);
    const type = String.fromCharCode(buf.getUint8(offset + 4), buf.getUint8(offset + 5), buf.getUint8(offset + 6), buf.getUint8(offset + 7));
    if ( type === "acTL" ) return true;
    if ( (type === "IDAT") || (type === "IEND") ) return false;
    offset += 12 + length;
  }
  return false;
}

/**
 * Animated GIF/APNG -> WebM VP9 with alpha, only when every reference can show video (texture/video fields).
 * Image fields (Actor/Item img, token ring...) and HTML would break or lose the animation.
 */
async function optimizeAnimation(ctx, cfg, decoder) {
  const { name, size, signal, referenceKinds } = ctx;
  if ( !(referenceKinds instanceof Set) ) return skipped("image", size, REASON.animatedGif);
  if ( !cfg.convertAnimatedGif ) return skipped("image", size, REASON.animatedGifDisabled);
  const videoOnly = referenceKinds.size > 0 && [...referenceKinds].every(k => (k === "texture") || (k === "video"));
  if ( !videoOnly ) return skipped("image", size, REASON.animatedGifImageField);
  if ( !decoder ) return skipped("image", size, REASON.undecodable);
  if ( !(await canConvert("video")) ) return skipped("image", size, REASON.notCapable);

  const mb = await loadMediabunny();
  const count = decoder.tracks.selectedTrack.frameCount;
  const first = (await decoder.decode({ frameIndex: 0 })).image;
  const srcW = first.displayWidth, srcH = first.displayHeight;
  const { width, height, resized } = videoSize(srcW, srcH, cfg);
  const fps = 1 / frameSeconds(first.duration);
  const bitrate = videoBitrate(width, height, fps, cfg.videoQuality, ANIMATION_BITRATE_MIN);

  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.VideoSampleSource({ codec: "vp9", quality: new mb.Quality({ bitrate }), alpha: "keep" });
  output.addVideoTrack(source, { canBeTransparent: true });
  const canvas = resized ? new OffscreenCanvas(width, height) : null;
  const g = canvas?.getContext("2d", { alpha: true });
  if ( g ) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; }

  let frame = first;
  try {
    await output.start();
    let timestamp = 0;
    for ( let i = 0; i < count; i++ ) {
      signal?.throwIfAborted();
      if ( i > 0 ) frame = (await decoder.decode({ frameIndex: i })).image;
      const duration = frameSeconds(frame.duration);
      if ( g ) {
        // Snapshot the canvas into its own VideoFrame: the canvas is redrawn before encoding may finish.
        g.clearRect(0, 0, width, height);
        g.drawImage(frame, 0, 0, width, height);
        frame.close();
        frame = new VideoFrame(canvas, { timestamp: Math.round(timestamp * 1e6), duration: Math.round(duration * 1e6) });
      }
      const sample = new mb.VideoSample(frame, { timestamp, duration });
      await source.add(sample);
      sample.close();
      frame.close();
      timestamp += duration;
      ctx.onProgress?.((i + 1) / count);
    }
    await output.finalize();
  } catch(err) {
    frame?.close();
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    if ( canvas ) canvas.width = canvas.height = 0;
  }
  return finish("video", output.target.buffer, name, size, cfg, "image");
}

/** Browsers show GIF delays of 10 ms or less as 100 ms; mirror that so loops keep their speed. */
function frameSeconds(microseconds) {
  const us = Number(microseconds) || 0;
  return (us <= 10_000 ? 100_000 : us) / 1e6;
}

/* -------------------------------------------- */
/*  Video and audio                             */
/* -------------------------------------------- */

async function optimizeAV(ctx, cfg, kind) {
  const { name, size, signal } = ctx;
  const ext = extOf(name);
  const mb = await loadMediabunny();
  const source = ctx.blob
    ? new mb.BlobSource(ctx.blob)
    : new mb.UrlSource(ctx.url, { requestInit: { cache: "no-store" }, getRetryDelay: n => (n < 2 ? n + 1 : null) });
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source });
  // Disposing the input aborts pending ranged reads; they then throw and failed() turns that into the AbortError.
  const onAbort = () => input.dispose();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let video, audio;
    try {
      await input.getFormat();
      video = await input.getPrimaryVideoTrack();
      audio = await input.getPrimaryAudioTrack();
    } catch(err) {
      if ( err instanceof mb.UnsupportedInputFormatError ) return skipped(kind, size, REASON.undecodable);
      throw err;
    }
    if ( (kind === "video") && !video ) {
      if ( audio && AMBIGUOUS_EXT.has(ext) ) kind = "audio";
      else return skipped("video", size, REASON.noVideoTrack);
    }
    if ( (kind === "audio") && !audio ) return skipped("audio", size, REASON.noAudioTrack);
    if ( !(await canConvert(kind)) ) return skipped(kind, size, REASON.notCapable);
    // Mediabunny would silently drop an audio track it cannot encode; keep the original instead.
    if ( (kind === "video") && audio && !cfg.videoStripAudio && !(await canConvert("audio")) ) {
      return skipped(kind, size, REASON.notCapable);
    }

    const duration = (await input.getDurationFromMetadata().catch(() => null)) || (await input.computeDuration());
    const overallBitrate = (duration > 0) && (size > 0) ? (size * 8) / duration : null;
    signal?.throwIfAborted();
    const args = { ctx, cfg, mb, input, video, audio, ext, overallBitrate };
    return kind === "video" ? await convertVideo(args) : await convertAudio(args);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    input.dispose();
  }
}

async function convertVideo({ ctx, cfg, mb, input, video, audio, ext, overallBitrate }) {
  const { name, size } = ctx;
  const codec = await video.getCodec();
  const srcW = await video.getDisplayWidth();
  const srcH = await video.getDisplayHeight();
  const stats = await video.computePacketStats(150).catch(() => null);
  const fps = stats?.averagePacketRate || 30;
  const { width, height, resized } = videoSize(srcW, srcH, cfg);
  const audioRate = audio ? ((await audio.getAverageBitrate().catch(() => null)) ?? 128_000) : 0;
  const sourceRate = (overallBitrate !== null) ? Math.max(0, overallBitrate - audioRate) : null;
  const target = videoBitrate(width, height, fps, cfg.videoQuality, undefined, sourceRate);

  // Compare against the uncapped target: the cap follows the source, so it would never call a lean VP9 file optimal.
  if ( VIDEO_OPTIMAL_CODECS.has(codec) && (ext === "webm") && !resized && (sourceRate !== null)
    && (sourceRate <= videoBitrate(width, height, fps, cfg.videoQuality) * 1.5) ) {
    return skipped("video", size, REASON.alreadyOptimized);
  }

  const alpha = (await video.canBeTransparent().catch(() => false)) ? "keep" : "discard";
  const videoOptions = { codec: "vp9", quality: new mb.Quality({ bitrate: target }), alpha, forceTranscode: true };
  if ( resized ) Object.assign(videoOptions, { width, height, fit: "fill" });
  const audioOptions = cfg.videoStripAudio ? { discard: true } : await opusOptions(mb, audio, cfg);
  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({ input, output, tracks: "primary", showWarnings: false, video: videoOptions, audio: audioOptions });

  if ( !conversion.utilizedTracks.some(t => t.isVideoTrack()) ) throw new Error(discardText(conversion, "video"));
  if ( audio && !cfg.videoStripAudio && conversion.discardedTracks.some(d => d.track.id === audio.id) ) {
    return skipped("video", size, REASON.audioNotEncodable);
  }
  await execute(mb, conversion, ctx);
  return finish("video", output.target.buffer, name, size, cfg);
}

async function convertAudio({ ctx, cfg, mb, input, audio, ext, overallBitrate }) {
  const { name, size } = ctx;
  const codec = await audio.getCodec();
  if ( AUDIO_OPTIMAL_CODECS.has(codec) ) return skipped("audio", size, REASON.alreadyOptimized);
  if ( ((codec === "mp3") || (ext === "mp3")) && (cfg.skipMp3BelowKbps > 0) ) {
    const rate = (await audio.getAverageBitrate().catch(() => null)) || overallBitrate;
    if ( rate && (rate < cfg.skipMp3BelowKbps * 1000) ) return skipped("audio", size, REASON.lowBitrate);
  }
  const output = new mb.Output({ format: new mb.OggOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({
    input, output, tracks: "primary", showWarnings: false,
    video: { discard: true },
    audio: await opusOptions(mb, audio, cfg)
  });
  if ( !conversion.utilizedTracks.some(t => t.isAudioTrack()) ) throw new Error(discardText(conversion, "audio"));
  await execute(mb, conversion, ctx);
  return finish("audio", output.target.buffer, name, size, cfg);
}

/** Opus works at 48 kHz internally and browser encoders only take mono/stereo. */
async function opusOptions(mb, track, cfg) {
  const channels = track ? await track.getNumberOfChannels().catch(() => 2) : 2;
  return {
    codec: "opus",
    quality: new mb.Quality({ bitrate: cfg.audioBitrate }),
    numberOfChannels: clamp(channels || 2, 1, 2),
    sampleRate: 48000,
    forceTranscode: true
  };
}

async function execute(mb, conversion, { signal, onProgress }) {
  signal?.throwIfAborted();
  if ( onProgress ) conversion.onProgress = p => onProgress(clamp(p, 0, 1));
  const abort = () => conversion.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await conversion.execute();
  } catch(err) {
    if ( signal?.aborted ) throw abortReason(signal);
    if ( err instanceof mb.ConversionCanceledError ) throw new Error("conversion canceled");
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function discardText(conversion, type) {
  const reasons = conversion.discardedTracks.filter(d => d.track.type === type).map(d => d.reason);
  return `no ${type} track could be converted${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** Apply the savings rule, hash and name the output. */
async function finish(kind, data, name, originalBytes, cfg, sourceKind = kind) {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  if ( !buffer?.byteLength ) throw new Error("encoder produced no data");
  const bytes = buffer.byteLength;
  // Foundry v14's PIXI texture parser rejects .gif ("Invalid Asset"), so a GIF is always worth converting.
  const mustConvert = /\.gif$/i.test(String(name).split(/[?#]/)[0]);
  if ( !mustConvert && (originalBytes > 0) && (bytes > originalBytes * (1 - (cfg.minSavingsPct / 100))) ) {
    return { status: "skipped", kind: sourceKind, bytes, originalBytes, reason: REASON.noSavings };
  }
  const sha256 = await sha256Hex(buffer);
  const { ext, mime } = OUTPUT[kind];
  const file = new File([buffer], optimizedName(name, sha256, ext), { type: mime });
  return { status: "done", kind, file, sha256, bytes, originalBytes };
}

const skipped = (kind, originalBytes, reason) => ({ status: "skipped", kind, originalBytes, reason });

function failed(err, signal, kind, originalBytes) {
  if ( signal?.aborted ) throw abortReason(signal);
  warn("media conversion failed", err);
  return { status: "failed", kind: kind ?? null, originalBytes, reason: String(err?.message ?? err) };
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/** HEAD first so huge videos are read with ranges instead of being loaded whole into memory. */
async function headInfo(url, signal) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store", signal });
    if ( (res.status === 404) || (res.status === 410) ) return { missing: true, size: 0, ranges: false };
    if ( res.ok ) {
      const length = Number(res.headers.get("content-length")) || 0;
      const ranges = /bytes/i.test(res.headers.get("accept-ranges") ?? "");
      return { missing: false, size: length, ranges };
    }
  } catch(err) {
    if ( signal?.aborted ) throw abortReason(signal);
  }
  return { missing: false, size: 0, ranges: false };
}

async function fetchBlob(url, signal) {
  const res = await fetch(url, { cache: "no-store", signal });
  if ( !res.ok ) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.blob();
}
