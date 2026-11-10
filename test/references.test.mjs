import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

/**
 * The reference walker against the real v14 schemas (Foundry's common/ code), with a thin `game` stub and an
 * in-memory database backend that applies each request with the real `updateSource`.
 * Set FOUNDRY_APP to the app's Resources/app folder when Foundry is installed elsewhere; without Foundry (CI) every
 * test here is skipped.
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";
const skip = existsSync(`${APP}/common/server.mjs`) ? false : `Foundry is not installed at ${APP} (set FOUNDRY_APP)`;

let refsLib;
const docs = {};
const byUuid = new Map();
/** One entry per database request: {type, parent, pack, ids, updates, operation}. */
const requests = [];
/** Per-test behaviour of the fake database: `reject(operation)` makes a request fail before anything is stored. */
let db = {};
/** What the fake file picker answers to a wildcard browse: pattern -> files, or "error". */
let listing = {};

/** What ClientDatabaseBackend#_updateDocuments does, without the socket: store every update of the request. */
async function fakeUpdate(cls, operation) {
  const { parent, pack, updates } = operation;
  requests.push({ type: cls.documentName, parent: parent?.uuid ?? null, pack: pack ?? null, ids: updates.map(u => u._id),
    updates, operation });
  if (db.reject?.(operation)) throw new Error("rejected before the request left");
  for (const update of updates) {
    const doc = parent ? parent.getEmbeddedCollection(cls.documentName).get(update._id)
      : byUuid.get(`${cls.documentName}.${update._id}`);
    doc.updateSource(update); // validated by the real schema
  }
  return [];
}

function register(...list) {
  for (const d of list) {
    byUuid.set(d.uuid, d);
    for (const name of Object.keys(d.constructor.hierarchy ?? {})) {
      const children = d[name];
      if (children?.[Symbol.iterator]) register(...children);
    }
  }
}

const requestsFor = doc => requests.filter(r => r.ids.includes(doc.id));

before(async () => {
  if (skip) return;
  const common = await import(`${APP}/common/server.mjs`);
  // Module namespaces are frozen; fromUuid (client-only) is added on a copy.
  globalThis.foundry = { ...common, utils: { ...common.utils, fromUuid: async uuid => byUuid.get(uuid) ?? null },
    applications: { apps: { FilePicker: { implementation: { async browse(_source, target, options) {
      assert.equal(options.wildcard, true);
      if (listing[target] === "error") throw new Error("no such folder");
      return { files: listing[target] ?? [] };
    } } } } } };
  globalThis.CONST = foundry.CONST;
  globalThis.CONFIG = { Token: {}, DatabaseBackend: { update: fakeUpdate } };
  globalThis.game = {
    model: { Actor: { base: {} }, Item: { base: {} }, JournalEntryPage: { image: {}, text: {}, video: {}, pdf: {} } },
    release: { version: "14.370" },
    system: { id: "test", grid: { type: 1, distance: 5, units: "ft" }, documentTypes: {} },
    modules: new Map(),
    user: null
  };
  // Client-side Document#uuid, enough for world and embedded documents.
  Object.defineProperty(foundry.abstract.Document.prototype, "uuid", {
    configurable: true,
    get() { return this.parent ? `${this.parent.uuid}.${this.documentName}.${this.id}` : `${this.documentName}.${this.id}`; }
  });

  const D = foundry.documents;
  const id = () => foundry.utils.randomID();
  docs.scene = new D.BaseScene({
    _id: id(), name: "Scene",
    levels: [{ _id: id(), name: "Ground", background: { src: "maps/ground.png" } }],
    tokens: [{ _id: id(), name: "Goblin", texture: { src: "tokens/goblin.png" } }],
    tiles: [{ _id: id(), width: 100, height: 100, texture: { src: "tiles/door.jpg" } }],
    sounds: [{ _id: id(), path: "sfx/rain.wav", radius: 10 }],
    notes: [{ _id: id(), texture: { src: "icons/pin.svg" } }]
  });
  docs.actor = new D.BaseActor({
    _id: id(), name: "Hero", type: "base", img: "art/hero.png",
    prototypeToken: { texture: { src: "art/hero-token.png" } },
    flags: { other: { portrait: "art/flag.jpg", note: "not a path" } }
  });
  docs.journal = new D.BaseJournalEntry({
    _id: id(), name: "Journal",
    pages: [
      { _id: id(), name: "Picture", type: "image", src: "art/page.png" },
      { _id: id(), name: "Text", type: "text",
        text: { content: '<p><img src="art/one.png"><img src="/art/two%20x.jpg"><a href="https://x.test/a.png">x</a><img src="//cdn.test/b.png"></p>' } },
      { _id: id(), name: "Markdown", type: "text",
        text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN, markdown: "![map](art/md.png) and [clip](art/clip.webm)",
          content: '<p><img src="art/md.png"> <a href="art/clip.webm">clip</a></p>' } }
    ]
  });
  docs.playlist = new D.BasePlaylist({ _id: id(), name: "Music", sounds: [{ _id: id(), name: "Theme", path: "music/theme.mp3" }] });

  // For the grouped updates: items that share an icon inside two actors, and actors that share a portrait.
  const items = (n, img) => Array.from({ length: n }, (_, i) => ({ _id: id(), name: `Item ${i}`, type: "base", img }));
  docs.fighter = new D.BaseActor({ _id: id(), name: "Fighter", type: "base", img: "art/shared.png", items: items(3, "icons/sword.png") });
  docs.rogue = new D.BaseActor({ _id: id(), name: "Rogue", type: "base", img: "art/shared.png", items: items(2, "icons/sword.png") });
  docs.hoarder = new D.BaseActor({ _id: id(), name: "Hoarder", type: "base", img: "art/hoarder.webp", items: items(205, "icons/coin.png") });
  docs.plain = new D.BaseActor({
    _id: id(), name: "Plain strings", type: "base", img: "art/plain.webp",
    flags: { other: { text: "Rolled a 7. Next!", query: "art/q.png?v=2", encodedDot: "art/dot%2Ejpg", notMedia: "notes/readme.txt?img=a.png" } }
  });
  // Token art: a pattern, a pattern the token does not use (no random image), and a random image that names one file.
  const token = (name, randomImg, src) => new D.BaseActor({ _id: id(), name, type: "base", prototypeToken: { randomImg, texture: { src } } });
  docs.wolf = token("Wolf", true, "art/tokens/wolf-*.png");
  docs.starred = token("Starred", false, "art/tokens/star-*.png");
  docs.solo = token("Solo", true, "art/tokens/solo.png");
  docs.adventure = new D.BaseAdventure({
    _id: id(), name: "Adventure", actors: [{ _id: id(), name: "Villain", type: "base", img: "adv/villain.png" }]
  });

  const collection = (name, ...list) => Object.assign(list, { documentName: name });
  game.collections = [
    collection("Scene", docs.scene),
    collection("Actor", docs.actor, docs.fighter, docs.rogue, docs.hoarder, docs.plain, docs.wolf, docs.starred, docs.solo),
    collection("JournalEntry", docs.journal), collection("Playlist", docs.playlist),
    collection("ChatMessage", { uuid: "ChatMessage.x", _source: { content: '<img src="chat/never.png">' } })
  ];
  game.packs = [];
  register(docs.scene, docs.actor, docs.fighter, docs.rogue, docs.hoarder, docs.plain, docs.wolf, docs.starred, docs.solo,
    docs.journal, docs.playlist, docs.adventure);
  refsLib = await import("../scripts/media/references.mjs");
});

beforeEach(() => {
  requests.length = 0;
  db = {};
  listing = {};
});

const kinds = (map, path) => (map.get(path) ?? []).map(r => r.kind).sort();

test("collectReferences finds media in typed fields, HTML, Markdown and flags", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  const tok = refs.get("tokens/goblin.png");
  assert.equal(tok?.length, 1);
  assert.equal(tok[0].kind, "texture");
  assert.equal(tok[0].fieldPath, "texture.src");
  assert.equal(tok[0].uuid, docs.scene.tokens.contents[0].uuid);
  assert.deepEqual(kinds(refs, "tiles/door.jpg"), ["texture"]);
  assert.equal(refs.get("maps/ground.png")?.[0]?.docName, "Level");
  assert.deepEqual(kinds(refs, "sfx/rain.wav"), ["audio"]);
  assert.deepEqual(kinds(refs, "art/hero.png"), ["image"]);
  assert.deepEqual(kinds(refs, "art/hero-token.png"), ["texture"]);
  assert.deepEqual(kinds(refs, "art/flag.jpg"), ["string"]);
  assert.deepEqual(kinds(refs, "art/page.png"), ["image"]);
  assert.deepEqual(kinds(refs, "art/one.png"), ["html"]);
  assert.deepEqual(kinds(refs, "art/two x.jpg"), ["html"]);
  assert.deepEqual(kinds(refs, "art/md.png"), ["html", "markdown"]);
  assert.deepEqual(kinds(refs, "art/clip.webm"), ["html", "markdown"]);
  assert.deepEqual(kinds(refs, "music/theme.mp3"), ["audio"]);
  assert.equal(refs.has("icons/pin.svg"), false, "svg is not media");
  assert.equal(refs.has("chat/never.png"), false, "chat messages are not scanned");
  assert.equal([...refs.keys()].some(k => k.startsWith("https://")), false, "other origins are ignored");
});

test("collectReferences rejects non-media strings early without losing queries or encoded names", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  assert.deepEqual(kinds(refs, "art/q.png"), ["string"], "a query after the extension is still a file");
  assert.deepEqual(kinds(refs, "art/dot.jpg"), ["string"], "a percent-encoded value is normalized before it is judged");
  assert.equal(refs.has("notes/readme.txt"), false, "an extension inside the query does not make a file");
  assert.equal([...refs.keys()].some(k => k.includes("Rolled")), false);
});

test("collectReferences reports the media it cannot read: other hosts and SVG", { skip }, async () => {
  const unread = { external: new Set(), vector: new Set() };
  const refs = await refsLib.collectReferences({ unread });
  assert.deepEqual([...unread.external].sort(), ["//cdn.test/b.png", "https://x.test/a.png"]);
  assert.equal(refs.has("cdn.test/b.png"), false, "a protocol-relative URL is not a local path");
  // The note's icon, and the default prototype token of the actors that set none.
  assert.deepEqual([...unread.vector].sort(), ["icons/pin.svg", "icons/svg/mystery-man.svg"]);
});

test("collectDocumentReferences walks children only when asked", { skip }, () => {
  const without = refsLib.collectDocumentReferences(docs.scene, { children: false });
  assert.equal(without.has("tokens/goblin.png"), false);
  const withChildren = refsLib.collectDocumentReferences(docs.scene, { children: true });
  assert.equal(withChildren.has("tokens/goblin.png"), true);
  assert.equal(withChildren.has("maps/ground.png"), true);
});

test("pacer yields by elapsed time and stops on abort", { skip }, async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let yielded = false;
  setTimeout(() => { yielded = true; }, 0);

  const pace = refsLib.pacer();
  for (let i = 0; i < 1000; i++) await pace();
  assert.equal(yielded, false, "a thousand items inside one slice of work do not yield once");
  now = 13;
  await pace();
  assert.equal(yielded, true, "after a slice of work the browser gets its turn");
  await pace();

  const controller = new AbortController();
  const aborted = refsLib.pacer(controller.signal);
  await aborted();
  controller.abort();
  await aborted();
  now = 26;
  await assert.rejects(aborted(), "the abort is honoured at the next yield");
});

test("rewriteReferences updates a document once for several originals and verifies it", { skip }, async () => {
  const page = docs.journal.pages.contents[1];
  const refs = await refsLib.collectReferences();
  const map = new Map([["art/one.png", "art/one.of-11111111.webp"], ["art/two x.jpg", "art/two-x.of-22222222.webp"]]);
  const res = await refsLib.rewriteReferences(map, { refs });
  assert.equal(requestsFor(page).length, 1, "one update for the page");
  assert.equal(res.updated, 2);
  assert.equal(res.failed, 0);
  const html = page._source.text.content;
  assert.match(html, /src="art\/one\.of-11111111\.webp"/);
  assert.match(html, /src="\/art\/two-x\.of-22222222\.webp"/, "keeps the leading slash");
});

test("rewriteReferences rewrites Markdown and the HTML rendered from it", { skip }, async () => {
  const page = docs.journal.pages.contents[2];
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["art/md.png", "art/md.of-33333333.webp"]]), { refs });
  assert.equal(requestsFor(page).length, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.updated, 2);
  assert.equal(page._source.text.markdown, "![map](art/md.of-33333333.webp) and [clip](art/clip.webm)");
  assert.match(page._source.text.content, /src="art\/md\.of-33333333\.webp"/);
});

test("rewriteReferences defers protected refs and rewrites typed fields", { skip }, async () => {
  const token = docs.scene.tokens.contents[0];
  const actor = docs.actor;
  const refs = await refsLib.collectReferences();
  const map = new Map([["tokens/goblin.png", "tokens/goblin.of-44444444.webp"], ["art/hero.png", "art/hero.of-55555555.webp"]]);
  const res = await refsLib.rewriteReferences(map, { refs, protect: ref => ref.uuid.startsWith(docs.scene.uuid) });
  assert.equal(requestsFor(token).length, 0, "the protected scene is untouched");
  assert.equal(res.deferred.length, 1);
  assert.equal(res.deferred[0].from, "tokens/goblin.png");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].updates, [{ _id: actor.id, img: "art/hero.of-55555555.webp" }]);
  assert.equal(requests[0].operation["optimal-foundry"].rewrite, true, "the document hooks can tell a rewrite apart");
  assert.equal(actor._source.img, "art/hero.of-55555555.webp");
  assert.equal(res.updated, 1);
});

test("rewriteReferences refuses an extension the field does not accept", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["music/theme.mp3", "music/theme.of-66666666.webp"]]), { refs });
  assert.equal(requests.length, 0);
  assert.equal(res.skipped, 1);
});

test("rewriteReferences sends one request per parent and type, and one per top-level type", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  const map = new Map([["icons/sword.png", "icons/sword.of-77777777.webp"], ["art/shared.png", "art/shared.of-88888888.webp"]]);
  const res = await refsLib.rewriteReferences(map, { refs });
  assert.equal(res.updated, 7, "five items and two portraits");
  assert.equal(res.failed, 0);
  assert.equal(requests.length, 3, "the fighter's items, the rogue's items, and both actors together");
  const of = (type, parent) => requests.find(r => r.type === type && r.parent === parent);
  assert.deepEqual(of("Item", docs.fighter.uuid).ids.sort(), docs.fighter.items.map(i => i.id).sort());
  assert.deepEqual(of("Item", docs.rogue.uuid).ids.sort(), docs.rogue.items.map(i => i.id).sort());
  assert.deepEqual(of("Actor", null).ids.sort(), [docs.fighter.id, docs.rogue.id].sort());
  assert.ok(requests.every(r => r.operation["optimal-foundry"].rewrite === true));
  for (const item of [...docs.fighter.items, ...docs.rogue.items]) assert.equal(item._source.img, "icons/sword.of-77777777.webp");
  assert.equal(docs.rogue._source.img, "art/shared.of-88888888.webp");
});

test("rewriteReferences cuts a very large group into several requests", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["icons/coin.png", "icons/coin.of-99999999.webp"]]), { refs });
  assert.equal(res.updated, 205);
  assert.deepEqual(requests.map(r => r.ids.length), [200, 5]);
});

test("rewriteReferences lets one bad document fail alone when its group is rejected", { skip }, async () => {
  const [bad, ...good] = docs.fighter.items.contents;
  db.reject = operation => operation.updates.some(u => u._id === bad.id);
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["icons/sword.of-77777777.webp", "icons/sword.of-aaaaaaaa.webp"]]), { refs });
  assert.equal(res.updated, 4, "the fighter's two other items and the rogue's two");
  assert.equal(res.failed, 1);
  assert.deepEqual(res.failedFrom, ["icons/sword.of-77777777.webp"]);
  assert.equal(bad._source.img, "icons/sword.of-77777777.webp");
  for (const item of good) assert.equal(item._source.img, "icons/sword.of-aaaaaaaa.webp");
  assert.equal(requestsFor(bad).length, 2, "the group, then the document on its own");
  for (const item of good) assert.equal(requestsFor(item).length, 2);
});

test("an Adventure is neither scanned nor rewritten", { skip }, async () => {
  assert.equal(refsLib.collectDocumentReferences(docs.adventure).size, 0);
  const ref = { uuid: docs.adventure.uuid, docName: "Adventure", fieldPath: "actors.0.img", updatePath: "actors", kind: "image" };
  const res = await refsLib.rewriteReferences(new Map([["adv/villain.png", "adv/villain.of-bbbbbbbb.webp"]]), { refs: [ref] });
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
  assert.equal(requests.length, 0);
  assert.equal(docs.adventure._source.actors[0].img, "adv/villain.png");
});

const PATTERN = "art/tokens/wolf-*.png";

test("wildcard token art: only a random-image token with a `*` is a pattern reference, listed under the pattern", { skip }, async () => {
  const refs = await refsLib.collectReferences();
  const list = refs.get(PATTERN);
  assert.equal(list?.length, 1);
  assert.deepEqual(list[0], { uuid: docs.wolf.uuid, fieldPath: "prototypeToken.texture.src", updatePath: "prototypeToken.texture.src",
    kind: "texture", docName: "Actor", pattern: PATTERN });
  assert.equal(refsLib.isPatternKey(PATTERN), true);
  assert.equal(refs.has("art/tokens/star-*.png"), false, "without random images the field is just a path with a `*`");
  assert.deepEqual(kinds(refs, "art/tokens/solo.png"), ["texture"], "one file is an ordinary reference");
  assert.equal(refs.get("art/tokens/solo.png")[0].pattern, undefined);
  assert.equal(refsLib.collectDocumentReferences(docs.wolf).has(PATTERN), true);
});

test("expandPatterns swaps a pattern for the media files the server lists, with the references kept", { skip }, async () => {
  listing[PATTERN] = ["art/tokens/wolf-1.png", "art/tokens/Wolf%202.png", "art/tokens/wolf-3.txt", "https://x.test/wolf-4.png"];
  const refs = await refsLib.collectReferences();
  await refsLib.expandPatterns(refs);
  assert.equal(refs.has(PATTERN), false);
  for (const file of ["art/tokens/wolf-1.png", "art/tokens/Wolf 2.png"]) {
    assert.deepEqual(refs.get(file).map(r => [r.uuid, r.pattern]), [[docs.wolf.uuid, PATTERN]]);
  }
  assert.equal([...refs.keys()].some(k => /wolf-3|wolf-4/.test(k)), false, "only local media");

  // The server cannot answer: no files, and no key left that is not a file.
  listing[PATTERN] = "error";
  const failed = await refsLib.collectReferences();
  await refsLib.expandPatterns(failed);
  assert.equal([...failed.keys()].some(refsLib.isPatternKey), false);
  assert.equal(await refsLib.matchPattern(PATTERN), null, "unknown is not the same as no files");
});

test("rewriteReferences never replaces a path in a pattern reference", { skip }, async () => {
  listing[PATTERN] = ["art/tokens/wolf-1.png"];
  const refs = await refsLib.collectReferences();
  await refsLib.expandPatterns(refs);
  const res = await refsLib.rewriteReferences(new Map([["art/tokens/wolf-1.png", "art/tokens/wolf-1.of-11112222.webp"]]), { refs });
  assert.deepEqual([res.updated, res.skipped, res.failed, res.deferred.length], [0, 0, 0, 0]);
  assert.equal(requests.length, 0);
  assert.equal(docs.wolf._source.prototypeToken.texture.src, PATTERN);
});

test("setTokenPatterns moves a pattern with the old one remembered, and puts it back with the flag removed", { skip }, async () => {
  const to = "art/tokens/wolf-*.webp";
  const flag = () => docs.wolf._source.flags?.["optimal-foundry"]?.tokenPattern;
  let res = await refsLib.setTokenPatterns([{ uuid: docs.wolf.uuid, from: PATTERN, to }]);
  assert.deepEqual(res, { updated: 1, skipped: 0, failed: 0 });
  assert.deepEqual([docs.wolf._source.prototypeToken.texture.src, flag()], [to, PATTERN]);
  assert.equal(requests.length, 1, "one update");
  assert.equal(requests[0].operation["optimal-foundry"].rewrite, true);

  // Edited since the scan: left alone.
  res = await refsLib.setTokenPatterns([{ uuid: docs.wolf.uuid, from: PATTERN, to: "art/tokens/other-*.webp" }]);
  assert.deepEqual([res.updated, res.skipped], [0, 1]);
  assert.equal(requests.length, 1);

  res = await refsLib.setTokenPatterns([{ uuid: docs.wolf.uuid, from: to }]);
  assert.deepEqual(res, { updated: 1, skipped: 0, failed: 0 });
  assert.deepEqual([docs.wolf._source.prototypeToken.texture.src, flag()], [PATTERN, undefined]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].operation["optimal-foundry"].rewrite, true);

  // Nothing remembered, nothing to put back.
  res = await refsLib.setTokenPatterns([{ uuid: docs.wolf.uuid, from: PATTERN }]);
  assert.deepEqual([res.updated, res.skipped], [0, 1]);
  assert.equal(requests.length, 2);
});
