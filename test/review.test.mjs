import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Review mode of the background optimization: the scan holds back conversions the GM has not approved, approving
 * saves the approval before anything converts, declining records "leave as it is", and nothing starts on its own
 * before the welcome screen. Documents use the real v14 schemas (set FOUNDRY_APP when Foundry is installed elsewhere).
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";

let backfill, library;
let values;
const defaults = () => ({
  library: {}, mediaEnabled: true, backfillMode: "review", backfillPaused: false, reviewApproved: [], welcomeDone: true,
  includeCompendia: false, nextScenes: [], preloadInclude: [], preloadExclude: [], scanReport: {}, protectActiveScene: true,
  prototypeTokenOverrides: { base: {} }, networkProfile: "auto", cdnStatus: {}, hostUploadMbps: 20, idleSeconds: 5,
  preloadMaxFileMB: 100, p2pEnabled: true, maxConcurrentRequests: 150, preloadSharePct: 60, staggerJoin: true
});

before(async () => {
  const common = await import(`${APP}/common/server.mjs`);
  globalThis.foundry = { ...common, utils: { ...common.utils, getRoute: p => `/${p}` } };
  globalThis.CONST = foundry.CONST;
  globalThis.CONFIG = { Token: {} };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  globalThis.game = {
    world: { id: "w1" },
    user: { isGM: true, isActiveGM: true },
    users: Object.assign([], { activeGM: null }),
    model: { Actor: { base: {} }, Item: { base: {} } },
    release: { version: "14.370" },
    system: { id: "test", grid: { type: 1, distance: 5, units: "ft" }, documentTypes: {} },
    modules: new Map(),
    packs: [],
    ...Object.fromEntries(["scenes", "playlists", "actors", "journal", "folders"].map(k => [k, Object.assign([], { get: () => null })])),
    i18n: { lang: "en", format: k => k, localize: k => k },
    settings: {
      get: (_ns, key) => structuredClone(values[key]),
      async set(_ns, key, value) { values[key] = structuredClone(value); return value; }
    }
  };
  Object.defineProperty(foundry.abstract.Document.prototype, "uuid", {
    configurable: true,
    get() { return `${this.documentName}.${this.id}`; }
  });
  library = await import("../scripts/library.mjs");
  backfill = await import("../scripts/media/backfill.mjs");
});

beforeEach(async () => {
  await library.flushLibrary();
  values = defaults();
  library.forgetApproved();
  const id = () => foundry.utils.randomID();
  const actor = (name, img) => new foundry.documents.BaseActor({ _id: id(), name, type: "base", img });
  game.collections = [Object.assign([actor("A", "art/a.png"), actor("B", "art/b.jpg"), actor("C", "art/c.webp")],
    { documentName: "Actor" })];
});

const reviewPaths = () => backfill.reviewList().map(i => i.original).sort();

test("review: the scan holds back unapproved conversions; auto queues them; off keeps nothing", async () => {
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

test("review: approving saves the approval first and queues the files; declining records them as skipped", async () => {
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

test("review: nothing converts on its own before the welcome screen", () => {
  values.welcomeDone = false;
  values.backfillMode = "auto";
  assert.equal(library.willConvert("art/a.png"), false);
  assert.equal(backfill.backfillStatus().waitingWelcome, true);
  values.welcomeDone = true;
  assert.equal(library.willConvert("art/a.png"), true);
  values.backfillPaused = true;
  assert.equal(library.willConvert("art/a.png"), false, "paused");
});

test("review: before the welcome screen, Start refuses and an approval is only saved", async () => {
  values.welcomeDone = false;
  await backfill.scan();
  assert.equal(await backfill.start(), false);
  assert.equal(await backfill.approve(["art/a.png"]), 1);
  assert.deepEqual(values.reviewApproved, ["art/a.png"], "kept for when the welcome screen is done");
  assert.equal(backfill.backfillStatus().running, false, "nothing converts yet");
});

test("review: declining never overwrites a file converted meanwhile; a persisted pause shows as paused", async () => {
  await backfill.scan();
  await library.putEntries({ original: "art/b.jpg", kind: "image", status: "done", optimized: "art/b.of-12345678.webp" }, { now: true });
  assert.equal(await backfill.decline(["art/b.jpg"]), 0);
  assert.equal(library.getEntry("art/b.jpg").status, "done");
  assert.deepEqual(reviewPaths(), ["art/a.png"], "the converted one left the list");
  values.backfillPaused = true;
  assert.equal(backfill.backfillStatus().paused, true);
});
