import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fakeBrowser, until } from "./media-harness.mjs";

/**
 * The background optimization over real documents: review mode (the scan holds back conversions the GM has not
 * approved, approving saves the approval before anything converts, declining records "leave as it is", nothing starts
 * on its own before the welcome screen), a player's request for a file the documents already use, the self-repair
 * of references to copies that are gone, and the one library write per batch of re-pointing.
 * Documents use the real v14 schemas: set FOUNDRY_APP to the app's Resources/app folder when Foundry is installed
 * elsewhere; without Foundry (CI) every test here is skipped.
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";
const skip = existsSync(`${APP}/common/server.mjs`) ? false : `Foundry is not installed at ${APP} (set FOUNDRY_APP)`;

let backfill, library, browser;
let values;
let libraryWrites = 0;
/** Called by the fake database before it stores a request. */
let onUpdate = null;
const actors = () => game.collections[0];
/** A document of the fake world or of its compendia, embedded ones included, by uuid. */
function find(uuid) {
  const within = doc => {
    if (doc.uuid === uuid) return doc;
    for (const name of Object.keys(doc.constructor.hierarchy ?? {})) {
      const children = doc[name];
      if (!children?.[Symbol.iterator]) continue;
      for (const child of children) { const hit = within(child); if (hit) return hit; }
    }
    return null;
  };
  for (const collection of [...game.collections, ...game.packs.map(p => p.documents)]) {
    for (const doc of collection) { const hit = within(doc); if (hit) return hit; }
  }
  return null;
}
const defaults = () => ({
  library: {}, mediaEnabled: true, optimizeUploads: true, backfillMode: "review", backfillPaused: false, reviewApproved: [], welcomeDone: true,
  includeCompendia: false, nextScenes: [], preloadInclude: [], preloadExclude: [], scanReport: {}, protectActiveScene: true,
  prototypeTokenOverrides: { base: {} }, networkProfile: "auto", cdnStatus: {}, hostUploadMbps: 20, idleSeconds: 5,
  preloadMaxFileMB: 100, p2pEnabled: true, maxConcurrentRequests: 150, preloadSharePct: 60, staggerJoin: true
});

before(async () => {
  if (skip) return;
  const common = await import(`${APP}/common/server.mjs`);
  // Module namespaces are frozen; getRoute and fromUuid (client-only) are added on a copy.
  globalThis.foundry = { ...common, utils: { ...common.utils, getRoute: p => `/${p}`, fromUuid: async uuid => find(uuid),
    fromUuidSync: find } };
  globalThis.CONST = foundry.CONST;
  // What the client's database backend does, without the socket: store every update of the request.
  globalThis.CONFIG = { Token: {}, DatabaseBackend: { async update(cls, operation) {
    onUpdate?.(operation);
    for (const update of operation.updates) {
      const doc = operation.parent ? operation.parent.getEmbeddedCollection(cls.documentName).get(update._id)
        : find(`${cls.documentName}.${update._id}`);
      doc.updateSource(update);
    }
    return [];
  } } };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  browser = fakeBrowser(); // files it does not hold answer 404
  globalThis.game = {
    world: { id: "w1" },
    user: { isGM: true, isActiveGM: true },
    users: Object.assign([], { activeGM: null, get: id => ({ id, can: () => true }) }),
    model: { Actor: { base: {} }, Item: { base: {} } },
    release: { version: "14.370" },
    system: { id: "test", grid: { type: 1, distance: 5, units: "ft" }, documentTypes: {} },
    modules: new Map(),
    packs: [],
    ...Object.fromEntries(["scenes", "playlists", "actors", "journal", "folders"].map(k => [k, Object.assign([], { get: () => null })])),
    i18n: { lang: "en", format: k => k, localize: k => k },
    settings: {
      get: (_ns, key) => structuredClone(values[key]),
      async set(_ns, key, value) {
        if (key === "library") libraryWrites++;
        values[key] = structuredClone(value);
        return value;
      }
    }
  };
  Object.defineProperty(foundry.abstract.Document.prototype, "uuid", {
    configurable: true,
    get() {
      if (this.parent) return `${this.parent.uuid}.${this.documentName}.${this.id}`;
      return `${this.pack ? `Compendium.${this.pack}.` : ""}${this.documentName}.${this.id}`;
    }
  });
  library = await import("../scripts/library.mjs");
  backfill = await import("../scripts/media/backfill.mjs");
});

const actor = (name, img) => new foundry.documents.BaseActor({ _id: foundry.utils.randomID(), name, type: "base", img });

beforeEach(async () => {
  if (skip) return;
  await library.flushLibrary();
  values = defaults();
  library.forgetApproved();
  browser.files.clear();
  for (const list of [browser.uploads, browser.heads, browser.notices]) list.length = 0;
  onUpdate = null;
  game.collections = [Object.assign([actor("A", "art/a.png"), actor("B", "art/b.jpg"), actor("C", "art/c.webp")],
    { documentName: "Actor" })];
});

after(async () => {
  if (skip) return;
  // Let the worker finish, then write what is still queued (a pending timer keeps the process alive).
  await until(() => !backfill.backfillStatus().current);
  await library.flushLibrary();
});

const reviewPaths = () => backfill.reviewList().map(i => i.original).sort();

// First on purpose: no scan has run yet, so the first request has to read the world itself.
test("requests: a file the documents already use follows the mode and the pause, whoever asks", { skip }, async () => {
  const ask = path => backfill.onConvertRequest({ path }, "player");
  assert.deepEqual(await ask("art/a.png"), { queued: false });
  assert.deepEqual(reviewPaths(), ["art/a.png"], "review mode: it waits for the GM, like any existing file");
  await backfill.scan();
  assert.deepEqual(await ask("art/b.jpg"), { queued: false });
  assert.deepEqual(reviewPaths(), ["art/a.png", "art/b.jpg"]);

  // Automatic mode, paused: it stays in the queue, behind the pause.
  values.backfillMode = "auto";
  values.backfillPaused = true;
  await backfill.scan();
  assert.deepEqual(await ask("art/a.png"), { queued: false });
  const status = backfill.backfillStatus();
  assert.deepEqual([status.queued, status.review, status.running, status.current], [2, 0, false, undefined]);

  // Existing files off: nothing at all.
  values.backfillMode = "off";
  await backfill.scan();
  assert.deepEqual(await ask("art/a.png"), { queued: false });
  assert.equal(backfill.backfillStatus().queued, 0);
  assert.deepEqual(browser.uploads, [], "nothing was converted");
});

test("review: the scan holds back unapproved conversions; auto queues them; off keeps nothing", { skip }, async () => {
  let r = await backfill.scan();
  assert.equal(r.review, 2);
  assert.deepEqual(reviewPaths(), ["art/a.png", "art/b.jpg"], "webp is already light, never offered");
  assert.equal(backfill.backfillStatus().queued, 0);
  assert.equal(backfill.reviewList()[0].refs.length, 1, "the documents that use each file");

  values.reviewApproved = ["art/a.png"];
  library.forgetApproved();
  r = await backfill.scan();
  assert.deepEqual(reviewPaths(), ["art/b.jpg"]);
  assert.equal(backfill.backfillStatus().queued, 1, "an approved file is queued");

  values.backfillMode = "auto";
  await backfill.scan();
  assert.deepEqual(reviewPaths(), []);
  assert.equal(backfill.backfillStatus().queued, 2);

  values.backfillMode = "off";
  await backfill.scan();
  assert.equal(backfill.backfillStatus().queued, 0);
  assert.deepEqual(reviewPaths(), []);
  assert.equal(await backfill.start(), false, "start refuses while existing files are off");
  const report = values.scanReport.byOrigin.data;
  assert.equal(report.review, 2, "the scan table says they wait for you");
  assert.equal(report.light, 1);
});

test("review: approving saves the approval first and queues the files; declining records them as skipped", { skip }, async () => {
  values.backfillPaused = true;
  await backfill.scan();
  const n = await backfill.approve(["art/a.png"]);
  backfill.pause(); // keep the test from converting
  assert.equal(n, 1);
  assert.deepEqual(values.reviewApproved, ["art/a.png"]);
  assert.equal(values.backfillPaused, false, "approving means go");
  assert.deepEqual(reviewPaths(), ["art/b.jpg"]);
  assert.equal(library.willConvert("art/a.png"), true);
  assert.equal(library.willConvert("art/b.jpg"), false, "not approved: the preload warms the original");

  assert.equal(await backfill.decline(["art/b.jpg"]), 1);
  assert.deepEqual(reviewPaths(), []);
  const entry = library.getEntry("art/b.jpg");
  assert.equal(entry.status, "skipped");
  assert.equal(entry.reason, "declined");
  await backfill.scan();
  assert.deepEqual(reviewPaths(), [], "a declined file is not offered again");
});

test("review: nothing converts on its own before the welcome screen", { skip }, () => {
  values.welcomeDone = false;
  values.backfillMode = "auto";
  assert.equal(library.willConvert("art/a.png"), false);
  assert.equal(backfill.backfillStatus().waitingWelcome, true);
  values.welcomeDone = true;
  assert.equal(library.willConvert("art/a.png"), true);
  values.backfillPaused = true;
  assert.equal(library.willConvert("art/a.png"), false, "paused");
});

test("review: before the welcome screen, Start refuses and an approval is only saved", { skip }, async () => {
  values.welcomeDone = false;
  await backfill.scan();
  assert.equal(await backfill.start(), false);
  assert.equal(await backfill.approve(["art/a.png"]), 1);
  assert.deepEqual(values.reviewApproved, ["art/a.png"], "kept for when the welcome screen is done");
  assert.equal(backfill.backfillStatus().running, false, "nothing converts yet");
});

test("review: declining never overwrites a file converted meanwhile; a persisted pause shows as paused", { skip }, async () => {
  await backfill.scan();
  await library.putEntries({ original: "art/b.jpg", kind: "image", status: "done", optimized: "art/b.of-12345678.webp" }, { now: true });
  assert.equal(await backfill.decline(["art/b.jpg"]), 0);
  assert.equal(library.getEntry("art/b.jpg").status, "done");
  assert.deepEqual(reviewPaths(), ["art/a.png"], "the converted one left the list");
  values.backfillPaused = true;
  assert.equal(backfill.backfillStatus().paused, true);
});

test("self-repair: references to a copy that is gone or cut short go back to the original, which converts again", { skip }, async () => {
  // Copies an earlier version kept at the Data root; the world was moved to another server without them.
  const gone = "optimal-foundry/modules/x/gone.of-0123abcd.webp";
  const cut = "art/cut.of-0123abcd.webp";
  const kept = "art/kept.of-0123abcd.webp";
  const lost = "art/lost.of-0123abcd.webp";
  const [G, U, K, L] = [gone, cut, kept, lost].map((path, i) => actor(`R${i}`, path));
  actors().push(G, U, K, L);
  const entry = optimized => ({ status: "done", kind: "image", optimized, bytes: 10, originalBytes: 100, source: "s", rewritten: true });
  values.library = { "modules/x/gone.png": entry(gone), "art/cut.png": entry(cut), "art/kept.png": entry(kept), "art/lost.png": entry(lost) };
  library.indexLibrary();
  for (const [path, size] of [["modules/x/gone.png", 100], ["art/cut.png", 100], [cut, 4], ["art/kept.png", 100], [kept, 10]]) {
    browser.files.set(path, size);
  }

  await backfill.scan();
  assert.equal(G.img, "modules/x/gone.png", "the copy is missing: back to the original");
  assert.equal(U.img, "art/cut.png", "the copy is shorter than recorded: back to the original");
  assert.equal(K.img, kept, "a whole copy is left alone");
  assert.equal(L.img, lost, "the original is gone too: nothing to go back to");
  assert.equal(library.getEntry("modules/x/gone.png"), null, "forgotten, so it converts again");
  assert.equal(library.getEntry("art/cut.png"), null);
  assert.equal(library.getEntry("art/kept.png").status, "done");
  assert.equal(library.getEntry("art/lost.png").status, "done");
  assert.equal(values.scanReport.repaired, 2);
  assert.ok(["modules/x/gone.png", "art/cut.png"].every(p => reviewPaths().includes(p)), "review mode asks again");
  assert.equal(values.scanReport.byOrigin.module.review, 1, "counted where the original lives");
  assert.ok(browser.notices.some(n => n.text === "OPTIMALFOUNDRY.Library.Repaired"));
});

test("batch: converted files are stored with one library write, before their documents are re-pointed", { skip }, async () => {
  values.backfillMode = "auto";
  browser.files.set("art/a.png", 100);
  browser.files.set("art/b.jpg", 200);
  const [A, B] = actors();
  await backfill.scan(); // the queue of the test before this one is not this world's
  const writesBefore = libraryWrites;
  const atUpdate = [];
  onUpdate = () => atUpdate.push({
    writes: libraryWrites - writesBefore,
    stored: ["art/a.png", "art/b.jpg"].map(p => values.library[p]?.status)
  });

  assert.equal(await backfill.start(), true);
  await until(() => A.img.includes(".of-") && B.img.includes(".of-"));
  assert.deepEqual(atUpdate, [{ writes: 1, stored: ["done", "done"] }], "one write for both, and it came first");
  assert.match(A.img, /^art\/a\.of-[0-9a-f]{8}\.webp$/);
  assert.equal(browser.files.get(A.img), 10);
  assert.equal("original" in values.library["art/a.png"], false);
  await until(() => !backfill.backfillStatus().running);

  // A manual scan after the run (it also cancels the optimizer's own delayed one).
  await backfill.scan();
  assert.deepEqual([values.scanReport.byOrigin.data.optimized, values.scanReport.byOrigin.data.light], [2, 1]);
  assert.equal(library.getEntry("art/a.png").rewritten, true);
});

const copyOf = path => path.replace(/\.\w+$/, ".of-0123abcd.webp");
const converted = (path, extra) => ({ status: "done", kind: "image", optimized: copyOf(path), bytes: 10, originalBytes: 100,
  source: 'W/"64-1"', ...extra });

test("re-pointing: an emptied original uses its copy, a new file under its name does not, a new date alone changes nothing", { skip }, async () => {
  values.backfillMode = "auto";
  const [A, B] = actors();
  const D = actor("D", "art/d.png");
  actors().push(D);
  values.library = {
    "art/a.png": converted("art/a.png", { cleaned: 1 }),          // emptied by the cleanup
    "art/b.jpg": converted("art/b.jpg", { cleaned: 1 }),          // emptied; then the GM put another picture there
    "art/d.png": converted("art/d.png", { source: 'W/"64-0"' })   // the same file with a new date (a restored backup)
  };
  for (const [path, size] of [["art/a.png", 0], ["art/b.jpg", 300], ["art/d.png", 100]]) browser.files.set(path, size);
  for (const path of ["art/a.png", "art/b.jpg", "art/d.png"]) browser.files.set(copyOf(path), 10);
  browser.server.convert = (job, path) => ({ status: "done", kind: "image", sha256: "f".repeat(64), bytes: 10,
    originalBytes: browser.files.get(path), buffer: new ArrayBuffer(10) });
  try {
    await backfill.scan(); // the queue of the test before this one is not this world's
    assert.equal(await backfill.start(), true);
    await until(() => [A, B, D].every(doc => doc.img.includes(".of-")));
  } finally { browser.server.convert = undefined; }

  assert.equal(A.img, copyOf("art/a.png"), "nothing left in the original: the copy is the file");
  assert.equal(D.img, copyOf("art/d.png"), "same size: re-pointed at once, not converted again");
  assert.equal(B.img, "art/b.of-ffffffff.webp", "a new picture is a new original, never the old copy");
  assert.deepEqual(browser.uploads, ["art/b.of-ffffffff.webp"]);
  await until(() => !backfill.backfillStatus().running);
  await backfill.scan();
  const b = library.getEntry("art/b.jpg");
  assert.deepEqual([b.cleaned, b.originalBytes, b.source], [undefined, 300, 'W/"12c-1"']);
  assert.equal(library.getEntry("art/a.png").cleaned, 1);
  assert.equal(library.getEntry("art/d.png").source, 'W/"64-1"', "the fingerprint follows the file");
});

test("undo: each original is looked at right before re-pointing; an emptied one keeps its copy, a restored one comes back", { skip }, async () => {
  const [A, B] = actors();
  const D = actor("D", copyOf("art/d.png"));
  actors().push(D);
  A.updateSource({ img: copyOf("art/a.png") });
  B.updateSource({ img: copyOf("art/b.jpg") });
  values.library = {
    "art/a.png": converted("art/a.png"),
    "art/b.jpg": converted("art/b.jpg"),                  // emptied meanwhile by another session, mark not seen yet
    "art/d.png": converted("art/d.png", { cleaned: 1 })   // marked as emptied, but the file is back as it was
  };
  for (const [path, size] of [["art/a.png", 100], ["art/b.jpg", 0], ["art/d.png", 100]]) browser.files.set(path, size);

  assert.deepEqual(await backfill.undo(), { reverted: 2, kept: 1, updated: 2, failed: 0 });
  await backfill.scan(); // the one undo started in the background
  assert.deepEqual([A.img, B.img, D.img], ["art/a.png", copyOf("art/b.jpg"), "art/d.png"]);
  const [a, b, d] = ["art/a.png", "art/b.jpg", "art/d.png"].map(p => library.getEntry(p));
  assert.deepEqual([a.status, a.reason, a.optimized], ["skipped", "restored", copyOf("art/a.png")]);
  assert.deepEqual([b.status, !!b.cleaned], ["done", true], "never pointed at an empty file; marked now");
  assert.deepEqual([d.status, d.reason, d.cleaned], ["skipped", "restored", undefined]);
});

test("a conversion that was interrupted is final after one attempt", { skip }, async () => {
  values.backfillMode = "auto";
  values.library = { "art/b.jpg": { status: "failed", reason: "encodeError", attempts: 1 } };
  // What a tab that crashed while converting art/a.png left behind.
  globalThis.localStorage = {
    marker: JSON.stringify({ world: "w1", original: "art/a.png", kind: "image" }),
    getItem() { return this.marker; },
    removeItem() { this.marker = null; },
    setItem() {}
  };
  try { await backfill.scan(); }
  finally { delete globalThis.localStorage; }
  const e = library.getEntry("art/a.png");
  assert.deepEqual([e.status, e.reason, e.attempts], ["failed", "interrupted", 1]);
  assert.equal(backfill.backfillStatus().queued, 1, "only the ordinary failure gets another try");
  assert.deepEqual([values.scanReport.byOrigin.data.failed, values.scanReport.byOrigin.data.queued], [1, 1]);
});

test("looping audio: an ambient sound and a repeating track are converted only as exact loops", { skip }, async () => {
  values.backfillMode = "auto";
  const id = () => foundry.utils.randomID();
  const scene = new foundry.documents.BaseScene({ _id: id(), name: "Storm",
    sounds: [{ _id: id(), path: "sfx/rain.wav", radius: 10 }] });
  const playlist = new foundry.documents.BasePlaylist({ _id: id(), name: "Music", sounds: [
    { _id: id(), name: "Theme", path: "music/theme.wav", repeat: false },
    { _id: id(), name: "Drone", path: "music/drone.wav", repeat: true }
  ] });
  game.collections = [Object.assign([], { documentName: "Actor" }), Object.assign([scene], { documentName: "Scene" }),
    Object.assign([playlist], { documentName: "Playlist" })];
  const paths = ["sfx/rain.wav", "music/theme.wav", "music/drone.wav"];
  for (const p of paths) browser.files.set(p, 1000);

  await backfill.scan(); // the queue of the test before this one is not this world's
  assert.equal(await backfill.start(), true);
  await until(() => paths.every(p => library.getEntry(p)) && !backfill.backfillStatus().running);
  await backfill.scan();
  // node has no audio decoder, so no converted loop can be shown to be exact: the two that loop keep their original.
  const outcome = p => { const e = library.getEntry(p); return [e.status, e.reason]; };
  assert.deepEqual(outcome("sfx/rain.wav"), ["skipped", "loopLength"]);
  assert.deepEqual(outcome("music/drone.wav"), ["skipped", "loopLength"]);
  assert.deepEqual(outcome("music/theme.wav"), ["done", undefined]);
  const [theme, drone] = [...playlist.sounds];
  assert.match(theme.path, /^music\/theme\.of-[0-9a-f]{8}\.ogg$/);
  assert.equal(drone.path, "music/drone.wav");
});

test("compendia are read from the server at a manual scan, and kept for the optimizer's own scans", { skip }, async () => {
  let reads = 0;
  const documents = [new foundry.documents.BaseActor({ _id: foundry.utils.randomID(), name: "P", type: "base", img: "art/pack.png" },
    { pack: "world.things" })];
  const pack = { collection: "world.things", documentName: "Actor", metadata: { packageType: "world" }, index: { size: 1 },
    documents, get: id => documents.find(d => d.id === id), async getDocuments() { reads++; return documents; } };
  game.packs = Object.assign([pack], { get: id => (id === pack.collection ? pack : null) });
  try {
    values.includeCompendia = true;
    await backfill.scan();
    assert.equal(reads, 1);
    assert.ok(reviewPaths().includes("art/pack.png"));

    // "Try again" forgets an entry and scans without being asked: no new read, same result.
    values.library = { "art/a.png": { status: "skipped", reason: "declined" } };
    assert.equal(await backfill.retry(["art/a.png"]), 1);
    assert.equal(reads, 1);
    assert.deepEqual(reviewPaths(), ["art/a.png", "art/b.jpg", "art/pack.png"]);

    await backfill.scan();
    assert.equal(reads, 2, "a manual scan always reads them again");

    // Turned off and on again: what was kept is dropped, so the next scan of any kind reads.
    values.includeCompendia = false;
    await backfill.scan();
    assert.deepEqual([reads, reviewPaths()], [2, ["art/a.png", "art/b.jpg"]]);
    values.includeCompendia = true;
    values.library = { "art/b.jpg": { status: "skipped", reason: "declined" } };
    assert.equal(await backfill.retry(["art/b.jpg"]), 1);
    assert.equal(reads, 3);
    assert.ok(reviewPaths().includes("art/pack.png"));
  } finally { game.packs = []; }
});

/* -------------------------------------------- */
/*  Wildcard token art                          */
/* -------------------------------------------- */

const T = "worlds/w1/tokens";
const PNG = `${T}/goblin-*.png`, WEBP = `${T}/goblin-*.webp`;
/** An actor whose prototype token picks one of the files of a pattern. */
const wild = (name, src, extra = {}) => new foundry.documents.BaseActor({ _id: foundry.utils.randomID(), name, type: "base",
  img: "art/hero.webp", prototypeToken: { randomImg: true, texture: { src } }, ...extra });
const art = doc => doc._source.prototypeToken.texture.src;
const patternFlag = doc => doc._source.flags?.["optimal-foundry"]?.tokenPattern;
/** A world with a goblin actor in it and the files its pattern picks. */
function goblins(src = PNG, names = ["goblin-1.png", "goblin-2.png"]) {
  const goblin = wild("Goblin", src);
  actors().push(goblin);
  for (const [i, n] of names.entries()) browser.files.set(`${T}/${n}`, 100 + i);
  return goblin;
}
/** Run the optimizer over everything and wait for it to stop (a manual scan after it cancels its delayed rescan). */
async function optimizeAll() {
  values.backfillMode = "auto";
  await backfill.scan(); // the queue of the test before this one is not this world's
  assert.equal(await backfill.start(), true);
  await until(() => !backfill.backfillStatus().running && !backfill.backfillStatus().current);
  await backfill.scan();
}
const goblinEntries = () => [1, 2].map(n => library.getEntry(`${T}/goblin-${n}.png`));

test("token art: the files a pattern picks are listed for review with the actor as where they are used", { skip }, async () => {
  const goblin = goblins();
  await backfill.scan();
  assert.deepEqual(reviewPaths().filter(p => p.startsWith(T)), [`${T}/goblin-1.png`, `${T}/goblin-2.png`]);
  const item = backfill.reviewList().find(i => i.original === `${T}/goblin-1.png`);
  assert.deepEqual([item.kind, item.refs], ["image", [goblin.uuid]]);
  assert.equal(values.scanReport.byOrigin.world.review, 2, "counted like any other file");
});

test("token art: the pattern moves to the copies only when every file it picks is converted", { skip }, async () => {
  const goblin = goblins();
  const operations = [];
  onUpdate = op => operations.push(op);
  await backfill.scan();
  assert.equal(await backfill.approve([`${T}/goblin-1.png`]), 1);
  await until(() => library.getStoredEntry(`${T}/goblin-1.png`)?.status === "done" && !backfill.backfillStatus().running);
  assert.equal(art(goblin), PNG, "one file is still waiting for review: nothing may change");
  assert.deepEqual(operations, []);

  assert.equal(await backfill.approve([`${T}/goblin-2.png`]), 1);
  await until(() => art(goblin) === WEBP);
  await until(() => !backfill.backfillStatus().running);
  await backfill.scan();
  assert.equal(patternFlag(goblin), PNG, "the old pattern is remembered");
  assert.equal(operations.length, 1, "one update");
  assert.equal(operations[0].updates.length, 1);
  assert.equal(operations[0]["optimal-foundry"].rewrite, true, "the document hooks can tell it apart");
  const [a, b] = goblinEntries();
  assert.match(a.optimized, /^worlds\/w1\/tokens\/goblin-1\.of-[0-9a-f]{8}\.webp$/);
  assert.deepEqual([a.status, b.status], ["done", "done"]);
  assert.deepEqual(browser.uploads.map(p => p.split("/").pop().split(".")[0]).sort(), ["goblin-1", "goblin-2"]);
  assert.deepEqual(reviewPaths().filter(p => p.startsWith(T)), [], "the copies are not offered again");
  assert.equal(values.scanReport.byOrigin.world.optimized, 2);
});

test("token art: a second scan rewrites a pattern whose files were all converted before", { skip }, async () => {
  const goblin = goblins();
  values.library = { [`${T}/goblin-1.png`]: converted(`${T}/goblin-1.png`), [`${T}/goblin-2.png`]: converted(`${T}/goblin-2.png`) };
  for (const n of [1, 2]) {
    browser.files.set(`${T}/goblin-${n}.png`, 100);
    browser.files.set(copyOf(`${T}/goblin-${n}.png`), 10);
  }
  library.indexLibrary();
  await optimizeAll();
  assert.equal(art(goblin), WEBP);
  assert.deepEqual(browser.uploads, [], "nothing was converted again");
});

// What keeps a pattern as it is, each on its own: the files are converted either way.
const stays = [
  ["a file was skipped as no gain", { convert: (job, path) => (path.endsWith("goblin-2.png")
    ? { status: "skipped", reason: "noSavings", kind: "image", originalBytes: 101 } : undefined) }],
  ["the pattern has no literal extension", { src: `${T}/goblin-*` }],
  ["the pattern uses braces", { src: `${T}/{goblin,orc}-*.png`, patterns: { [`${T}/{goblin,orc}-*.png`]: [`${T}/goblin-1.png`, `${T}/goblin-2.png`] } }],
  ["the pattern uses a bracket class", { src: `${T}/goblin-[12]*.png`, patterns: { [`${T}/goblin-[12]*.png`]: [`${T}/goblin-1.png`, `${T}/goblin-2.png`] } }],
  ["sanitizing changed a name so the new pattern no longer matches", { src: `${T}/G?blin-*.png`, names: ["Gøblin-1.png", "Gøblin-2.png"] }],
  ["a stray file would also match the new pattern", { stray: `${T}/goblin-extra.of-deadbeef.webp` }]
];
for (const [why, { src, names, stray, convert, patterns }] of stays) {
  test(`token art: the pattern stays when ${why}`, { skip }, async () => {
    const goblin = goblins(src, names);
    if (stray) browser.files.set(stray, 10);
    browser.server.patterns = patterns;
    if (convert) browser.server.convert = (job, path) => convert(job, path) ?? { status: "done", kind: "image",
      sha256: "ab".repeat(32), bytes: 10, originalBytes: 100, buffer: new ArrayBuffer(10) };
    onUpdate = op => assert.fail(`unexpected update ${JSON.stringify(op.updates)}`);
    try { await optimizeAll(); }
    finally { browser.server.convert = undefined; browser.server.patterns = undefined; }
    assert.equal(art(goblin), src ?? PNG);
    assert.equal(patternFlag(goblin), undefined);
    assert.ok(browser.uploads.length >= 1, "the files behind the pattern are converted all the same");
  });
}

test("token art: a pattern is not rewritten while a file of it failed", { skip }, async () => {
  const goblin = goblins();
  browser.server.convert = (job, path) => {
    if (path.endsWith("goblin-2.png")) return { status: "failed", reason: "encoder broke" };
    return { status: "done", kind: "image", sha256: "cd".repeat(32), bytes: 10, originalBytes: 100, buffer: new ArrayBuffer(10) };
  };
  try { await optimizeAll(); }
  finally { browser.server.convert = undefined; }
  assert.equal(library.getEntry(`${T}/goblin-2.png`).status, "failed");
  assert.equal(art(goblin), PNG);
});

/** A goblin actor already moved to the copies, the way the optimizer leaves it. */
function movedGoblin() {
  const goblin = wild("Goblin", WEBP, { flags: { "optimal-foundry": { tokenPattern: PNG } } });
  actors().push(goblin);
  values.library = {};
  for (const n of [1, 2]) {
    const original = `${T}/goblin-${n}.png`;
    values.library[original] = converted(original);
    browser.files.set(original, 100);
    browser.files.set(copyOf(original), 10);
  }
  library.indexLibrary();
  return goblin;
}

test("token art: undoing one file puts the original pattern back, once", { skip }, async () => {
  const goblin = movedGoblin();
  const operations = [];
  onUpdate = op => operations.push(op);
  assert.deepEqual(await backfill.undo([`${T}/goblin-1.png`]), { reverted: 1, kept: 0, updated: 1, failed: 0 });
  assert.equal(art(goblin), PNG);
  assert.equal(patternFlag(goblin), undefined, "the flag goes with it");
  assert.equal(operations.length, 1);
  assert.equal(operations[0]["optimal-foundry"].rewrite, true);
  await backfill.scan();
});

test("token art: undoing every file is still one update of the actor", { skip }, async () => {
  const goblin = movedGoblin();
  const operations = [];
  onUpdate = op => operations.push(op);
  assert.equal((await backfill.undo()).reverted, 2);
  assert.deepEqual([art(goblin), patternFlag(goblin), operations.length], [PNG, undefined, 1]);
  await backfill.scan();
});

test("token art: undo keeps the copies' pattern when a file of it was emptied by the cleanup", { skip }, async () => {
  const goblin = movedGoblin();
  values.library[`${T}/goblin-2.png`].cleaned = 1;
  browser.files.set(`${T}/goblin-2.png`, 0);
  library.indexLibrary();
  assert.equal((await backfill.undo()).reverted, 1);
  assert.deepEqual([art(goblin), patternFlag(goblin)], [WEBP, PNG], "the old pattern would hand tokens an empty file");
  await backfill.scan();
});

test("token art: self-repair puts the pattern back when a copy is cut short, unless an original is gone too", { skip }, async () => {
  const goblin = movedGoblin();
  const E = "worlds/w1/elves";
  const elves = wild("Elf", `${E}/elf-*.webp`, { flags: { "optimal-foundry": { tokenPattern: `${E}/elf-*.png` } } });
  actors().push(elves);
  values.library[`${E}/elf-1.png`] = converted(`${E}/elf-1.png`);
  library.indexLibrary();
  browser.files.set(copyOf(`${E}/elf-1.png`), 4);   // cut short, and its original is gone
  browser.files.set(copyOf(`${T}/goblin-1.png`), 4); // cut short, the original is there

  await backfill.scan();
  assert.deepEqual([art(goblin), patternFlag(goblin)], [PNG, undefined]);
  assert.deepEqual([art(elves), patternFlag(elves)], [`${E}/elf-*.webp`, `${E}/elf-*.png`], "nothing to go back to");
  assert.equal(library.getEntry(`${T}/goblin-1.png`), null, "forgotten, so it converts again");
  assert.ok(browser.notices.some(n => n.text === "OPTIMALFOUNDRY.Library.Repaired"), "the repair is reported");
});

/* -------------------------------------------- */
/*  A replaced original in review mode          */
/* -------------------------------------------- */

test("review: a converted original replaced by a new file is offered again, unless a conversion recorded that file", { skip }, async () => {
  // art/a.png was converted when it was 100 bytes; someone put a 300-byte picture under that name.
  values.library = { "art/a.png": converted("art/a.png") };
  library.indexLibrary();
  browser.files.set("art/a.png", 300);
  browser.files.set(copyOf("art/a.png"), 10);
  await backfill.scan();
  assert.equal(await backfill.start(), true);
  await until(() => reviewPaths().includes("art/a.png"));
  await until(() => !backfill.backfillStatus().running);
  assert.deepEqual(reviewPaths(), ["art/a.png", "art/b.jpg"], "listed like a new file");
  assert.equal(backfill.reviewList().find(i => i.original === "art/a.png").refs.length, 1);

  // A player's request converted that very file meanwhile: the entry now describes it.
  await library.putEntries({ original: "art/a.png", source: 'W/"12c-1"', originalBytes: 300 }, { now: true });
  assert.deepEqual(reviewPaths(), ["art/b.jpg"]);
  await backfill.scan();
});
