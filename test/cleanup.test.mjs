import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

/**
 * The in-browser cleanup (empty originals by overwriting them with 0-byte uploads) against an in-memory server that
 * follows Foundry v14's rules: express.static ETags `W/"<size hex>-<mtime hex>"`, and upload overwrites an existing
 * file only when the extension is an uploadable media type. Documents use the real v14 schemas (set FOUNDRY_APP when
 * Foundry is installed elsewhere).
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";

let cleanup, library, backfill;
const files = new Map(); // Data-relative decoded path -> {data: Buffer, mtime: number}
let uploads = [];
let actors, macros, settings;
let store = {};
let server = {}; // per-test behaviour: {rejectUpload, headFailsAfterUpload, onUpload}

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const etag = f => `W/"${f.data.length.toString(16)}-${f.mtime.toString(16)}"`;
let clock = 1_700_000_000_000;
const put = (path, content) => { files.set(path, { data: Buffer.from(content), mtime: clock++ }); return files.get(path); };
const collection = (documentName, list = []) => Object.assign(list, { documentName });

before(async () => {
  const common = await import(`${APP}/common/server.mjs`);
  globalThis.foundry = {
    ...common,
    utils: { ...common.utils, getRoute: p => `/${p}` },
    applications: { apps: { FilePicker: { implementation: { upload: fakeUpload } } } }
  };
  globalThis.CONST = foundry.CONST;
  globalThis.CONFIG = { Token: {} };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  globalThis.game = {
    world: { id: "w1" },
    user: { isGM: true, isActiveGM: true },
    users: { activeGM: null },
    model: { Actor: { base: {} }, Item: { base: {} } },
    release: { version: "14.370" },
    system: { id: "test", grid: { type: 1, distance: 5, units: "ft" }, documentTypes: {} },
    modules: new Map(),
    packs: [],
    settings: {
      get: (ns, key) => (key === "prototypeTokenOverrides" ? { base: {} } : store),
      async set(_ns, _key, value) { store = structuredClone(value); return value; }
    }
  };
  Object.defineProperty(foundry.abstract.Document.prototype, "uuid", {
    configurable: true,
    get() { return `${this.documentName}.${this.id}`; }
  });
  globalThis.fetch = fakeFetch;
  cleanup = await import("../scripts/media/cleanup.mjs");
  library = await import("../scripts/library.mjs");
  backfill = await import("../scripts/media/backfill.mjs");
});

beforeEach(async () => {
  await library.flushLibrary();
  files.clear();
  store = {};
  uploads = [];
  server = {};
  actors = collection("Actor");
  macros = collection("Macro");
  settings = collection("Setting");
  game.collections = [actors, macros, settings];
});

async function fakeFetch(url, { method = "GET" } = {}) {
  const path = decodeURIComponent(String(url).replace(/^\//, ""));
  if (method === "HEAD" && server.headFailsAfterUpload && uploads.some(f => path.endsWith(f.name))) {
    throw new TypeError("network error");
  }
  const f = files.get(path);
  if (!f) return new Response(null, { status: 404 });
  const headers = { etag: etag(f), "content-length": String(f.data.length) };
  return new Response(method === "HEAD" ? null : f.data, { status: 200, headers });
}

/** Foundry's Files.upload + LocalFileStorage.upload, reduced to the rules that matter here. */
async function fakeUpload(source, target, file) {
  uploads.push(file);
  const path = `${decodeURIComponent(target)}/${file.name}`;
  await server.onUpload?.(path);
  if (server.rejectUpload) return false; // FilePicker.upload returns false after showing response.error
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const media = CONST.MEDIA_MIME_TYPES.includes(CONST.UPLOADABLE_FILE_EXTENSIONS[ext]);
  if (source !== "data" || !CONST.UPLOADABLE_FILE_EXTENSIONS[ext]) return false;
  if (files.has(path) && !media) return false;
  files.set(path, { data: Buffer.from(await file.arrayBuffer()), mtime: clock++ });
  return { status: "success", path: path.split("/").map(encodeURIComponent).join("/") };
}

/** A converted original plus its optimized copy, recorded in the library like the backfill does. */
function converted(original, { tamper = false, source = true } = {}) {
  const o = put(original, "RAW".repeat(400) + original);
  const optimized = original.replace(/\.\w+$/, ".of-12345678.webp");
  const content = "WEBP-" + original;
  const opt = put(optimized, content);
  const entry = {
    original, optimized, kind: "image", status: "done", sha256: sha(opt.data), bytes: opt.data.length,
    originalBytes: o.data.length, ...(source ? { source: etag(o) } : {})
  };
  if (tamper) opt.data = Buffer.from(content.replace(/./, "X")); // same size, other bytes
  store[original] = entry;
  return entry;
}

const actor = img => new foundry.documents.BaseActor({ _id: foundry.utils.randomID(), name: "A", type: "base", img });
/** The usage search reads only `_source`. */
const macro = command => ({ _source: { _id: foundry.utils.randomID(), name: "M", type: "script", command } });

test("cleanup: analysis offers only world originals nothing mentions, and records ones already empty", async () => {
  converted("worlds/w1/maps/Mapa Grande.png");
  converted("worlds/w1/maps/changed.png");
  converted("worlds/w1/maps/tampered.png", { tamper: true });
  converted("worlds/w1/maps/later-used.png");
  converted("worlds/w1/maps/no-source.png", { source: false });
  converted("worlds/w1/tokens/in-use.png");
  converted("worlds/w1/sfx/Boom Alto.ogg");
  converted("worlds/w1/sfx/Música.mp3");
  converted("shared/outside.png");
  converted("worlds/w1/odd#name.png");
  converted("worlds/w1/../w2/maps/other-world.png");
  converted("worlds/w1/clips/old.mov");
  const empty = converted("worlds/w1/maps/already-empty.png");
  files.get(empty.original).data = Buffer.alloc(0);
  actors.push(actor("worlds/w1/tokens/in-use.png"));
  // A macro mentions one sound only in its code, encoded; a module setting mentions the other in another case/form.
  macros.push(macro("foundry.audio.AudioHelper.play({src: 'worlds/w1/sfx/Boom%20Alto.ogg'})"));
  settings.push({ key: "other-module.music", _source: { key: "other-module.music", value: '"WORLDS/W1/SFX/MÚSICA.MP3"' } });
  // The module's own library mentions every original and is ignored.
  settings.push({ key: "optimal-foundry.library", _source: { key: "optimal-foundry.library", value: JSON.stringify(store) } });

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(r.candidates.map(c => c.original).sort(), [
    "worlds/w1/maps/Mapa Grande.png", "worlds/w1/maps/changed.png", "worlds/w1/maps/later-used.png",
    "worlds/w1/maps/no-source.png", "worlds/w1/maps/tampered.png"
  ]);
  assert.equal(r.inUse, 3, "a document, a macro's code and another module's setting all count");
  assert.equal(r.outsideWorld, 4, "shared folder, '#', '..' and a non-overwritable .mov are never offered");
  assert.equal(r.gone, 1);
  await library.flushLibrary();
  assert.ok(store["worlds/w1/maps/already-empty.png"].cleaned, "an original already at 0 bytes is marked cleaned");
  assert.equal(uploads.length, 0, "analysis never uploads");

  // After the analysis: one original changes on disk, another becomes referenced again.
  put("worlds/w1/maps/changed.png", "edited");
  actors.push(actor("worlds/w1/maps/later-used.png"));
  // Every upload finds its original already marked: a crash mid-upload never leaves an unmarked empty file.
  const markedAtUpload = [];
  server.onUpload = path => { markedAtUpload.push(!!library.getLibrary()[path]?.cleaned); };

  const progress = [];
  const out = await cleanup.emptyOriginals([...r.candidates, { original: "shared/outside.png" }], {
    onProgress: (done, total) => progress.push(`${done}/${total}`)
  });
  const kept = Object.fromEntries(out.kept.map(k => [k.original, k.reason]));
  assert.deepEqual(out.emptied.sort(), ["worlds/w1/maps/Mapa Grande.png", "worlds/w1/maps/no-source.png"]);
  assert.equal(kept["worlds/w1/maps/changed.png"], "changed");
  assert.equal(kept["worlds/w1/maps/tampered.png"], "copyHash");
  assert.equal(kept["worlds/w1/maps/later-used.png"], "inUse");
  assert.equal(kept["shared/outside.png"], "notEligible");
  assert.equal(progress.at(-1), "6/6");
  assert.deepEqual(markedAtUpload, [true, true]);

  // Emptied: same name, 0 bytes; the optimized copy and every kept original are untouched.
  assert.equal(files.get("worlds/w1/maps/Mapa Grande.png").data.length, 0);
  assert.ok(files.get("worlds/w1/maps/Mapa Grande.of-12345678.webp").data.length > 0);
  for (const p of ["worlds/w1/maps/tampered.png", "worlds/w1/maps/later-used.png", "shared/outside.png"]) {
    assert.ok(files.get(p).data.length > 0, `${p} kept its content`);
  }
  assert.equal(out.freedBytes, ["worlds/w1/maps/Mapa Grande.png", "worlds/w1/maps/no-source.png"]
    .reduce((s, p) => s + store[p].originalBytes, 0));
  assert.ok(uploads.every(f => f.size === 0), "only empty files are ever uploaded");

  await library.flushLibrary();
  const entry = store["worlds/w1/maps/Mapa Grande.png"];
  assert.equal(entry.status, "done", "the entry stays done, so later references are still re-pointed");
  assert.ok(entry.cleaned);
  assert.ok(!store["worlds/w1/maps/tampered.png"].cleaned);

  const again = await cleanup.emptyOriginals([{ original: "worlds/w1/maps/Mapa Grande.png" }]);
  assert.deepEqual(again.kept, [{ original: "worlds/w1/maps/Mapa Grande.png", reason: "notEligible" }]);
});

test("cleanup: a refused upload clears the mark; an unreadable result stays marked", async () => {
  converted("worlds/w1/a.png");
  server.rejectUpload = true;
  let out = await cleanup.emptyOriginals([{ original: "worlds/w1/a.png" }]);
  assert.deepEqual(out.kept, [{ original: "worlds/w1/a.png", reason: "uploadFailed" }]);
  await library.flushLibrary();
  assert.ok(!store["worlds/w1/a.png"].cleaned, "the file still has its content: offered again later");
  assert.ok(files.get("worlds/w1/a.png").data.length > 0);

  converted("worlds/w1/b.png");
  server = { headFailsAfterUpload: true };
  out = await cleanup.emptyOriginals([{ original: "worlds/w1/b.png" }]);
  assert.deepEqual(out.kept, [{ original: "worlds/w1/b.png", reason: "uncertain" }]);
  await library.flushLibrary();
  assert.ok(store["worlds/w1/b.png"].cleaned, "may be empty: undo must never point documents at it");
});

test("cleanup and undo never run at the same time", async () => {
  converted("worlds/w1/c.png");
  let undoDuring;
  server.onUpload = async () => { undoDuring = await backfill.undo(["worlds/w1/c.png"]); };
  const out = await cleanup.emptyOriginals([{ original: "worlds/w1/c.png" }]);
  assert.deepEqual(out.emptied, ["worlds/w1/c.png"]);
  assert.equal(undoDuring, null, "undo refuses while the cleanup runs");
});
