import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  REASON, IMAGE_PIXEL_BUDGET, LOOP_BUFFER_SECONDS, overPixelBudget, predictedBytes, sameLoopLength, videoBitrate,
  kindFromName, skipByName, imageSize, videoSize
} from "../scripts/media/formats.mjs";

/**
 * The converter's decisions that need no browser (pixel budget, predicted output size, loop tolerance, formats),
 * and the page side of the worker protocol driven by a fake Worker: which worker a call gets, what the job carries,
 * how an abort or a worker error ends it, and the loop check. The real encode is proven in a browser, not here.
 */

/* -------------------------------------------- */
/*  formats.mjs                                 */
/* -------------------------------------------- */

test("every REASON code has a label in both languages", () => {
  for ( const lang of ["en", "pt-BR"] ) {
    const labels = JSON.parse(fs.readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), "utf8")).OPTIMALFOUNDRY.Media.Reason;
    for ( const code of Object.values(REASON) ) assert.ok(labels[code], `${lang}: OPTIMALFOUNDRY.Media.Reason.${code}`);
  }
  assert.equal(REASON.loopLength, "loopLength");
  assert.ok(Object.isFrozen(REASON));
});

test("pixel budget: 100 megapixels, halved on devices with 4 GB or less", () => {
  assert.equal(IMAGE_PIXEL_BUDGET, 100_000_000);
  assert.equal(overPixelBudget(10000, 10000, 8), false, "exactly the budget is allowed");
  assert.equal(overPixelBudget(10001, 10000, 8), true);
  assert.equal(overPixelBudget(12000, 9000, 8), true, "the audit's 108 MP map");
  assert.equal(overPixelBudget(16383, 6000, 8), false, "a long strip within WebP's side limit");
  // Firefox has no navigator.deviceMemory: full budget.
  assert.equal(overPixelBudget(10000, 10000, undefined), false);
  assert.equal(overPixelBudget(10001, 10000, undefined), true);
  for ( const memory of [4, 2, 0.5] ) {
    assert.equal(overPixelBudget(8000, 6250, memory), false, `50 MP with ${memory} GB`);
    assert.equal(overPixelBudget(8000, 6251, memory), true, `just over 50 MP with ${memory} GB`);
  }
  assert.equal(overPixelBudget(8000, 6251, 8), false);
  assert.equal(overPixelBudget(8000, 6251, null), false, "an unknown memory size is not a small one");
});

test("predicted output size: target bitrates times duration", () => {
  assert.equal(predictedBytes(3, 128_000), 48_000);
  assert.equal(predictedBytes(60, 2_000_000, 128_000), 15_960_000, "video plus audio");
  assert.equal(predictedBytes(60, 2_000_000, 0), 15_000_000, "a stripped audio track adds nothing");
  assert.equal(predictedBytes(0.001, 64_000), 8, "rounded up");
  assert.equal(predictedBytes(-5, 128_000), 0);
  assert.equal(predictedBytes(10), 0);
  // A two-hour 1080p30 film at the medium target does not fit a 100 MB upload; a two-minute clip does.
  const target = videoBitrate(1920, 1080, 30, "medium");
  assert.ok(predictedBytes(7200, target, 128_000) > 100_000_000);
  assert.ok(predictedBytes(120, target, 128_000) < 100_000_000);
});

test("loop tolerance: one millisecond either way", () => {
  assert.equal(sameLoopLength(3, 3), true);
  assert.equal(sameLoopLength(3, 3.0009), true);
  assert.equal(sameLoopLength(3.0009, 3), true);
  assert.equal(sameLoopLength(3, 3.0011), false);
  assert.equal(sameLoopLength(3, 3.0135), false, "what Chromium's encoder adds to a 3.000 s sound");
  assert.equal(sameLoopLength(3, 2.9935), false, "a cut tail");
  assert.equal(sameLoopLength(3, NaN), false);
  assert.equal(LOOP_BUFFER_SECONDS, 600, "Foundry's Sound.MAX_BUFFER_DURATION");
});

test("formats: kind and skip by name, output sizes", () => {
  assert.equal(kindFromName("a/Mapa.PNG?x=1"), "image");
  assert.equal(kindFromName("clip.webm"), "video");
  assert.equal(kindFromName("rain.wav"), "audio");
  assert.equal(kindFromName("icon.svg"), null);
  assert.equal(kindFromName("notes.txt"), null);
  assert.deepEqual(skipByName("icon.svg"), { kind: "image", reason: REASON.vector });
  assert.deepEqual(skipByName("map.webp"), { kind: "image", reason: REASON.alreadyOptimized });
  assert.deepEqual(skipByName("rain.ogg"), { kind: "audio", reason: REASON.alreadyOptimized });
  assert.deepEqual(skipByName("notes.txt"), { kind: null, reason: REASON.unsupported });
  assert.equal(skipByName("map.png"), null);
  assert.equal(skipByName("clip.webm"), null, "a .webm is decided by its tracks");

  assert.deepEqual(imageSize(20000, 10000, { keepResolution: false, maxImageSide: 8192 }), { width: 8192, height: 4096, resized: true });
  assert.deepEqual(imageSize(4000, 3000, { keepResolution: true }), { width: 4000, height: 3000, resized: false });
  assert.deepEqual(videoSize(3840, 2160, { keepResolution: false, maxVideoHeight: 1080 }), { width: 1920, height: 1080, resized: true });
  assert.deepEqual(videoSize(1080, 1920, { keepResolution: true, maxVideoHeight: 720 }), { width: 1080, height: 1920, resized: false });
});

/* -------------------------------------------- */
/*  converter.mjs with a fake Worker            */
/* -------------------------------------------- */

const SETTINGS = {
  keepResolution: true, maxImageSide: 8192, maxVideoHeight: 1080, imageQuality: 0.85, videoQuality: "medium",
  videoStripAudio: false, audioBitrate: 128, skipMp3BelowKbps: 160, minSavingsPct: 10, convertAnimatedGif: true
};
const CAPS = { image: true, video: true, audio: true };

/** Stands in for the module worker: records what it was sent and answers through `FakeWorker.answer`. */
class FakeWorker extends EventTarget {
  static all = [];
  /** (worker, message) => result | undefined; undefined leaves the call pending. */
  static answer = null;
  /** The converter workers (not the empty one used to detect module workers). */
  static get converters() { return FakeWorker.all.filter(w => w.url.endsWith("/scripts/media/converter-worker.mjs")); }

  constructor(url, options) {
    super();
    this.url = String(url);
    this.type = options?.type;
    this.messages = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      const result = FakeWorker.answer?.(this, message);
      if ( result !== undefined ) this.reply({ type: "result", result });
    });
  }

  reply(data) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
  fail(message) { this.dispatchEvent(Object.assign(new Event("error"), { message })); }
  terminate() { this.terminated = true; }
}

let instance = 0;
/** A fresh copy of converter.mjs (its warm worker and probe are module state). */
const load = () => import(`../scripts/media/converter.mjs?instance=${++instance}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const done = (extra = {}) => ({ status: "done", kind: "image", buffer: new Uint8Array([1, 2, 3]).buffer,
  sha256: "3fa9c21bdeadbeef".padEnd(64, "0"), bytes: 3, originalBytes: 10, ...extra });

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : done());
  Object.assign(globalThis, {
    isSecureContext: true,
    Worker: FakeWorker,
    OffscreenCanvas: function OffscreenCanvas() {},
    location: { href: "https://vtt.example/rpg/game", origin: "https://vtt.example" },
    game: { settings: { get: (_module, key) => SETTINGS[key] } },
    foundry: { utils: { getRoute: path => `/rpg/${path}` } }
  });
  delete globalThis.OfflineAudioContext;
  delete globalThis.VideoEncoder;
  delete globalThis.AudioEncoder;
});

test("conversionBlocker: insecure page", async () => {
  globalThis.isSecureContext = false;
  const { conversionBlocker, canConvert, optimizeFile } = await load();
  assert.equal(conversionBlocker(), "insecure");
  assert.equal(await canConvert("image"), false);
  assert.deepEqual(await optimizeFile(new File(["x".repeat(10)], "map.png")),
    { status: "skipped", kind: "image", originalBytes: 10, reason: REASON.notCapable });
  assert.equal(FakeWorker.all.length, 0, "no worker is started on an insecure page");
});

test("conversionBlocker: no module workers, or no encoder API at all", async () => {
  // A browser without module workers never reads the `type` option.
  globalThis.Worker = class { constructor() {} terminate() {} };
  assert.equal((await load()).conversionBlocker(), "unsupported");

  globalThis.Worker = FakeWorker;
  delete globalThis.OffscreenCanvas;
  const { conversionBlocker, canConvert } = await load();
  assert.equal(conversionBlocker(), "unsupported");
  assert.equal(await canConvert("audio"), false);
  assert.equal(FakeWorker.converters.length, 0);

  globalThis.AudioEncoder = function AudioEncoder() {};
  assert.equal((await load()).conversionBlocker(), null, "one encoder API is enough to try");
});

test("conversionBlocker: a worker that cannot start, or that can encode nothing", async () => {
  FakeWorker.answer = worker => { worker.fail("Failed to load module script"); };
  const broken = await load();
  assert.equal(broken.conversionBlocker(), null, "not known before the first probe");
  assert.equal(await broken.canConvert("image"), false);
  assert.equal(broken.conversionBlocker(), "unsupported");
  assert.equal(FakeWorker.converters[0].terminated, true);
  assert.equal((await broken.optimizeFile(new File(["x"], "map.png"))).reason, REASON.notCapable);
  assert.equal(FakeWorker.converters.length, 1, "the failed probe is not repeated");

  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? { image: false, video: false, audio: false } : done());
  const useless = await load();
  assert.equal(await useless.canConvert("video"), false);
  assert.equal(useless.conversionBlocker(), "unsupported");
});

test("canConvert asks the worker once and keeps it warm", async () => {
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? { image: true, video: false, audio: true } : done());
  const { canConvert, conversionBlocker } = await load();
  assert.deepEqual(await Promise.all(["image", "video", "audio", "pdf"].map(canConvert)), [true, false, true, false]);
  assert.equal(conversionBlocker(), null);
  const [worker] = FakeWorker.converters;
  assert.equal(FakeWorker.converters.length, 1);
  assert.equal(worker.type, "module");
  assert.deepEqual(worker.messages, [{ type: "probe" }]);
  assert.equal(worker.terminated, false);
});

test("optimizeFile: skips by name without a worker, refuses what is not a file", async () => {
  const { optimizeFile } = await load();
  assert.deepEqual(await optimizeFile(new File(["x"], "token.webp")),
    { status: "skipped", kind: "image", originalBytes: 1, reason: REASON.alreadyOptimized });
  assert.equal(FakeWorker.converters.length, 0);
  const bad = await optimizeFile("not a file", { name: "map.png" });
  assert.equal(bad.status, "failed");
  assert.equal(bad.kind, "image");
});

test("optimizeFile: the job carries a settings snapshot, the result becomes a named File", async () => {
  SETTINGS.audioBitrate = 96;
  let job;
  FakeWorker.answer = (worker, message) => {
    if ( message.type === "probe" ) return CAPS;
    job = message.job;
    worker.reply({ type: "progress", value: 0.5 });
    return done({ seconds: 1 });
  };
  try {
    const { optimizeFile } = await load();
    const file = new File(["x".repeat(10)], "Mapa da Taverna.png");
    const progress = [];
    const refs = new Set(["texture"]);
    const result = await optimizeFile(file, { referenceKinds: refs, maxOutputBytes: 5000, onProgress: p => progress.push(p) });

    assert.equal(job.name, "Mapa da Taverna.png");
    assert.equal(job.blob, file);
    assert.equal(job.url, null);
    assert.equal(job.size, 10);
    assert.equal(job.kind, null, "the worker takes the kind from the name unless the caller decided it");
    assert.equal(job.referenceKinds, refs);
    assert.equal(job.maxOutputBytes, 5000);
    assert.deepEqual(job.cfg, { keepResolution: true, maxImageSide: 8192, maxVideoHeight: 1080, imageQuality: 0.85,
      videoQuality: "medium", videoStripAudio: false, audioBitrate: 96_000, skipMp3BelowKbps: 160, minSavingsPct: 10,
      convertAnimatedGif: true });
    assert.doesNotThrow(() => structuredClone({ ...job, blob: null }), "the job is plain data a worker can receive");

    assert.deepEqual(progress, [0.5]);
    assert.deepEqual(Object.keys(result).sort(), ["bytes", "file", "kind", "originalBytes", "sha256", "status"]);
    assert.equal(result.status, "done");
    assert.ok(result.file instanceof File);
    assert.equal(result.file.name, "Mapa-da-Taverna.of-3fa9c21b.webp");
    assert.equal(result.file.type, "image/webp");
    assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), new Uint8Array([1, 2, 3]));
  } finally { SETTINGS.audioBitrate = 128; }
});

test("optimizeFile: skipped and failed answers pass through; options without a limit send null", async () => {
  const jobs = [];
  const answers = [
    { status: "skipped", kind: "image", originalBytes: 10, reason: REASON.tooLarge },
    { status: "skipped", kind: "audio", bytes: 9, originalBytes: 10, reason: REASON.noSavings },
    { status: "failed", kind: "video", originalBytes: 10, reason: "encoder produced no data" }
  ];
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : (jobs.push(message.job), answers[jobs.length - 1]));
  const { optimizeFile } = await load();
  assert.deepEqual(await optimizeFile(new File(["x"], "a.png")), answers[0]);
  assert.deepEqual(await optimizeFile(new File(["x"], "a.wav"), { kind: "audio", maxOutputBytes: 0 }), answers[1]);
  assert.deepEqual(await optimizeFile(new File(["x"], "a.mp4")), answers[2]);
  assert.deepEqual(jobs.map(j => [j.kind, j.maxOutputBytes, j.referenceKinds]), [[null, null, null], ["audio", null, null], [null, null, null]]);
  assert.equal(FakeWorker.converters.length, 1, "three conversions in a row reuse the warm worker");
});

test("optimizeUrl: the worker gets an absolute URL with the route prefix", async () => {
  let job;
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : (job = message.job, done()));
  const { optimizeUrl } = await load();
  const result = await optimizeUrl("worlds/w/Mapa Antigo.png", { kind: "image" });
  assert.equal(job.url, "https://vtt.example/rpg/worlds/w/Mapa%20Antigo.png");
  assert.equal(job.blob, null);
  assert.equal(job.name, "Mapa Antigo.png");
  assert.equal(job.kind, "image");
  assert.equal(result.file.name, "Mapa-Antigo.of-3fa9c21b.webp");

  await optimizeUrl("https://cdn.example.com/art/a.png");
  assert.equal(job.url, "https://cdn.example.com/art/a.png");
  assert.deepEqual(await optimizeUrl("worlds/w/icon.svg"), { status: "skipped", kind: "image", originalBytes: 0, reason: REASON.vector });
});

test("an aborted signal terminates the worker and rejects; the next call starts a new one", async () => {
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : undefined);
  const { optimizeFile, canConvert } = await load();
  await canConvert("image");
  const [warm] = FakeWorker.converters;

  const controller = new AbortController();
  const pending = optimizeFile(new File(["x"], "map.png"), { signal: controller.signal });
  await tick();
  assert.equal(warm.messages.at(-1).type, "convert");
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(warm.terminated, true);

  // A watchdog aborts with its own error: that is what the caller gets.
  const stalled = new AbortController();
  const second = optimizeFile(new File(["x"], "map.png"), { signal: stalled.signal });
  await tick();
  stalled.abort(new Error("no progress for 90 s"));
  await assert.rejects(second, /no progress for 90 s/);
  assert.equal(FakeWorker.converters.length, 2);
  assert.equal(FakeWorker.converters[1].terminated, true);

  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : done());
  assert.equal((await optimizeFile(new File(["x"], "map.png"))).status, "done");
  assert.equal(FakeWorker.converters.length, 3);
  assert.equal(FakeWorker.converters[2].terminated, false, "the new worker stays warm");

  await assert.rejects(optimizeFile(new File(["x"], "map.png"), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(FakeWorker.converters[2].messages.length, 1, "an already aborted call never reaches the worker");
});

test("a call that arrives while the warm worker is busy gets a worker of its own", async () => {
  const waiting = [];
  FakeWorker.answer = (worker, message) => (message.type === "probe" ? CAPS : void waiting.push(worker));
  const { optimizeFile, canConvert } = await load();
  await canConvert("image");
  const first = optimizeFile(new File(["x"], "background.png"));
  await tick();
  const second = optimizeFile(new File(["x"], "upload.png"));
  await tick();
  const [warm, extra] = FakeWorker.converters;
  assert.equal(FakeWorker.converters.length, 2);
  assert.deepEqual(waiting, [warm, extra]);

  extra.reply({ type: "result", result: done() });
  assert.equal((await second).status, "done");
  assert.equal(extra.terminated, true, "the extra worker ends with its call");
  assert.equal(warm.terminated, false);

  warm.reply({ type: "result", result: done() });
  assert.equal((await first).status, "done");
  assert.equal(warm.terminated, false, "the warm worker is kept");
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : done());
  await optimizeFile(new File(["x"], "next.png"));
  assert.equal(FakeWorker.converters.length, 2, "and reused");
});

test("a worker that dies in the middle of a conversion is a failed result, not a hang", async () => {
  FakeWorker.answer = (worker, message) => (message.type === "probe" ? CAPS : void worker.fail("out of memory"));
  const { optimizeFile, canConvert } = await load();
  await canConvert("image");
  const result = await optimizeFile(new File(["x".repeat(4)], "map.png"));
  assert.deepEqual(result, { status: "failed", kind: "image", originalBytes: 4, reason: "out of memory" });
  assert.equal(FakeWorker.converters[0].terminated, true);
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : done());
  assert.equal((await optimizeFile(new File(["x"], "map.png"))).status, "done");
  assert.equal(FakeWorker.converters.length, 2, "a new worker replaces the dead one");
});

/* -------------------------------------------- */
/*  Loop check                                  */
/* -------------------------------------------- */

/** Fake decoder: the "audio file" is one float64, its duration in seconds. Counts the decodes. */
function fakeDecoder() {
  const calls = [];
  globalThis.OfflineAudioContext = class {
    constructor(channels, length, rate) { this.rate = rate; }
    async decodeAudioData(bytes) {
      const duration = new Float64Array(bytes.slice(0, 8))[0];
      calls.push(duration);
      if ( Number.isNaN(duration) ) throw new Error("Unable to decode audio data");
      return { duration };
    }
  };
  return calls;
}
const sound = seconds => new Float64Array([seconds]).buffer;
const converted = (seconds, decodedSeconds = seconds) => done({ kind: "audio", buffer: sound(decodedSeconds), seconds, originalBytes: 8 });

test("loop: the output must decode to the length of the source", async () => {
  const decodes = fakeDecoder();
  let answer;
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : answer);
  const { optimizeFile } = await load();
  const source = new File([sound(3)], "rain.wav");

  answer = converted(3, 3.0004);
  const same = await optimizeFile(source, { loop: true });
  assert.equal(same.status, "done");
  assert.equal(same.file.name, "rain.of-3fa9c21b.ogg");
  assert.deepEqual(decodes, [3, 3.0004], "source first, then the output");

  answer = converted(3, 3.0135);
  assert.deepEqual(await optimizeFile(source, { loop: true }),
    { status: "skipped", kind: "audio", originalBytes: 8, reason: REASON.loopLength });

  // Without `loop` nothing is decoded on the page.
  decodes.length = 0;
  answer = converted(3, 3.0135);
  assert.equal((await optimizeFile(source)).status, "done");
  // Foundry streams sounds over ten minutes through an audio element: no sample-exact loop to protect.
  answer = converted(601, 700);
  assert.equal((await optimizeFile(source, { loop: true })).status, "done");
  // Only audio loops.
  answer = done({ kind: "video" });
  assert.equal((await optimizeFile(new File(["x"], "clip.mp4"), { loop: true })).status, "done");
  assert.deepEqual(decodes, []);

  // A skip stays a skip.
  answer = { status: "skipped", kind: "audio", originalBytes: 8, reason: REASON.noSavings, bytes: 8 };
  assert.equal((await optimizeFile(source, { loop: true })).reason, REASON.noSavings);
  assert.deepEqual(decodes, []);
});

test("loop: a sound that cannot be compared keeps its original", async () => {
  fakeDecoder();
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : converted(3, NaN));
  const { optimizeFile } = await load();
  const result = await optimizeFile(new File([sound(3)], "rain.wav"), { loop: true });
  assert.deepEqual(result, { status: "skipped", kind: "audio", originalBytes: 8, reason: REASON.loopLength });
});

test("loop: a stored sound is downloaded once more for the comparison", async () => {
  const decodes = fakeDecoder();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([url, init.cache]);
    return new Response(sound(12.5), { status: 200 });
  };
  FakeWorker.answer = (_worker, message) => (message.type === "probe" ? CAPS : converted(12.5));
  const { optimizeUrl } = await load();
  assert.equal((await optimizeUrl("worlds/w/sounds/wind loop.flac", { kind: "audio", loop: true })).status, "done");
  assert.deepEqual(requests, [["https://vtt.example/rpg/worlds/w/sounds/wind%20loop.flac", "no-store"]]);
  assert.deepEqual(decodes, [12.5, 12.5]);

  globalThis.fetch = async () => new Response("gone", { status: 404 });
  assert.equal((await optimizeUrl("worlds/w/sounds/wind.flac", { kind: "audio", loop: true })).reason, REASON.loopLength);
});
