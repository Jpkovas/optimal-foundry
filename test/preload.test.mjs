import { test, before } from "node:test";
import assert from "node:assert/strict";

/**
 * The automatic preload plan (buildQueue) on a small fake world: no scene marked, yet everything players may need
 * is queued, most likely first, with the reason for each scene or group.
 */
let buildQueue, warm, preloadStatus;
const settings = { nextScenes: [], preloadInclude: [], preloadExclude: [], mediaEnabled: false, backfillMode: "off", library: {} };

const coll = (list, extra = {}) => Object.assign(list, { get: id => list.find(d => d.id === id) ?? null, contents: list }, extra);
let n = 0;
function scene(name, { navigation = false, navOrder = 0, folder = null, sort = 0, playlist = null, active = false, regions = [], modified = 0 } = {}) {
  const id = `s${++n}`;
  return {
    id, name, uuid: `Scene.${id}`, navigation, navOrder, folder, sort, playlist, playlistSound: null, active, regions,
    _stats: { modifiedTime: modified },
    levels: new Set([{ background: { src: `maps/${name}.webp` } }]),
    tiles: [], tokens: [{ texture: { src: `tokens/${name}-goblin.webp` } }], notes: [], drawings: [], walls: [],
    sounds: [{ path: `sfx/${name}.ogg`, hidden: false }]
  };
}
function playlist(name, tracks, { playing = false } = {}) {
  const sounds = tracks.map((t, i) => ({ id: `${name}${i}`, path: `music/${t}.ogg` }));
  const map = new Map(sounds.map(s => [s.id, s]));
  return { id: `p-${name}`, name, uuid: `Playlist.p-${name}`, playing, playbackOrder: sounds.map(s => s.id), sounds: map };
}

before(async () => {
  globalThis.foundry = { utils: { deepClone: v => structuredClone(v) } };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  globalThis.CONST = {};
  const tavern = playlist("tavern", ["t1", "t2", "t3"]);
  const battle = playlist("battle", ["b1", "b2"], { playing: true });
  const ambient = playlist("ambient", ["a1"]);
  const secret = playlist("secret", ["x1"]);
  const forest = scene("forest", { navigation: true, navOrder: 2, playlist: tavern });
  const town = scene("town", { navigation: true, navOrder: 1, active: true, playlist: ambient,
    regions: [{ behaviors: [{ type: "teleportToken", disabled: false, system: { destinations: new Set(["Scene.s4.Region.r1", ".Region.local"]) } }] }] });
  const cave = scene("cave", { navigation: true, navOrder: 3 });
  const dungeon = scene("dungeon"); // s4: teleport target, not in the navigation bar
  const castle = scene("castle", { navigation: true, navOrder: 9 });
  const prep = scene("prep");
  const viewed = scene("viewed");
  const old = scene("old", { modified: 1 });
  const hidden = scene("hidden", { modified: 2 });
  hidden.uuid = "Scene.hidden";
  const scenes = coll([forest, town, cave, dungeon, castle, prep, viewed, old, hidden]);
  scenes.active = town;
  const players = [{ id: "u1", isGM: false, active: true, viewedScene: viewed.id }, { id: "gm", isGM: true, active: true }];
  settings.preloadExclude = ["Scene.hidden", "Playlist.p-secret"];
  globalThis.canvas = { scene: prep };
  globalThis.game = {
    world: { id: "w" },
    user: { isGM: true },
    i18n: { lang: "en" },
    scenes,
    playlists: coll([tavern, battle, ambient, secret]),
    users: coll(players),
    actors: coll([
      { id: "a1", img: "art/hero.webp", prototypeToken: { texture: { src: "tokens/hero.webp" } }, testUserPermission: u => u.id === "u1" },
      { id: "a2", img: "art/npc.webp", prototypeToken: { texture: { src: "tokens/npc.webp" } }, testUserPermission: () => false }
    ]),
    journal: coll([]),
    settings: { get: (_ns, key) => settings[key] }
  };
  ({ buildQueue, warm, preloadStatus } = await import("../scripts/net/preload.mjs"));
});

test("preload: the automatic plan covers the world, most likely first, with no scene marked", () => {
  const { items, plan } = buildQueue();
  const tierOf = src => items.find(i => i.src === src)?.tier;
  const why = name => plan.filter(p => p.name === name).map(p => `${p.tier}:${p.reason}`);

  // 0 "now": the GM's prep scene and the scene a player is viewing.
  assert.deepEqual(why("prep"), ["0:gmViewing"]);
  assert.deepEqual(why("viewed"), ["0:playerViewing"]);
  // 1 "probably next": the active scene's playlist, what is playing, navigation neighbours, teleport destinations.
  assert.deepEqual(why("ambient"), ["1:active"]);
  assert.deepEqual(why("battle"), ["1:playing"]);
  assert.deepEqual(why("forest"), ["1:navigation"]);
  assert.deepEqual(why("cave"), ["1:navigation"]);
  assert.deepEqual(why("dungeon"), ["1:teleport"]);
  assert.equal(tierOf("sfx/town.ogg"), 1, "the active scene's ambient sounds");
  // 2 "this session": the rest of the navigation bar, playlists linked to scenes above, player characters.
  assert.deepEqual(why("castle"), ["2:navigationBar"]);
  assert.equal(tierOf("music/t1.ogg"), 1, "a scene's first track comes with the scene");
  assert.equal(tierOf("music/t2.ogg"), 2, "the rest of its playlist one tier later");
  assert.equal(tierOf("art/hero.webp"), 2);
  assert.equal(tierOf("tokens/hero.webp"), 2);
  assert.equal(tierOf("art/npc.webp"), undefined, "actors no player owns are not character art");
  // 3 "later": every other scene; the exclude list is respected.
  assert.deepEqual(why("old"), ["3:rest"]);
  assert.equal(why("hidden").length, 0);
  assert.equal(tierOf("maps/hidden.webp"), undefined);
  assert.equal(tierOf("music/x1.ogg"), undefined);

  // Queue order follows the tiers, and nothing is queued twice.
  const tiers = items.map(i => i.tier);
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  assert.equal(new Set(items.map(i => i.src)).size, items.length);
});

test("preload: the rank orders the backfill by the documents' own paths", () => {
  const { items, rank } = buildQueue();
  assert.equal(rank.get("maps/prep.webp"), 0, "tier 0 first");
  assert.ok(rank.get("maps/forest.webp") < rank.get("maps/castle.webp"), "probably next before this session");
  assert.ok(rank.get("maps/castle.webp") < rank.get("maps/old.webp"), "this session before later");
  assert.equal(rank.has("maps/hidden.webp"), false, "excluded scenes are not ranked");
  assert.ok(rank.size >= items.length);
});

test("preload: a marked scene goes first, even when excluded", () => {
  settings.nextScenes = [game.scenes.find(s => s.name === "hidden").id];
  const { items, plan } = buildQueue();
  assert.deepEqual(plan[0], { ...plan[0], name: "hidden", tier: 0, reason: "marked" });
  assert.equal(items[0].src, "maps/hidden.webp");
  settings.nextScenes = [];
});

/** One fake answer for the next fetch; records what was asked. */
function answer(status, headers = {}, bytes = 0) {
  const seen = {};
  globalThis.fetch = async (url, init) => {
    Object.assign(seen, { url, init });
    return new Response(status === 200 ? new Uint8Array(bytes) : null, { status, headers });
  };
  return seen;
}
const URL_A = "https://play.example.com/maps/a.of-0123abcd.webp";

test("preload: a warm-up request is marked for the Service Worker and asks for low priority", async () => {
  const seen = answer(200, {}, 10);
  await warm(URL_A);
  assert.equal(seen.url, URL_A);
  assert.equal(seen.init.headers["X-Optimal-Foundry-Preload"], "1");
  assert.equal(seen.init.priority, "low");
});

test("preload: only what the host uploaded is reported", async () => {
  const bytes = async headers => { answer(200, headers, 1234); return (await warm(URL_A)).bytes; };
  // The Service Worker names where its answer came from.
  assert.equal(await bytes({ "X-Optimal-Foundry-Source": "cache" }), 0);
  assert.equal(await bytes({ "X-Optimal-Foundry-Source": "p2p" }), 0);
  assert.equal(await bytes({ "X-Optimal-Foundry-Source": "net" }), 1234);
  // Behind a CDN, an edge that already held the file spared the host too.
  assert.equal(await bytes({ "X-Optimal-Foundry-Source": "net", "cf-cache-status": "HIT" }), 0);
  assert.equal(await bytes({ "cf-cache-status": "HIT" }), 0);
  assert.equal(await bytes({ "cf-cache-status": "MISS" }), 1234, "an edge miss is an upload from the host");
  assert.equal(await bytes({}), 1234, "no worker, no CDN: the network moved it");
});

test("preload: progress says how far the download is and whether the host is paying", async () => {
  answer(200, { "content-length": "1234", "X-Optimal-Foundry-Source": "p2p" }, 1234);
  const progress = { total: 0, received: 0 };
  assert.deepEqual(await warm(URL_A, undefined, 5000, progress), { ok: true, bytes: 0 });
  assert.deepEqual(progress, { total: 1234, received: 1234, offHost: true });
});

test("preload: files over the limit, missing files and overload", async () => {
  answer(200, { "content-length": "5000" }, 5000);
  assert.deepEqual(await warm(URL_A, undefined, 1000), { ok: false, bytes: 0, reason: "tooLarge" });
  answer(200, {}, 5000); // no declared length: found out while reading
  assert.deepEqual(await warm(URL_A, undefined, 1000), { ok: false, bytes: 5000, reason: "tooLarge" });
  answer(404);
  assert.deepEqual(await warm(URL_A), { ok: false, bytes: 0, reason: "HTTP 404" });
  answer(503);
  await assert.rejects(warm(URL_A), /HTTP 503/, "transient: reported as an error, offered again later");
});

test("preload: this browser's preloadScope turns its preloading off", () => {
  settings.preloadEnabled = true;
  for (const [scope, enabled] of [["all", true], ["session", true], ["off", false]]) {
    settings.preloadScope = scope;
    assert.equal(preloadStatus().enabled, enabled, scope);
  }
  settings.preloadEnabled = false;
  settings.preloadScope = "all";
  assert.equal(preloadStatus().enabled, false, "the world's switch still wins");
});
