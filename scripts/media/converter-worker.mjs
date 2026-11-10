/**
 * The converter's module worker: every decode and encode runs here, off the page's main thread, so a large map or a
 * long encode no longer hitches the game master's canvas. Images go through OffscreenCanvas, animated GIF/APNG,
 * video and audio through WebCodecs and Mediabunny.
 *
 * No Foundry global exists in a worker. The page (converter.mjs) sends a plain job and gets progress and one result:
 *   in:  {type: "probe"}  |  {type: "convert", job}
 *   out: {type: "progress", value}  |  {type: "result", result}
 * The page stops a conversion by terminating the worker, so nothing here listens for an abort.
 *
 * @typedef {object} ConverterJob
 * @property {string} name                 File name (decides the format and the GIF rule)
 * @property {"image"|"video"|"audio"|null} kind  Kind decided by the caller, else taken from the name
 * @property {Blob|null} blob              The file itself (an upload), or
 * @property {string|null} url             an absolute URL to read it from
 * @property {number} size                 Bytes of `blob`; filled in here for a URL
 * @property {Set<string>|null} referenceKinds  Field kinds that will show the output (animated images only)
 * @property {number|null} maxOutputBytes  Skip as tooLarge when the predicted output is bigger
 * @property {object} cfg                  Snapshot of the module settings (converter.mjs readConfig)
 *
 * @typedef {object} WorkerResult  OptimizeResult without the File: the page names and builds it.
 * @property {"done"|"skipped"|"failed"} status
 * @property {"image"|"video"|"audio"|null} kind
 * @property {number} originalBytes
 * @property {string} [reason]
 * @property {number} [bytes]
 * @property {string} [sha256]
 * @property {ArrayBuffer} [buffer]  The encoded file (transferred), status "done" only
 * @property {number} [seconds]      Length of converted audio, as it will decode
 */
import { extOf, warn, sha256Hex } from "../constants.mjs";
import {
  REASON, WEBP_MAX_SIDE, LOSSLESS_SOURCE_EXT, LOSSLESS_PREFERENCE, ANIMATABLE_EXT, AMBIGUOUS_EXT, AUDIO_OPTIMAL_CODECS,
  VIDEO_OPTIMAL_CODECS, IMAGE_MIME, ANIMATION_BITRATE_MIN, OPUS_SAMPLE_RATE, kindFromName, videoBitrate, videoSize,
  imageSize, overPixelBudget, predictedBytes, clamp
} from "./formats.mjs";
import { HEADER_BYTES, imageDimensions, trimOggOpus } from "./converter-bytes.mjs";

/** Progress messages wake the page's main thread; a few per second are enough for a progress bar and a watchdog. */
const PROGRESS_INTERVAL_MS = 100;

// Assigned before anything is awaited: messages posted while the module loads are delivered once it has run.
self.onmessage = async ({ data }) => {
  let result;
  try {
    result = (data.type === "probe") ? await capabilities() : await convert(data.job);
  } catch(err) {
    warn("media conversion failed", err);
    const job = data.job ?? {};
    result = { status: "failed", kind: job.kind ?? kindFromName(job.name ?? ""), originalBytes: job.size ?? 0,
      reason: String(err?.message ?? err) };
  }
  self.postMessage({ type: "result", result }, result.buffer ? [result.buffer] : []);
};

let lastProgress = 0;
function progress(value) {
  const now = performance.now();
  if ( (value < 1) && (now - lastProgress < PROGRESS_INTERVAL_MS) ) return;
  lastProgress = now;
  self.postMessage({ type: "progress", value: clamp(value, 0, 1) });
}

/* -------------------------------------------- */
/*  Capabilities                                */
/* -------------------------------------------- */

const probes = new Map();

/** Memoized capability probe. A naming hash needs crypto.subtle, which only exists in secure contexts. */
function canConvert(kind) {
  if ( !probes.has(kind) ) {
    probes.set(kind, probe(kind).catch(err => {
      warn(`capability probe for ${kind} failed`, err);
      return false;
    }));
  }
  return probes.get(kind);
}

async function capabilities() {
  const [image, video, audio] = await Promise.all(["image", "video", "audio"].map(canConvert));
  return { image, video, audio };
}

async function probe(kind) {
  if ( !self.isSecureContext || !self.crypto?.subtle ) return false;
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
      const r = await AudioEncoder.isConfigSupported({
        codec: "opus", sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000
      });
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
/*  Dispatch and sources                        */
/* -------------------------------------------- */

/** @param {ConverterJob} job */
async function convert(job) {
  const kind = job.kind ?? kindFromName(job.name);
  if ( kind === "image" ) return optimizeImage(job);
  if ( (kind === "video") || (kind === "audio") ) return optimizeAV(job, kind);
  return skipped(null, job.size, REASON.unsupported);
}

/** The whole file as a Blob: the upload itself, or the stored file downloaded. null when the server has no such file. */
async function loadBlob(job) {
  if ( job.blob ) return job.blob;
  const res = await fetch(job.url, { cache: "no-store" });
  if ( (res.status === 404) || (res.status === 410) ) return null;
  if ( !res.ok ) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  const blob = await res.blob();
  job.size = blob.size;
  return blob;
}

/** HEAD first so huge videos are read with ranges instead of being loaded whole into memory. */
async function headInfo(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if ( (res.status === 404) || (res.status === 410) ) return { missing: true, size: 0, ranges: false };
    if ( res.ok ) {
      const length = Number(res.headers.get("content-length")) || 0;
      const ranges = /bytes/i.test(res.headers.get("accept-ranges") ?? "");
      return { missing: false, size: length, ranges };
    }
  } catch {}
  return { missing: false, size: 0, ranges: false };
}

const tooBig = (job, seconds, ...bitrates) => (job.maxOutputBytes > 0)
  && (predictedBytes(seconds, ...bitrates) > job.maxOutputBytes);

/* -------------------------------------------- */
/*  Images                                      */
/* -------------------------------------------- */

const overBudget = ({ width, height }) => overPixelBudget(width, height, self.navigator?.deviceMemory);
const overWebpSide = ({ width, height }, cfg) => cfg.keepResolution && (Math.max(width, height) > WEBP_MAX_SIDE);

async function optimizeImage(job) {
  const { name, cfg } = job;
  const ext = extOf(name);
  if ( !(await canConvert("image")) ) return skipped("image", job.size, REASON.notCapable);
  const blob = await loadBlob(job);
  if ( !blob ) return skipped("image", 0, REASON.missing);
  const size = job.size;

  // The file header tells the pixel size without decoding; null (another format) leaves the check to the bitmap.
  const header = imageDimensions(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
  if ( header && overBudget(header) ) return skipped("image", size, REASON.tooLarge);

  if ( ANIMATABLE_EXT.has(ext) ) {
    const anim = await inspectAnimation(blob, ext);
    if ( anim.animated ) {
      try { return await optimizeAnimation(job, anim.decoder); }
      finally { anim.decoder?.close(); }
    }
  }
  if ( header && overWebpSide(header, cfg) ) return skipped("image", size, REASON.tooLarge);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" });
  } catch(err) {
    warn(`cannot decode ${name}`, err);
    return skipped("image", size, REASON.undecodable);
  }

  let canvas;
  try {
    if ( overBudget(bitmap) || overWebpSide(bitmap, cfg) ) return skipped("image", size, REASON.tooLarge);
    const { width, height } = imageSize(bitmap.width, bitmap.height, cfg);
    canvas = new OffscreenCanvas(width, height);
    // willReadFrequently keeps the canvas in main memory: it is drawn once and read back for every encode, and a
    // map-sized canvas on the GPU would cost a texture upload, a readback and that much video memory.
    const g = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if ( !g ) throw new Error("2D canvas unavailable");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    progress(0.5);

    let out = await canvas.convertToBlob({ type: "image/webp", quality: cfg.imageQuality });
    if ( out.type !== "image/webp" ) throw new Error(`WebP encoder returned ${out.type || "nothing"}`);
    // Flat art (maps, tokens, UI) stored as PNG often grows 2-3x as lossy WebP but shrinks 80-90% as lossless
    // WebP (quality 1 selects Chromium's lossless encoder). Photos go the other way, so both are tried.
    if ( LOSSLESS_SOURCE_EXT.has(ext) ) {
      const lossless = await canvas.convertToBlob({ type: "image/webp", quality: 1 });
      if ( (lossless.type === "image/webp") && (lossless.size <= out.size * LOSSLESS_PREFERENCE) ) out = lossless;
    }
    progress(1);
    return await finish("image", out, job);
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
  const buf = new DataView(await blob.slice(0, HEADER_BYTES).arrayBuffer());
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
async function optimizeAnimation(job, decoder) {
  const { size, referenceKinds, cfg } = job;
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
  // Frame delays are only known as each frame decodes; the first one is what the bitrate assumes too.
  if ( tooBig(job, count / fps, bitrate) ) {
    first.close();
    return skipped("image", size, REASON.tooLarge);
  }

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
      progress((i + 1) / count);
    }
    await output.finalize();
  } catch(err) {
    frame?.close();
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    if ( canvas ) canvas.width = canvas.height = 0;
  }
  return finish("video", output.target.buffer, job, "image");
}

/** Browsers show GIF delays of 10 ms or less as 100 ms; mirror that so loops keep their speed. */
function frameSeconds(microseconds) {
  const us = Number(microseconds) || 0;
  return (us <= 10_000 ? 100_000 : us) / 1e6;
}

/* -------------------------------------------- */
/*  Video and audio                             */
/* -------------------------------------------- */

async function optimizeAV(job, kind) {
  const { name, cfg } = job;
  const ext = extOf(name);
  // A stored file is read with ranged requests when the server allows it, and downloaded whole otherwise.
  let blob = job.blob;
  if ( !blob ) {
    const info = await headInfo(job.url);
    if ( info.missing ) return skipped(kind, 0, REASON.missing);
    if ( (info.size > 0) && info.ranges ) job.size = info.size;
    else {
      blob = await loadBlob(job);
      if ( !blob ) return skipped(kind, 0, REASON.missing);
    }
  }
  const size = job.size;

  const mb = await loadMediabunny();
  const source = blob
    ? new mb.BlobSource(blob)
    : new mb.UrlSource(job.url, { requestInit: { cache: "no-store" }, getRetryDelay: n => (n < 2 ? n + 1 : null) });
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source });
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
    const args = { job, mb, input, video, audio, ext, duration, overallBitrate };
    return kind === "video" ? await convertVideo(args) : await convertAudio(args);
  } finally {
    input.dispose();
  }
}

async function convertVideo({ job, mb, input, video, audio, ext, duration, overallBitrate }) {
  const { size, cfg } = job;
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
  // A long encode whose result could not be uploaded is not worth starting.
  const keepAudio = audio && !cfg.videoStripAudio;
  if ( tooBig(job, duration, target, keepAudio ? cfg.audioBitrate : 0) ) return skipped("video", size, REASON.tooLarge);

  const alpha = (await video.canBeTransparent().catch(() => false)) ? "keep" : "discard";
  const videoOptions = { codec: "vp9", quality: new mb.Quality({ bitrate: target }), alpha, forceTranscode: true };
  if ( resized ) Object.assign(videoOptions, { width, height, fit: "fill" });
  const audioOptions = cfg.videoStripAudio ? { discard: true } : await opusOptions(mb, audio, cfg);
  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({ input, output, tracks: "primary", showWarnings: false, video: videoOptions, audio: audioOptions });

  if ( !conversion.utilizedTracks.some(t => t.isVideoTrack()) ) throw new Error(discardText(conversion, "video"));
  if ( keepAudio && conversion.discardedTracks.some(d => d.track.id === audio.id) ) {
    return skipped("video", size, REASON.audioNotEncodable);
  }
  await execute(conversion);
  return finish("video", output.target.buffer, job);
}

async function convertAudio({ job, mb, input, audio, ext, duration, overallBitrate }) {
  const { size, cfg } = job;
  const codec = await audio.getCodec();
  if ( AUDIO_OPTIMAL_CODECS.has(codec) ) return skipped("audio", size, REASON.alreadyOptimized);
  if ( ((codec === "mp3") || (ext === "mp3")) && (cfg.skipMp3BelowKbps > 0) ) {
    const rate = (await audio.getAverageBitrate().catch(() => null)) || overallBitrate;
    if ( rate && (rate < cfg.skipMp3BelowKbps * 1000) ) return skipped("audio", size, REASON.lowBitrate);
  }
  if ( tooBig(job, duration, cfg.audioBitrate) ) return skipped("audio", size, REASON.tooLarge);

  // Count the samples that reach the encoder (after resampling): that is the length the output must decode to.
  let frames = 0;
  const audioOptions = await opusOptions(mb, audio, cfg);
  audioOptions.process = sample => {
    frames += sample.numberOfFrames;
    return sample;
  };
  const output = new mb.Output({ format: new mb.OggOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({
    input, output, tracks: "primary", showWarnings: false,
    video: { discard: true },
    audio: audioOptions
  });
  if ( !conversion.utilizedTracks.some(t => t.isAudioTrack()) ) throw new Error(discardText(conversion, "audio"));
  await execute(conversion);
  const buffer = output.target.buffer;
  // Cut the padding of the last Opus packet, or every converted loop would restart a few milliseconds late.
  trimOggOpus(buffer, frames);
  const result = await finish("audio", buffer, job);
  if ( result.status === "done" ) result.seconds = frames / OPUS_SAMPLE_RATE;
  return result;
}

/** Opus works at 48 kHz internally and browser encoders only take mono/stereo. */
async function opusOptions(mb, track, cfg) {
  const channels = track ? await track.getNumberOfChannels().catch(() => 2) : 2;
  return {
    codec: "opus",
    quality: new mb.Quality({ bitrate: cfg.audioBitrate }),
    numberOfChannels: clamp(channels || 2, 1, 2),
    sampleRate: OPUS_SAMPLE_RATE,
    forceTranscode: true
  };
}

async function execute(conversion) {
  conversion.onProgress = progress;
  await conversion.execute();
}

function discardText(conversion, type) {
  const reasons = conversion.discardedTracks.filter(d => d.track.type === type).map(d => d.reason);
  return `no ${type} track could be converted${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Apply the savings rule and hash the output.
 * @returns {Promise<WorkerResult>}
 */
async function finish(kind, data, job, sourceKind = kind) {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  if ( !buffer?.byteLength ) throw new Error("encoder produced no data");
  const bytes = buffer.byteLength;
  const originalBytes = job.size;
  // Foundry v14's PIXI texture parser rejects .gif ("Invalid Asset"), so a GIF is always worth converting.
  const mustConvert = extOf(job.name) === "gif";
  if ( !mustConvert && (originalBytes > 0) && (bytes > originalBytes * (1 - (job.cfg.minSavingsPct / 100))) ) {
    return { status: "skipped", kind: sourceKind, bytes, originalBytes, reason: REASON.noSavings };
  }
  return { status: "done", kind, buffer, sha256: await sha256Hex(buffer), bytes, originalBytes };
}

const skipped = (kind, originalBytes, reason) => ({ status: "skipped", kind, originalBytes, reason });
