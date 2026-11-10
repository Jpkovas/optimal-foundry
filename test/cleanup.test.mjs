import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * The in-browser cleanup (empty originals by overwriting them with 0-byte uploads) against an in-memory server that
 * follows Foundry v14's rules: express.static ETags `W/"<size hex>-<mtime hex>"`, and upload overwrites an existing
 * file only when the extension is an uploadable media type. Documents use the real v14 schemas (set FOUNDRY_APP when
 * Foundry is installed elsewhere; without Foundry, as in CI, every test here is skipped).
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";
const skip = existsSync(`${APP}/common/server.mjs`) ? false : `Foundry is not installed at ${APP} (set FOUNDRY_APP)`;

let cleanup, library, backfill;
const files = new Map(); // Data-relative decoded path -> {data: Buffer, mtime: number}
let uploads = [];
let packReads = []; // compendium ids, one per download
let actors, macros, settings;
let store = {};
let server = {}; // per-test behaviour: {rejectUpload, headFailsAfterUpload, onUpload, onHead}

const hooks = new Map();
const socketHandlers = new Map();

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const etag = f => `W/"${f.data.length.toString(16)}-${f.mtime.toString(16)}"`;
let clock = 1_700_000_000_000;
const put = (path, content) => { files.set(path, { data: Buffer.from(content), mtime: clock++ }); return files.get(path); };
const collection = (documentName, list = []) => Object.assign(list, { documentName });
/** A compendium as the client sees it; `stored` is what the server answers a "get" with. */
const pack = (id, packageType, stored = [], extra = {}) => ({
  collection: id, documentName: "Actor", metadata: { packageType }, folders: [], stored, ...extra
});

before(async () => {
  if (skip) return;
  const common = await import(`${APP}/common/server.mjs`);
  globalThis.foundry = {
    ...common,
    utils: { ...common.utils, getRoute: p => `/${p}` },
    applications: { apps: { FilePicker: { implementation: { upload: fakeUpload } } } },
    helpers: { SocketInterface: { dispatch: fakeDispatch } }
  };
  globalThis.CONST = foundry.CONST;
  globalThis.CONFIG = { Token: {} };
  globalThis.Hooks = {
    on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    once() {},
    callAll(name, ...args) { for (const fn of hooks.get(name) ?? []) fn(...args); }
  };
  globalThis.game = {
    world: { id: "w1" },
    user: { isGM: true, isActiveGM: true },
    users: { activeGM: null },
    model: { Actor: { base: {} }, Item: { base: {} } },
    release: { version: "14.370" },
    system: { id: "test", _source: { id: "test" }, grid: { type: 1, distance: 5, units: "ft" }, documentTypes: {} },
    modules: new Map(),
    packs: [],
    i18n: { format: (key, data) => `${key} ${JSON.stringify(data)}` },
    socket: { on(event, fn) { socketHandlers.set(event, fn); } },
    settings: {
      get: (ns, key) => (key === "prototypeTokenOverrides" ? { base: {} } : store),
      async set(_ns, key, value) {
        store = structuredClone(value);
        // The server broadcasts every setting write, the module's own included.
        Hooks.callAll("updateSetting", { documentName: "Setting", key: `optimal-foundry.${key}` }, {}, {}, "gm");
        return value;
      }
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
  if (skip) return;
  await library.flushLibrary();
  files.clear();
  store = {};
  uploads = [];
  packReads = [];
  server = {};
  actors = collection("Actor");
  macros = collection("Macro");
  settings = collection("Setting");
  game.collections = [actors, macros, settings];
  game.packs = [];
  game.world._source = { id: "w1", title: "World" };
  game.user.isActiveGM = true;
  // What the cleanup read for the previous test is dropped the way a lost connection drops it.
  socketHandlers.get("disconnect")?.();
});

async function fakeFetch(url, { method = "GET" } = {}) {
  const path = decodeURIComponent(String(url).replace(/^\//, ""));
  if (method === "HEAD") await server.onHead?.(path);
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

/** The server's answer to the request CompendiumCollection#getDocuments sends: the raw documents of one pack. */
async function fakeDispatch(event, request) {
  assert.equal(event, "modifyDocument");
  assert.equal(request.action, "get");
  const found = game.packs.find(p => p.collection === request.operation.pack);
  assert.equal(request.type, found.documentName);
  packReads.push(found.collection);
  if (found.broken) throw new Error("the pack is corrupt");
  return { result: structuredClone(found.stored) };
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

const actor = data => new foundry.documents.BaseActor({ _id: foundry.utils.randomID(), name: "A", type: "base", ...data });
/** The usage search reads only `_source`. */
const macro = command => ({ _source: { _id: foundry.utils.randomID(), name: "M", type: "script", command } });
/** A document arrives the way a broadcast delivers it: into the collection, then the hook. */
function create(into, doc) {
  into.push(doc);
  Hooks.callAll(`create${into.documentName}`, doc, {}, "gm");
  return doc;
}
const originals = r => r.candidates.map(c => c.original).sort();
const keptReasons = out => Object.fromEntries(out.kept.map(k => [k.original, k.reason]));

test("cleanup: analysis offers only world originals nothing mentions, and records ones already empty", { skip }, async () => {
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
  actors.push(actor({ img: "worlds/w1/tokens/in-use.png" }));
  // A macro mentions one sound only in its code, encoded; a module setting mentions the other in another case/form.
  macros.push(macro("foundry.audio.AudioHelper.play({src: 'worlds/w1/sfx/Boom%20Alto.ogg'})"));
  settings.push({ key: "other-module.music", _source: { key: "other-module.music", value: '"WORLDS/W1/SFX/MÚSICA.MP3"' } });
  // The module's own library mentions every original and is ignored.
  settings.push({ key: "optimal-foundry.library", _source: { key: "optimal-foundry.library", value: JSON.stringify(store) } });

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(originals(r), [
    "worlds/w1/maps/Mapa Grande.png", "worlds/w1/maps/changed.png", "worlds/w1/maps/later-used.png",
    "worlds/w1/maps/tampered.png"
  ]);
  assert.equal(r.inUse, 3, "a document, a macro's code and another module's setting all count");
  assert.equal(r.outsideWorld, 5,
    "shared folder, '#', '..', a non-overwritable .mov and an entry without a fingerprint are never offered");
  assert.equal(r.gone, 1);
  assert.equal(r.missing, 0);
  await library.flushLibrary();
  assert.ok(store["worlds/w1/maps/already-empty.png"].cleaned, "an original already at 0 bytes is marked cleaned");
  assert.equal(uploads.length, 0, "analysis never uploads");

  // After the analysis: one original changes on disk, another becomes referenced again.
  put("worlds/w1/maps/changed.png", "edited");
  create(actors, actor({ img: "worlds/w1/maps/later-used.png" }));
  // Every upload finds its original already marked: a crash mid-upload never leaves an unmarked empty file.
  const markedAtUpload = [];
  server.onUpload = path => { markedAtUpload.push(!!library.getLibrary()[path]?.cleaned); };

  const progress = [];
  const asked = [...r.candidates, { original: "shared/outside.png" }, { original: "worlds/w1/maps/no-source.png" }];
  const out = await cleanup.emptyOriginals(asked, { onProgress: (done, total) => progress.push(`${done}/${total}`) });
  const kept = keptReasons(out);
  assert.deepEqual(out.emptied, ["worlds/w1/maps/Mapa Grande.png"]);
  assert.equal(kept["worlds/w1/maps/changed.png"], "changed");
  assert.equal(kept["worlds/w1/maps/tampered.png"], "copyHash");
  assert.equal(kept["worlds/w1/maps/later-used.png"], "inUse");
  assert.equal(kept["shared/outside.png"], "notEligible");
  assert.equal(kept["worlds/w1/maps/no-source.png"], "notEligible",
    "an entry that carries no fingerprint of the original is never emptied, even when asked for by name");
  assert.equal(progress.at(-1), "6/6");
  assert.deepEqual(markedAtUpload, [true]);

  // Emptied: same name, 0 bytes; the optimized copy and every kept original are untouched.
  assert.equal(files.get("worlds/w1/maps/Mapa Grande.png").data.length, 0);
  assert.ok(files.get("worlds/w1/maps/Mapa Grande.of-12345678.webp").data.length > 0);
  for (const p of ["worlds/w1/maps/tampered.png", "worlds/w1/maps/later-used.png", "shared/outside.png",
    "worlds/w1/maps/no-source.png"]) {
    assert.ok(files.get(p).data.length > 0, `${p} kept its content`);
  }
  assert.equal(out.freedBytes, store["worlds/w1/maps/Mapa Grande.png"].originalBytes);
  assert.ok(uploads.every(f => f.size === 0), "only empty files are ever uploaded");

  await library.flushLibrary();
  const entry = store["worlds/w1/maps/Mapa Grande.png"];
  assert.equal(entry.status, "done", "the entry stays done, so later references are still re-pointed");
  assert.ok(entry.cleaned);
  assert.ok(!store["worlds/w1/maps/tampered.png"].cleaned);
  assert.ok(!store["worlds/w1/maps/no-source.png"].cleaned);

  const again = await cleanup.emptyOriginals([{ original: "worlds/w1/maps/Mapa Grande.png" }]);
  assert.deepEqual(again.kept, [{ original: "worlds/w1/maps/Mapa Grande.png", reason: "notEligible" }]);
});

test("cleanup: a file named only by the world's manifest is in use", { skip }, async () => {
  converted("worlds/w1/ui/join.png");
  converted("worlds/w1/ui/Desc Art.png");
  converted("worlds/w1/ui/banner.png");
  converted("worlds/w1/ui/free.png");
  // The join screen: none of this is a document.
  game.world._source = {
    id: "w1", title: "World", background: "worlds/w1/ui/join.png",
    description: '<p><img src="worlds/w1/ui/Desc%20Art.png"></p>',
    packs: [{ name: "heroes", banner: "/worlds/w1/ui/banner.png" }]
  };

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(originals(r), ["worlds/w1/ui/free.png"]);
  assert.equal(r.inUse, 3);

  const out = await cleanup.emptyOriginals([{ original: "worlds/w1/ui/join.png" }, { original: "worlds/w1/ui/free.png" }]);
  assert.deepEqual(out.emptied, ["worlds/w1/ui/free.png"]);
  assert.deepEqual(out.kept, [{ original: "worlds/w1/ui/join.png", reason: "inUse" }]);
  assert.ok(files.get("worlds/w1/ui/join.png").data.length > 0);
});

test("cleanup: a file that a wildcard pattern can pick is in use", { skip }, async () => {
  // Token art `goblin-*.png`: placed tokens were re-pointed, so no document names goblin-1.png any more.
  converted("worlds/w1/tokens/goblin-1.png");
  converted("worlds/w1/tokens/Goblin-2.PNG");
  converted("worlds/w1/tokens/goblin-old.jpg");
  converted("worlds/w1/tokens/orc.png");
  actors.push(actor({ prototypeToken: { randomImg: true, texture: { src: "worlds/w1/tokens/goblin-*.png" } } }));
  // A random-image token whose pattern has no "*", written percent-encoded.
  converted("worlds/w1/My Tokens/elf-1.png");
  converted("worlds/w1/My Tokens/elf-queen.jpg");
  actors.push(actor({ prototypeToken: { randomImg: true, texture: { src: "worlds/w1/My%20Tokens/elf-?.png" } } }));
  // Encoded only in part: neither the plain nor the encoded spelling of the file lines up with it, the decoded
  // pattern does.
  converted("worlds/w1/My Tokens/dark elf-1.png");
  actors.push(actor({ flags: { variants: { art: "worlds/w1/My%20Tokens/dark elf-*.png" } } }));
  // Syntax the matcher does not evaluate: everything in that folder is kept, the folder below it is not.
  converted("worlds/w1/bandits/b1.png");
  converted("worlds/w1/bandits/other.jpg");
  converted("worlds/w1/bandits/sub/deep.png");
  actors.push(actor({ flags: { variants: { art: "/worlds/w1/bandits/{a,b}*.png" } } }));
  // A pattern inside a macro's code, next to a "*" and a folder that are not patterns.
  converted("worlds/w1/npcs/guard-3.png");
  converted("worlds/w1/npcs/guard.png");
  converted("worlds/w1/other/goblin-1.png");
  macros.push(macro("const img = pick('worlds/w1/npcs/guard-*.png'); const n = 2 * 3; const dir = \"worlds/w1/other/\";"));
  // A wildcard in a folder name, inside another module's setting: everything below the literal part is kept.
  converted("worlds/w1/sets/red/token.png");
  settings.push({ key: "other-module.sets", _source: { key: "other-module.sets", value: JSON.stringify({ art: "worlds/w1/sets/*/token.png" }) } });

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(originals(r), [
    "worlds/w1/My Tokens/elf-queen.jpg", "worlds/w1/bandits/sub/deep.png", "worlds/w1/npcs/guard.png",
    "worlds/w1/other/goblin-1.png", "worlds/w1/tokens/goblin-old.jpg", "worlds/w1/tokens/orc.png"
  ]);
  assert.equal(r.inUse, 8);

  const out = await cleanup.emptyOriginals([{ original: "worlds/w1/tokens/goblin-1.png" }, { original: "worlds/w1/tokens/orc.png" }]);
  assert.deepEqual(out.emptied, ["worlds/w1/tokens/orc.png"]);
  assert.deepEqual(out.kept, [{ original: "worlds/w1/tokens/goblin-1.png", reason: "inUse" }]);
  assert.ok(files.get("worlds/w1/tokens/goblin-1.png").data.length > 0, "the next goblin still gets a picture");
});

test("cleanup: originals behind wildcard token art are offered once the pattern points at the copies", { skip }, async () => {
  const goblins = ["worlds/w1/tokens/goblin-1.png", "worlds/w1/tokens/goblin-2.png"];
  for (const original of goblins) converted(original);
  const hero = actor({ prototypeToken: { randomImg: true, texture: { src: "worlds/w1/tokens/goblin-*.png" } } });
  actors.push(hero);

  let r = await cleanup.findCleanupCandidates();
  assert.deepEqual([originals(r), r.inUse], [[], 2], "the pattern still picks them");

  // What the optimizer does once every file is converted: the new pattern, and the old one kept in a flag.
  hero.updateSource({ prototypeToken: { texture: { src: "worlds/w1/tokens/goblin-*.webp" } },
    flags: { "optimal-foundry": { tokenPattern: "worlds/w1/tokens/goblin-*.png" } } });
  Hooks.callAll("updateActor", hero, {}, {}, "gm");
  r = await cleanup.findCleanupCandidates();
  assert.deepEqual([originals(r), r.inUse], [goblins, 0], "nothing picks them any more; the remembered pattern does not count");
});

test("cleanup: every compendium is searched, and one that cannot be read stops everything", { skip }, async () => {
  converted("worlds/w1/art/own.png");
  converted("worlds/w1/art/dragon.png");
  converted("worlds/w1/art/lich.png");
  converted("worlds/w1/art/folder.png");
  converted("worlds/w1/art/free.png");
  game.packs = [
    pack("world.heroes", "world", [{ _id: "a", name: "Own", img: "worlds/w1/art/own.png" }]),
    // The game master's own shared-compendium module points at this world's art.
    pack("shared-art.monsters", "module", [{ _id: "b", name: "Dragon", items: [{ _id: "i", img: "worlds/w1/art/dragon.png" }] }]),
    pack("test.bestiary", "system", [{ _id: "c", name: "Lich", prototypeToken: { texture: { src: "worlds/w1/art/lich.png" } } }],
      { folders: [{ _source: { _id: "f", name: "Undead", flags: { x: { banner: "worlds/w1/art/folder.png" } } } }] })
  ];

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(originals(r), ["worlds/w1/art/free.png"]);
  assert.equal(r.inUse, 4);
  assert.deepEqual(packReads, ["world.heroes", "shared-art.monsters", "test.bestiary"]);

  // A compendium that cannot be read may be the one that uses the file: nothing is offered and nothing is emptied.
  game.packs.push(pack("broken.pack", "module", [], { broken: true }));
  await assert.rejects(cleanup.findCleanupCandidates(), /Cleanup\.Error\.Compendium.*broken\.pack/);
  await assert.rejects(cleanup.emptyOriginals(r.candidates), /Cleanup\.Error\.Compendium.*broken\.pack/);
  assert.equal(uploads.length, 0);
  assert.ok(files.get("worlds/w1/art/free.png").data.length > 0);

  // The failed run released its lock, and the compendiums already read were not downloaded again.
  game.packs.pop();
  packReads = [];
  const out = await cleanup.emptyOriginals(r.candidates);
  assert.deepEqual(out.emptied, ["worlds/w1/art/free.png"]);
  assert.deepEqual(packReads, []);
});

test("cleanup: the world is read once, and again only where a document changed", { skip }, async () => {
  const names = Array.from({ length: 25 }, (_, i) => `worlds/w1/bulk/f${String(i).padStart(2, "0")}.png`);
  for (const name of names) converted(name);
  game.packs = [pack("world.a", "world"), pack("shared.b", "module")];
  let worldReads = 0;
  const lists = game.collections;
  game.collections = { [Symbol.iterator]() { worldReads++; return lists[Symbol.iterator](); } };

  const r = await cleanup.findCleanupCandidates();
  assert.equal(r.candidates.length, 25);
  assert.deepEqual(packReads, ["world.a", "shared.b"]);
  assert.equal(worldReads, 1);

  // While the first group of ten is being emptied, a module compendium entry and a world macro start to use two
  // files of the last group.
  let changed = false;
  server.onUpload = () => {
    if (changed) return;
    changed = true;
    game.packs[1].stored.push({ _id: "x", name: "New", img: "worlds/w1/bulk/f24.png" });
    Hooks.callAll("createActor", { documentName: "Actor", pack: "shared.b" }, {}, "gm");
    create(macros, macro("show('worlds/w1/bulk/f23.png')"));
  };
  const out = await cleanup.emptyOriginals(names.map(original => ({ original })));
  assert.equal(out.emptied.length, 23);
  assert.deepEqual(keptReasons(out), { "worlds/w1/bulk/f23.png": "inUse", "worlds/w1/bulk/f24.png": "inUse" });
  assert.ok(files.get("worlds/w1/bulk/f24.png").data.length > 0);
  // Three groups, six library writes of the module's own setting: one more read of what changed, nothing else.
  assert.deepEqual(packReads, ["world.a", "shared.b", "shared.b"]);
  assert.equal(worldReads, 2);
});

test("cleanup: an original that is not on the server is left alone and never recorded as emptied", { skip }, async () => {
  const away = converted("worlds/w1/maps/unmounted.png");
  files.delete(away.original); // the folder was renamed, or its drive is not mounted right now
  converted("worlds/w1/maps/here.png");

  const r = await cleanup.findCleanupCandidates();
  assert.deepEqual(originals(r), ["worlds/w1/maps/here.png"]);
  assert.equal(r.missing, 1);
  assert.equal(r.gone, 0);
  await library.flushLibrary();
  assert.ok(!store[away.original].cleaned, "a 404 is not proof that the file was emptied");

  const out = await cleanup.emptyOriginals([{ original: away.original }]);
  assert.deepEqual(out.kept, [{ original: away.original, reason: "missing" }]);
  assert.equal(uploads.length, 0);
  await library.flushLibrary();
  assert.ok(!store[away.original].cleaned, "undo and a later cleanup still see the entry as it was");
});

test("cleanup: a session that stops being the coordinator stops emptying", { skip }, async () => {
  const names = Array.from({ length: 12 }, (_, i) => `worlds/w1/co/f${String(i).padStart(2, "0")}.png`);
  for (const name of names) converted(name);
  const list = names.map(original => ({ original }));

  // A co-GM logs in while the first group of ten is being emptied.
  const heads = [];
  server.onHead = path => { heads.push(path); };
  server.onUpload = () => { game.user.isActiveGM = false; };
  let out = await cleanup.emptyOriginals(list);
  assert.deepEqual(out.emptied.sort(), names.slice(0, 10), "the group already recorded as emptied is finished");
  assert.deepEqual(out.kept, names.slice(10).map(original => ({ original, reason: "notCoordinator" })));
  assert.equal(uploads.length, 10);
  assert.ok(!heads.some(path => names.slice(10).includes(path)), "the next group is not even checked");
  await library.flushLibrary();
  for (const name of names.slice(10)) {
    assert.ok(files.get(name).data.length > 0);
    assert.ok(!store[name].cleaned);
  }

  // The session that lost the role cannot start a run or an analysis.
  await assert.rejects(cleanup.emptyOriginals(list), /Cleanup\.Error\.NotCoordinator/);
  await assert.rejects(cleanup.findCleanupCandidates(), /Cleanup\.Error\.NotCoordinator/);

  // The role is lost while a group is still being checked: nothing of that group is written.
  game.user.isActiveGM = true;
  server = { onHead: () => { game.user.isActiveGM = false; } };
  uploads = [];
  out = await cleanup.emptyOriginals(list.slice(10));
  assert.deepEqual(out.emptied, []);
  assert.deepEqual(out.kept.map(k => k.reason), ["notCoordinator", "notCoordinator"]);
  assert.equal(uploads.length, 0);
  await library.flushLibrary();
  for (const name of names.slice(10)) assert.ok(!store[name].cleaned);
});

test("cleanup: a refused upload clears the mark; an unreadable result stays marked", { skip }, async () => {
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

test("cleanup and undo never run at the same time", { skip }, async () => {
  converted("worlds/w1/c.png");
  let undoDuring;
  server.onUpload = async () => { undoDuring = await backfill.undo(["worlds/w1/c.png"]); };
  const out = await cleanup.emptyOriginals([{ original: "worlds/w1/c.png" }]);
  assert.deepEqual(out.emptied, ["worlds/w1/c.png"]);
  assert.equal(undoDuring, null, "undo refuses while the cleanup runs");

  // The other way round: while an undo (or another cleanup) holds the section, a cleanup does not start.
  converted("worlds/w1/d.png");
  assert.equal(backfill.beginCleanup(), true);
  try {
    await assert.rejects(cleanup.emptyOriginals([{ original: "worlds/w1/d.png" }]), /Cleanup\.Error\.UndoRunning/);
  }
  finally { backfill.endCleanup(); }
  assert.ok(files.get("worlds/w1/d.png").data.length > 0);
});

test("cleanup: every message it can show exists in both languages", () => {
  const reasons = ["notEligible", "inUse", "missing", "error", "unknownSize", "gone", "changed", "noHash", "copyMissing",
    "copySize", "copyHash", "uploadFailed", "uncertain", "notCoordinator"];
  for (const lang of ["en", "pt-BR"]) {
    const text = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), "utf8")).OPTIMALFOUNDRY.Cleanup;
    for (const key of ["UndoRunning", "NotCoordinator", "Compendium"]) assert.ok(text.Error?.[key], `${lang}: Cleanup.Error.${key}`);
    for (const reason of reasons) assert.ok(text.Reason?.[reason], `${lang}: Cleanup.Reason.${reason}`);
    assert.ok(text.Missing, `${lang}: Cleanup.Missing`);
    assert.match(text.Error.Compendium, /\{pack\}/);
  }
});
