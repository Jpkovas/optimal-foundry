import { test, before } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, ORIGIN, bytes, tick, until, fileResponse, slowFile } from "./cache-fakes.mjs";

/**
 * The automatic preload plan (buildQueue) on a small fake world: no scene marked, yet everything players may need
 * is queued, most likely first, with the reason for each scene or group. Then the warm-up of one file, first with
 * the local cache off (a plain fetch), then through the local cache in a stubbed browser: what each answer costs
 * the host. The last tests replace Foundry's globals with the stubbed browser's, so they come last.
 */
let buildQueue, warm, preloadStatus;
const settings = { nextScenes: [], preloadInclude: [], preloadExclude: [], mediaEnabled: false, backfillMode: "off", library: {}, localCache: true, cacheQuotaMB: 4096 };

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

/** One fake answer for the next fetch (no local cache yet: a plain fetch); records what was asked. */
function answer(status, headers = {}, bytes = 0) {
  const seen = {};
  globalThis.fetch = async (url, init) => {
    Object.assign(seen, { url, init });
    return new Response(status === 200 ? new Uint8Array(bytes) : null, { status, headers });
  };
  return seen;
}
const URL_A = "https://play.example.com/maps/a.of-0123abcd.webp";

test("preload: a warm-up request asks for low priority and carries no private mark", async () => {
  const seen = answer(200, {}, 10);
  await warm(URL_A);
  assert.equal(seen.url, URL_A);
  assert.equal(seen.init.priority, "low");
  assert.equal(seen.init.headers, undefined, "nothing is added for the server to see");
});

test("preload: without the local cache only what the host uploaded is reported", async () => {
  const bytes = async headers => { answer(200, headers, 1234); return (await warm(URL_A)).bytes; };
  // Behind a CDN, an edge that already held the file spared the host.
  assert.equal(await bytes({ "cf-cache-status": "HIT" }), 0);
  assert.equal(await bytes({ "cf-cache-status": "REVALIDATED" }), 0);
  assert.equal(await bytes({ "cf-cache-status": "MISS" }), 1234, "an edge miss is an upload from the host");
  assert.equal(await bytes({}), 1234, "no CDN: the network moved it");
});

test("preload: progress says how far the download is and whether the host is paying", async () => {
  answer(200, { "content-length": "1234", "cf-cache-status": "HIT" }, 1234);
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


test("preload: through the local cache, a file it holds costs the host nothing", async () => {
  const b = installBrowser({ settings: { localCache: true, cacheQuotaMB: 4096 } });
  const cache = await import("../scripts/net/local-cache.mjs");
  cache.installLocalCache();
  cache.startLocalCache();
  await cache.readyLocalCache();
  globalThis.__browser = b;
  const path = "maps/held.of-0123abcd.webp";
  b.store(path, bytes(1234));
  const progress = { total: 0, received: 0 };
  assert.deepEqual(await warm(`${ORIGIN}/${path}`, undefined, 5000, progress), { ok: true, bytes: 0 });
  assert.equal(progress.offHost, true);
  assert.equal(b.server.calls.length, 0);
});

test("preload: through the local cache, a download costs what the server sent, unless the edge held the file", async () => {
  const b = globalThis.__browser;
  const cost = async (name, headers) => {
    b.server.handler = async () => fileResponse(bytes(1234), headers);
    const result = await warm(`${ORIGIN}/maps/${name}.of-0123abcd.webp`);
    await until(() => b.stored().includes(`${ORIGIN}/maps/${name}.of-0123abcd.webp`), `${name} stored`);
    return result.bytes;
  };
  assert.equal(await cost("net1", {}), 1234);
  assert.equal(b.server.calls.at(-1).init.priority, "low");
  assert.equal(await cost("net2", { "cf-cache-status": "MISS" }), 1234);
  assert.equal(await cost("edge", { "cf-cache-status": "HIT" }), 0, "an edge hit is refunded");
  b.server.calls.length = 0;
  assert.equal(await cost("net1", {}), 0, "now it is kept: asking again costs nothing");
});

test("preload: a file too large to keep stops its download and stores nothing", async () => {
  const b = globalThis.__browser;
  const path = "maps/huge.of-0123abcd.webp";
  b.server.handler = async call => slowFile(call, bytes(5000));
  assert.deepEqual(await warm(`${ORIGIN}/${path}`, undefined, 1000), { ok: false, bytes: 0, reason: "tooLarge" });
  await until(() => b.server.calls.at(-1).aborted, "the download aborted");
  await tick(30);
  assert.equal(b.stored().includes(`${ORIGIN}/${path}`), false);

  // Found out while reading (no declared length): the bytes already moved are the host's, the rest is not downloaded.
  const path2 = "maps/huge2.of-0123abcd.webp";
  b.server.handler = async call => {
    call.aborted = false;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes(5000));
        call.init.signal.addEventListener("abort", () => { call.aborted = true; c.error(new DOMException("aborted", "AbortError")); });
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "image/webp" } });
  };
  const result = await warm(`${ORIGIN}/${path2}`, undefined, 1000);
  assert.deepEqual(result, { ok: false, bytes: 5000, reason: "tooLarge" });
  await until(() => b.server.calls.at(-1).aborted, "the download aborted");
  await tick(30);
  assert.equal(b.stored().includes(`${ORIGIN}/${path2}`), false);
});

test("preload: an aborted warm-up stops, stores nothing, and a missing file or overload is reported", async () => {
  const b = globalThis.__browser;
  b.server.handler = async call => slowFile(call, bytes(5000));
  const ctl = new AbortController();
  const pending = warm(`${ORIGIN}/maps/stop.of-0123abcd.webp`, ctl.signal);
  await until(() => b.server.calls.some(c => c.url.endsWith("stop.of-0123abcd.webp")));
  ctl.abort();
  await assert.rejects(pending);
  await tick(30);
  assert.equal(b.stored().includes(`${ORIGIN}/maps/stop.of-0123abcd.webp`), false);

  b.server.handler = async () => new Response("no", { status: 404 });
  assert.deepEqual(await warm(`${ORIGIN}/maps/none.of-0123abcd.webp`), { ok: false, bytes: 0, reason: "HTTP 404" });
  b.server.handler = async () => new Response("down", { status: 503 });
  await assert.rejects(warm(`${ORIGIN}/maps/down.of-0123abcd.webp`), /HTTP 503/);
});
