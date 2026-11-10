import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeBrowser, until } from "./media-harness.mjs";

/**
 * The background optimizer without Foundry: what it holds back, when it trusts a file, and the path of a player's
 * request (convert, store, check, record) against a fake browser and server. The world has no documents here, so
 * every request is a new upload; the cases with documents are in review.test.mjs.
 */
let backfill, library, browser;
let values;
let libraryWrites = 0;
const users = Object.assign([], { activeGM: null, get: id => ({ id, can: () => id !== "guest" }) });
const MB = 1_048_576;

before(async () => {
  values = { library: {}, mediaEnabled: true, optimizeUploads: true, backfillMode: "off", backfillPaused: false,
    welcomeDone: true, includeCompendia: false, reviewApproved: [], protectActiveScene: true, cdnStatus: {},
    // read by the preload queue, whose order the optimizer follows
    networkProfile: "quickTunnel", hostUploadMbps: 20, idleSeconds: 5, preloadMaxFileMB: 100, p2pEnabled: false,
    nextScenes: [], preloadInclude: [], preloadExclude: [] };
  globalThis.foundry = { utils: { deepClone: v => structuredClone(v), getRoute: p => `/${p}` } };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  globalThis.game = {
    world: { id: "w1" },
    user: { isGM: true, isActiveGM: true },
    users,
    collections: [],
    packs: [],
    ...Object.fromEntries(["scenes", "playlists", "actors", "journal", "folders"].map(k => [k, Object.assign([], { get: () => null })])),
    i18n: { format: k => k, localize: k => k },
    settings: {
      get: (_ns, key) => values[key],
      async set(_ns, key, value) {
        if (key === "library") libraryWrites++;
        values[key] = structuredClone(value);
        return value;
      }
    }
  };
  browser = fakeBrowser();
  library = await import("../scripts/library.mjs");
  backfill = await import("../scripts/media/backfill.mjs");
});

after(async () => {
  // Let the worker finish its last item, then write what is still queued (a pending timer keeps the process alive).
  await until(() => !backfill.backfillStatus().current);
  await library.flushLibrary();
});

const request = path => backfill.onConvertRequest({ path }, "player");
const done = path => library.getStoredEntry(path)?.status === "done";

test("heavy work: every video, audio over 20 MB and images over 30 MB wait for the players to leave", () => {
  assert.equal(backfill.isHeavy("video", 1000), true, "any video");
  assert.equal(backfill.isHeavy("audio", 20 * MB), false);
  assert.equal(backfill.isHeavy("audio", 20 * MB + 1), true);
  assert.equal(backfill.isHeavy("image", 30 * MB), false);
  assert.equal(backfill.isHeavy("image", 30 * MB + 1), true);
  assert.equal(backfill.isHeavy("image", null), false, "a size the server does not tell is not heavy");
  assert.equal(backfill.backfillStatus().waitingForPlayers, 0);
});

test("re-pointing: an original of the same size is the same file even when its ETag changed", () => {
  const entry = { original: "modules/x/map.jpg", source: 'W/"64-1"', originalBytes: 100 };
  assert.equal(backfill.sameOriginal(entry, { fingerprint: 'W/"64-1"', bytes: 100 }), true);
  assert.equal(backfill.sameOriginal(entry, { fingerprint: 'W/"64-2"', bytes: 100 }), true, "a module update only changed the date");
  assert.equal(backfill.sameOriginal(entry, { fingerprint: 'W/"65-2"', bytes: 101 }), false, "replaced");
  assert.equal(backfill.sameOriginal(entry, { fingerprint: 'W/"64-2"', bytes: null }), false, "size unknown");
  assert.equal(backfill.sameOriginal({ original: "a.jpg", source: "x" }, { fingerprint: "y", bytes: 100 }), false, "no size on record");
  // Uncompressed: another sound of the same length has the same size.
  const wav = { original: "sfx/rain.wav", source: 'W/"64-1"', originalBytes: 100 };
  assert.equal(backfill.sameOriginal(wav, { fingerprint: 'W/"64-2"', bytes: 100 }), false);
  assert.equal(backfill.sameOriginal(wav, { fingerprint: 'W/"64-1"', bytes: 100 }), true);
});

test("registration: only a browser's own converted upload, and never over an entry that exists", async () => {
  const mine = "worlds/w1/uploads/token.of-0123abcd.webp";
  const entry = { original: mine, optimized: mine, kind: "image", sha256: "a".repeat(64), bytes: 10, originalBytes: 100,
    uploadedName: "token.png" };
  // A world file mapped to a player's file: the cleanup would offer to empty that world file.
  assert.equal(await backfill.onRegisterOptimized({ ...entry, original: "worlds/w1/maps/secret.png" }, "player"), false);
  assert.equal(library.getEntry("worlds/w1/maps/secret.png"), null);
  assert.equal(await backfill.onRegisterOptimized({ ...entry, optimized: "worlds/w1/uploads/token.webp", original: "worlds/w1/uploads/token.webp" }, "player"), false, "not an optimized name");
  assert.equal(await backfill.onRegisterOptimized(entry, "guest"), false, "no upload permission");

  assert.equal(await backfill.onRegisterOptimized(entry, "player"), true);
  await library.flushLibrary();
  assert.deepEqual({ ...values.library[mine], at: 0 }, { optimized: mine, kind: "image", status: "done", attempts: 0,
    rewritten: true, sha256: "a".repeat(64), bytes: 10, originalBytes: 100, uploadedName: "token.png", at: 0 });
  assert.equal(library.getEntry(mine).original, mine);

  // The hash is what players check shared files against: a second registration cannot replace it.
  assert.equal(await backfill.onRegisterOptimized({ ...entry, sha256: "b".repeat(64) }, "player"), false);
  assert.equal(library.getEntry(mine).sha256, "a".repeat(64));
});

test("a player's new upload converts at once, whatever the mode; its copy is checked and its entry stored", async () => {
  browser.files.set("worlds/w1/uploads/a.png", 100);
  values.backfillPaused = true;
  assert.deepEqual(await request("worlds/w1/uploads/a.png"), { queued: true });
  await until(() => done("worlds/w1/uploads/a.png"));
  const entry = library.getEntry("worlds/w1/uploads/a.png");
  assert.match(entry.optimized, /^worlds\/w1\/uploads\/a\.of-[0-9a-f]{8}\.webp$/);
  assert.equal(browser.files.get(entry.optimized), 10, "stored next to the original");
  assert.deepEqual([entry.bytes, entry.originalBytes, entry.source], [10, 100, 'W/"64-1"']);
  assert.equal("original" in values.library["worlds/w1/uploads/a.png"], false);
  assert.ok(browser.heads.filter(p => p === entry.optimized).length >= 2, "looked for before the upload and checked after it");
  values.backfillPaused = false;

  assert.deepEqual(await request("worlds/w1/uploads/a.png"), { queued: false }, "already converted");
  assert.deepEqual(await request("worlds/w1/uploads/a.of-0123abcd.webp"), { queued: false });
  assert.deepEqual(await request("https://elsewhere.example/a.png"), { queued: false });
});

test("uploads: a file already there under the same name is reused only when it is whole", async () => {
  const copyOf = p => library.getEntry(p).optimized;
  // Whole already (a run that crashed before its entry was stored): no upload.
  browser.files.set("worlds/w1/uploads/b.png", 100);
  await request("worlds/w1/uploads/b.png");
  await until(() => done("worlds/w1/uploads/b.png"));
  const copy = copyOf("worlds/w1/uploads/b.png");
  await library.removeEntries(["worlds/w1/uploads/b.png"]);
  const before = browser.uploads.length;
  await request("worlds/w1/uploads/b.png");
  await until(() => done("worlds/w1/uploads/b.png"));
  assert.equal(browser.uploads.length, before, "the file was there, whole: reused");

  // Cut short (the disk filled up during an earlier upload): uploaded again over it.
  await library.removeEntries(["worlds/w1/uploads/b.png"]);
  browser.files.set(copy, 4);
  await request("worlds/w1/uploads/b.png");
  await until(() => done("worlds/w1/uploads/b.png"));
  assert.equal(browser.uploads.length, before + 1);
  assert.equal(browser.files.get(copy), 10);
});

test("uploads: three failures in a row stop the run with one notice and cost the files no attempt", async () => {
  const paths = ["c1", "c2", "c3"].map(n => `worlds/w1/uploads/${n}.png`);
  for (const p of paths) browser.files.set(p, 100);
  browser.server.truncate = true; // the server stores every upload cut short
  const notices = browser.notices.length;
  for (const p of paths) await request(p);
  await until(() => backfill.backfillStatus().lastError?.reason === "uploadStopped");
  browser.server.truncate = false;

  const status = backfill.backfillStatus();
  assert.equal(status.paused, true, "stopped until the GM presses Start");
  assert.equal(status.running, false);
  for (const p of paths) {
    const e = library.getEntry(p);
    assert.deepEqual([e.status, e.reason, e.attempts, e.optimized], ["failed", "uploadFailed", 0, null], p);
  }
  const said = browser.notices.slice(notices).filter(n => n.level === "error");
  assert.deepEqual(said.map(n => n.text), ["OPTIMALFOUNDRY.Library.UploadStopped"]);
});

test("heavy: a video waits while a player is connected, and converts when the GM asks for it now", async () => {
  browser.files.set("worlds/w1/uploads/intro.mp4", 5000);
  browser.files.set("worlds/w1/uploads/small.png", 100);
  users.push({ id: "p1", active: true, isGM: false });
  try {
    await request("worlds/w1/uploads/intro.mp4");
    await request("worlds/w1/uploads/small.png");
    await until(() => done("worlds/w1/uploads/small.png"));
    assert.equal(backfill.backfillStatus().waitingForPlayers, 1, "the video is held, the small image is not");
    assert.equal(library.getEntry("worlds/w1/uploads/intro.mp4"), null);
    assert.deepEqual(await request("worlds/w1/uploads/intro.mp4"), { queued: true }, "asked twice: still one item");
    assert.equal(backfill.backfillStatus().waitingForPlayers, 1);

    assert.equal(await backfill.runHeavyNow(), 1);
    await until(() => done("worlds/w1/uploads/intro.mp4"));
    assert.equal(backfill.backfillStatus().waitingForPlayers, 0);
    assert.match(library.getEntry("worlds/w1/uploads/intro.mp4").optimized, /intro\.of-[0-9a-f]{8}\.webm$/);
    assert.equal(await backfill.runHeavyNow(), 0, "nothing left to release");
  } finally { users.pop(); }
});
