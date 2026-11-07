import { test } from "node:test";
import assert from "node:assert/strict";
import { extOf, isOptimizedPath } from "../scripts/constants.mjs";
import { normalizePath, putEntries, removeEntries, flushLibrary, getEntry, getLibrary } from "../scripts/library.mjs";
import { baseName, dirName, sanitizeStem, optimizedName, outputLocation } from "../scripts/media/naming.mjs";

test("extOf ignores query and hash and lowercases", () => {
  assert.equal(extOf("maps/Taverna.PNG"), "png");
  assert.equal(extOf("a/b.c/file.webm?x=1#t"), "webm");
  assert.equal(extOf("no-extension"), "");
});

test("isOptimizedPath matches only the .of-<8 hex>.<ext> marker", () => {
  assert.equal(isOptimizedPath("maps/taverna.of-3fa9c21b.webp"), true);
  assert.equal(isOptimizedPath("maps/taverna.of-3fa9c21b.webp?v=2"), true);
  assert.equal(isOptimizedPath("maps/taverna.of-3fa9c2.webp"), false);
  assert.equal(isOptimizedPath("maps/taverna.of-zzzzzzzz.webp"), false);
  assert.equal(isOptimizedPath("maps/taverna.webp"), false);
});

test("normalizePath strips leading slashes, query, hash and decodes", () => {
  assert.equal(normalizePath("/worlds/w/Mapa%20Antigo.png?123#x"), "worlds/w/Mapa Antigo.png");
  assert.equal(normalizePath("  //a/b.png "), "a/b.png");
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath(null), "");
  assert.equal(normalizePath("bad%E0%A4%A.png"), "bad%E0%A4%A.png");
});

test("normalizePath strips the route prefix", () => {
  globalThis.ROUTE_PREFIX = "/rpg/";
  try {
    assert.equal(normalizePath("/rpg/worlds/w/a.png"), "worlds/w/a.png");
    assert.equal(normalizePath("worlds/rpg/a.png"), "worlds/rpg/a.png");
  } finally { delete globalThis.ROUTE_PREFIX; }
});

test("normalizePath keeps other origins as full URLs", () => {
  assert.equal(normalizePath("https://cdn.example.com/x/a.png"), "https://cdn.example.com/x/a.png");
});

test("baseName and dirName", () => {
  assert.equal(baseName("a/b/c.png?x"), "c.png");
  assert.equal(baseName("c.png"), "c.png");
  assert.equal(dirName("a/b/c.png"), "a/b");
  assert.equal(dirName("c.png"), "");
});

test("sanitizeStem strips diacritics, spaces and old markers", () => {
  assert.equal(sanitizeStem("Mapa da Floresta Sombria.png"), "Mapa-da-Floresta-Sombria");
  assert.equal(sanitizeStem("Coração Ação!.jpg"), "Coracao-Acao");
  assert.equal(sanitizeStem("dir/taverna.of-3fa9c21b.webp"), "taverna");
  assert.equal(sanitizeStem("???.png"), "media");
});

test("optimizedName uses the first 8 hex of the hash", () => {
  assert.equal(optimizedName("Taverna Á.png", "3FA9C21BDEADBEEF", "webp"), "Taverna-A.of-3fa9c21b.webp");
  assert.equal(isOptimizedPath(optimizedName("x.wav", "0123456789abcdef", "ogg")), true);
});

test("outputLocation mirrors read-only and core folders", () => {
  assert.deepEqual(outputLocation("worlds/w/maps/a.png"), { source: "data", dir: "worlds/w/maps", mirrored: false });
  assert.deepEqual(outputLocation("modules/pack/art/a.png"), { source: "data", dir: "optimal-foundry/modules/pack/art", mirrored: true });
  assert.deepEqual(outputLocation("systems/dnd5e/icons/a.png"), { source: "data", dir: "optimal-foundry/systems/dnd5e/icons", mirrored: true });
  assert.deepEqual(outputLocation("icons/svg/a.png"), { source: "data", dir: "optimal-foundry/icons/svg", mirrored: true });
  assert.equal(outputLocation("https://cdn.example.com/x/a.png").dir, "optimal-foundry/cdn.example.com/x");
});

/* ------------------------------- library write chain (stubbed Foundry) ------------------------------- */

function stubFoundry() {
  const store = { value: {}, writes: 0, inflight: 0, maxInflight: 0 };
  globalThis.foundry = { utils: { deepClone: v => structuredClone(v) } };
  globalThis.Hooks = { callAll() {}, on() {} };
  globalThis.game = {
    user: { isGM: true },
    settings: {
      get: () => store.value,
      async set(_ns, _key, value) {
        store.inflight++; store.maxInflight = Math.max(store.maxInflight, store.inflight);
        await new Promise(r => setTimeout(r, 5));
        store.value = structuredClone(value); store.writes++; store.inflight--;
        return value;
      }
    }
  };
  return store;
}

test("library: writes are serialized and partial entries merge", async () => {
  const store = stubFoundry();
  const a = putEntries({ original: "/a.png", status: "done", optimized: "a.of-00000000.webp" }, { now: true });
  const b = putEntries({ original: "b.png", status: "skipped", reason: "noSavings" }, { now: true });
  assert.equal(getEntry("a.png")?.status, "done", "pending write visible in the merged view");
  await Promise.all([a, b]);
  assert.equal(store.maxInflight, 1);
  assert.deepEqual(Object.keys(store.value).sort(), ["a.png", "b.png"]);
  await putEntries({ original: "a.png", rewritten: true }, { now: true });
  assert.equal(store.value["a.png"].optimized, "a.of-00000000.webp");
  assert.equal(store.value["a.png"].rewritten, true);
});

test("library: removeEntries drops queued writes and is not undone by a later flush", async () => {
  const store = stubFoundry();
  store.value = { "c.png": { original: "c.png", status: "done" } };
  putEntries({ original: "c.png", rewritten: true }).catch(() => {}); // queued in the window, never flushed
  const removed = removeEntries(["c.png"]);
  assert.equal(getEntry("c.png"), null);
  await removed;
  await flushLibrary();
  assert.equal(store.value["c.png"], undefined);
  assert.deepEqual(getLibrary(), {});
});

test("library: batched window flushes once, flushLibrary forces it", async () => {
  const store = stubFoundry();
  const p1 = putEntries({ original: "d.png", status: "failed", attempts: 1 });
  const p2 = putEntries({ original: "e.png", status: "failed", attempts: 1 });
  assert.equal(store.writes, 0);
  await flushLibrary();
  await Promise.all([p1, p2]);
  assert.equal(store.writes, 1);
  assert.deepEqual(Object.keys(store.value).sort(), ["d.png", "e.png"]);
});

test("videoBitrate: anchored at 1080p30, sublinear above it, capped by the source", async () => {
  const { videoBitrate, VIDEO_BITRATE_MAX, ANIMATION_BITRATE_MIN } = await import("../scripts/media/formats.mjs");
  const hd = videoBitrate(1920, 1080, 30, "medium");
  assert.equal(hd, Math.round(0.06 * 1920 * 1080 * 30));
  const uhd60 = videoBitrate(3840, 2160, 60, "medium");
  assert.ok(uhd60 > hd && uhd60 < VIDEO_BITRATE_MAX, `4K60 medium = ${uhd60}`);
  assert.ok(videoBitrate(1280, 720, 30, "medium") > 0.06 * 1280 * 720 * 30, "720p keeps more bits per pixel");
  assert.equal(videoBitrate(1920, 1080, 30, "medium", undefined, 2_000_000), 1_400_000);
  assert.equal(videoBitrate(64, 64, 10, "low", ANIMATION_BITRATE_MIN), ANIMATION_BITRATE_MIN);
});
