import { test, before } from "node:test";
import assert from "node:assert/strict";

/**
 * The reference walker against the real v14 schemas (Foundry's common/ code), with a thin `game` stub.
 * Set FOUNDRY_APP to the app's Resources/app folder when Foundry is installed elsewhere.
 */
const APP = process.env.FOUNDRY_APP ?? "/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app";

let refsLib;
const docs = {};
const byUuid = new Map();

before(async () => {
  const common = await import(`${APP}/common/server.mjs`);
  // Module namespaces are frozen; fromUuid (client-only) is added on a copy.
  globalThis.foundry = { ...common, utils: { ...common.utils, fromUuid: async uuid => byUuid.get(uuid) ?? null } };
  globalThis.CONST = foundry.CONST;
  globalThis.CONFIG = { Token: {} };
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

  const collection = (name, ...list) => Object.assign(list, { documentName: name });
  game.collections = [
    collection("Scene", docs.scene), collection("Actor", docs.actor),
    collection("JournalEntry", docs.journal), collection("Playlist", docs.playlist),
    collection("ChatMessage", { uuid: "ChatMessage.x", _source: { content: '<img src="chat/never.png">' } })
  ];
  game.packs = [];
  for (const d of [docs.scene, docs.actor, docs.journal, docs.playlist]) {
    byUuid.set(d.uuid, d);
    for (const name of Object.keys(d.constructor.hierarchy ?? {})) for (const child of d[name] ?? []) byUuid.set(child.uuid, child);
  }
  refsLib = await import("../scripts/media/references.mjs");
});

/** Make doc.update apply locally (validated by the real schema) and record each payload. */
function recordUpdates(doc) {
  const calls = [];
  doc.update = async changes => { calls.push(changes); doc.updateSource(changes); };
  return calls;
}

const kinds = (map, path) => (map.get(path) ?? []).map(r => r.kind).sort();

test("collectReferences finds media in typed fields, HTML, Markdown and flags", async () => {
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

test("collectReferences reports the media it cannot read: other hosts and SVG", async () => {
  const unread = { external: new Set(), vector: new Set() };
  const refs = await refsLib.collectReferences({ unread });
  assert.deepEqual([...unread.external].sort(), ["//cdn.test/b.png", "https://x.test/a.png"]);
  assert.equal(refs.has("cdn.test/b.png"), false, "a protocol-relative URL is not a local path");
  assert.deepEqual([...unread.vector], ["icons/pin.svg"]);
});

test("collectDocumentReferences walks children only when asked", () => {
  const without = refsLib.collectDocumentReferences(docs.scene, { children: false });
  assert.equal(without.has("tokens/goblin.png"), false);
  const withChildren = refsLib.collectDocumentReferences(docs.scene, { children: true });
  assert.equal(withChildren.has("tokens/goblin.png"), true);
  assert.equal(withChildren.has("maps/ground.png"), true);
});

test("rewriteReferences updates a document once for several originals and verifies it", async () => {
  const page = docs.journal.pages.contents[1];
  const calls = recordUpdates(page);
  const refs = await refsLib.collectReferences();
  const map = new Map([["art/one.png", "art/one.of-11111111.webp"], ["art/two x.jpg", "art/two-x.of-22222222.webp"]]);
  const res = await refsLib.rewriteReferences(map, { refs });
  assert.equal(calls.length, 1, "one update for the page");
  assert.equal(res.updated, 2);
  assert.equal(res.failed, 0);
  const html = page._source.text.content;
  assert.match(html, /src="art\/one\.of-11111111\.webp"/);
  assert.match(html, /src="\/art\/two-x\.of-22222222\.webp"/, "keeps the leading slash");
});

test("rewriteReferences rewrites Markdown and the HTML rendered from it", async () => {
  const page = docs.journal.pages.contents[2];
  const calls = recordUpdates(page);
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["art/md.png", "art/md.of-33333333.webp"]]), { refs });
  assert.equal(calls.length, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.updated, 2);
  assert.equal(page._source.text.markdown, "![map](art/md.of-33333333.webp) and [clip](art/clip.webm)");
  assert.match(page._source.text.content, /src="art\/md\.of-33333333\.webp"/);
});

test("rewriteReferences defers protected refs and rewrites typed fields", async () => {
  const token = docs.scene.tokens.contents[0];
  const actor = docs.actor;
  const tokenCalls = recordUpdates(token);
  const actorCalls = recordUpdates(actor);
  const refs = await refsLib.collectReferences();
  const map = new Map([["tokens/goblin.png", "tokens/goblin.of-44444444.webp"], ["art/hero.png", "art/hero.of-55555555.webp"]]);
  const res = await refsLib.rewriteReferences(map, { refs, protect: ref => ref.uuid.startsWith(docs.scene.uuid) });
  assert.equal(tokenCalls.length, 0, "the protected scene is untouched");
  assert.equal(res.deferred.length, 1);
  assert.equal(res.deferred[0].from, "tokens/goblin.png");
  assert.equal(actorCalls.length, 1);
  assert.deepEqual(actorCalls[0], { img: "art/hero.of-55555555.webp" });
  assert.equal(actor._source.img, "art/hero.of-55555555.webp");
  assert.equal(res.updated, 1);
});

test("rewriteReferences refuses an extension the field does not accept", async () => {
  const sound = docs.playlist.sounds.contents[0];
  const calls = recordUpdates(sound);
  const refs = await refsLib.collectReferences();
  const res = await refsLib.rewriteReferences(new Map([["music/theme.mp3", "music/theme.of-66666666.webp"]]), { refs });
  assert.equal(calls.length, 0);
  assert.equal(res.skipped, 1);
});
