import { test, after } from "node:test";
import assert from "node:assert/strict";
import { installBrowser, ORIGIN, CACHE, bytes, tick, until, body, fileResponse, slowFile } from "./cache-fakes.mjs";

/**
 * scripts/net/local-cache.mjs in a stubbed browser (test/cache-fakes.mjs): which requests the wrapped fetch takes
 * over, what a hit, a miss and a download in flight give, the revalidation of mutable media, aborts, a cache that
 * fails, the LRU and the quota, the audio override and the cleanup of the old Service Worker.
 * The module keeps its state for the whole file; every test starts from `begin()`, a bare browser.
 */
const b = installBrowser();
const cache = await import("../scripts/net/local-cache.mjs");
const { installLocalCache, startLocalCache, readyLocalCache, cacheStatus, fetchMedia, clearDeviceCache, cachedOptimizedPaths, readCached } = cache;
const MIB = 1_048_576;
installLocalCache();
after(() => b.restore());

/** `maps/<name>.of-<hash8>.<ext>`: an optimized file. */
const opt = (name, ext = "webp", n = 1) => `maps/${name}.of-${String(n).padStart(8, "0")}.${ext}`;
const url = path => `${ORIGIN}/${path}`;
const key = path => url(path);

async function begin(settings = {}) {
  b.reset();
  Object.assign(b.settings, settings);
  startLocalCache();
  await readyLocalCache();
}
/** Read the whole body, then wait until the file is in Cache Storage and the metadata knows it. */
async function get(path, options) {
  const result = await fetchMedia(url(path), options);
  await body(result.response);
  await until(() => b.idb.entries.has(key(path)), `${path} stored`);
  return result;
}
const answer = (data, headers) => async () => fileResponse(data, headers);
const kept = path => b.stored().includes(key(path));

test("local cache: the wrapped fetch does nothing until the cache is started", async () => {
  b.reset();
  b.server.handler = answer(bytes(20));
  const init = {};
  const res = await fetch(url(opt("early")), init);
  assert.equal(res.status, 200);
  assert.equal(b.server.calls[0].init, init, "the request went through untouched");
  await tick(20);
  assert.deepEqual(b.stored(), []);
  assert.deepEqual([cacheStatus().active, cacheStatus().reason], [false, "off"]);
});

test("local cache: the reason it is not active", async () => {
  b.reset();
  b.settings.localCache = false;
  startLocalCache();
  assert.deepEqual([cacheStatus().active, cacheStatus().reason], [false, "off"]);

  b.settings.localCache = true;
  globalThis.isSecureContext = false;
  startLocalCache();
  assert.equal(cacheStatus().reason, "insecure");
  globalThis.isSecureContext = true;

  const real = globalThis.caches;
  delete globalThis.caches;
  startLocalCache();
  assert.equal(cacheStatus().reason, "unsupported");
  globalThis.caches = real;

  startLocalCache();
  assert.equal(cacheStatus().active, true);
  assert.equal("reason" in cacheStatus(), false, "a reason only when not active");
  assert.deepEqual(Object.keys(cacheStatus()).sort(), ["active", "cachedBytes", "cachedFiles", "persisted", "quotaBytes"]);
});

test("local cache: only same-origin GET requests for media, without Range or a cache bypass, are taken over", async () => {
  await begin();
  b.server.handler = answer(bytes(30));
  const path = "maps/plain.png";
  const passthrough = [
    ["a POST", init => fetch(url(path), init), { method: "POST" }],
    ["a HEAD", init => fetch(url(path), init), { method: "HEAD" }],
    ["a Range request", init => fetch(url(path), init), { headers: { Range: "bytes=0-9" } }],
    ["a conditional request", init => fetch(url(path), init), { headers: { "If-None-Match": '"x"' } }],
    ["cache: no-store", init => fetch(url(path), init), { cache: "no-store" }],
    ["cache: reload", init => fetch(url(path), init), { cache: "reload" }],
    ["another origin", init => fetch("https://cdn.example/maps/plain.png", init), {}],
    ["a script", init => fetch(url("scripts/foundry.js"), init), {}],
    ["a page", init => fetch(url("game"), init), {}],
    ["no extension", init => fetch(url("maps/readme"), init), {}]
  ];
  for (const [label, run, init] of passthrough) {
    b.server.calls.length = 0;
    await run(init);
    assert.equal(b.server.calls.length, 1, label);
    assert.equal(b.server.calls[0].init, init, `${label}: the caller's own arguments reached the network`);
  }
  const ranged = new Request(url(path), { headers: { Range: "bytes=0-9" } });
  b.server.calls.length = 0;
  await fetch(ranged);
  assert.equal(b.server.calls[0].input, ranged);
  await tick(30);
  assert.deepEqual(b.stored(), [], "none of them was stored");

  // Taken over: a relative URL (resolved against the page), an absolute one, and a Request object.
  b.server.calls.length = 0;
  await (await fetch("maps/rel.png")).arrayBuffer();
  await (await fetch(new Request(url("maps/req.webp")))).arrayBuffer();
  await (await fetch(new URL(url(opt("obj"))))).arrayBuffer();
  await until(() => b.stored().length === 3, "three files stored");
  assert.deepEqual(b.server.calls.map(c => c.url).sort(), [url("maps/rel.png"), url("maps/req.webp"), url(opt("obj"))].sort());
});

test("local cache: an optimized file is downloaded once, then served from the cache", async () => {
  await begin();
  const data = bytes(64, 3);
  const path = opt("cave");
  b.server.handler = answer(data, { "cf-cache-status": "MISS" });

  const first = await get(path);
  assert.equal(first.source, "net");
  assert.equal(first.edge, "MISS", "the CDN's verdict on this download");
  assert.equal(b.server.calls[0].init.priority, undefined);
  assert.equal(b.server.calls[0].init.credentials, "same-origin");
  assert.equal("cache" in b.server.calls[0].init, false, "the browser's HTTP cache may answer");

  const again = await fetchMedia(url(path));
  assert.deepEqual([again.source, again.edge], ["cache", null]);
  assert.deepEqual(await body(again.response), data);
  const viaFetch = await fetch(url(path));
  assert.equal(viaFetch.status, 200);
  assert.equal(viaFetch.headers.get("content-type"), "image/webp");
  assert.deepEqual(await body(viaFetch), data);
  assert.equal(b.server.calls.length, 1, "nothing more reached the server");

  assert.deepEqual([cacheStatus().cachedFiles, cacheStatus().cachedBytes], [1, 64]);
  assert.deepEqual(b.idb.entries.get(key(path)).bytes, 64, "the LRU metadata is stored");
  assert.deepEqual(await cachedOptimizedPaths(), [path], "library-form path");
  assert.deepEqual(new Uint8Array(await (await readCached(path)).arrayBuffer()), data);
  assert.equal(await readCached(opt("nothing")), null);

  b.server.calls.length = 0;
  await get(opt("later"), { preload: true });
  assert.equal(b.server.calls[0].init.priority, "low", "a preload is fetched behind everything the game asks for");
});

test("local cache: a request for a file already downloading waits for that download", async () => {
  await begin();
  const data = bytes(40, 5);
  const path = opt("big");
  b.server.handler = async call => slowFile(call, data);

  const first = await fetchMedia(url(path), { preload: true });
  const second = fetchMedia(url(path)); // the scene's own request
  const third = fetch(url(path));
  await tick(20);
  assert.equal(b.server.calls.length, 1, "one download for all three");
  b.server.calls[0].finish();
  assert.deepEqual(await body(first.response), data);
  const joined = await second;
  assert.equal(joined.source, "cache", "it cost no download of its own");
  assert.deepEqual(await body(joined.response), data);
  assert.deepEqual(await body(await third), data);
  assert.equal(b.server.calls.length, 1);
  await until(() => kept(path));
});

test("local cache: a stored mutable file is revalidated, at most once every 30 seconds", async () => {
  await begin();
  const path = "maps/town.webp";
  const [v1, v2, v3] = [bytes(30, 1), bytes(40, 2), bytes(50, 3)];
  const validators = { etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" };
  b.server.handler = answer(v1, validators);
  await get(path);
  assert.equal(b.server.calls.length, 1);

  b.time(10_000);
  assert.equal((await fetchMedia(url(path))).source, "cache");
  assert.equal(b.server.calls.length, 1, "inside the 30 s window nothing is asked");

  // 304: the stored copy is current.
  b.time(31_000);
  b.server.handler = async () => new Response(null, { status: 304 });
  const same = await fetchMedia(url(path));
  assert.equal(same.source, "cache");
  assert.deepEqual(await body(same.response), v1);
  const asked = b.server.calls.at(-1);
  assert.equal(asked.headers.get("if-none-match"), '"v1"');
  assert.equal(asked.headers.get("if-modified-since"), validators["last-modified"]);
  assert.equal(asked.init.cache, "no-store", "the HTTP cache must not answer a revalidation");
  assert.equal(b.server.calls.length, 2);
  b.time(5000);
  await fetchMedia(url(path));
  assert.equal(b.server.calls.length, 2, "a 304 starts the window again");

  // 200: the file changed; the answer is served and replaces the stored copy.
  b.time(31_000);
  b.server.handler = answer(v2, { etag: '"v2"' });
  const changed = await fetchMedia(url(path));
  assert.equal(changed.source, "net");
  assert.deepEqual(await body(changed.response), v2);
  await until(async () => (await readCached(path)).size === 40, "the new copy stored");
  assert.deepEqual(new Uint8Array(await (await readCached(path)).arrayBuffer()), v2);
  assert.equal(b.idb.entries.get(key(path)).bytes, 40);

  // 5xx and a network error: the stored copy is served.
  for (const handler of [async () => new Response("down", { status: 503 }), async () => { throw new TypeError("Failed to fetch"); }]) {
    b.time(31_000);
    b.server.handler = handler;
    const served = await fetchMedia(url(path));
    assert.equal(served.source, "cache");
    assert.deepEqual(await body(served.response), v2);
  }

  // 404: the file is gone, and so is the stored copy.
  b.time(31_000);
  b.server.handler = async () => new Response("gone", { status: 404 });
  const gone = await fetchMedia(url(path));
  assert.deepEqual([gone.response.status, gone.source], [404, "net"]);
  assert.equal(kept(path), false);
  assert.equal(b.idb.entries.has(key(path)), false);

  // The next request stores whatever is there now.
  b.server.handler = answer(v3);
  await get(path);
  assert.equal((await readCached(path)).size, 50);
});

/** An answer that never comes, and fails when the request's signal aborts. */
const hanging = call => new Promise((_, reject) => call.init.signal.addEventListener("abort", () => { call.aborted = true; reject(new DOMException("aborted", "AbortError")); }));

test("local cache: an aborted download stores nothing", async () => {
  await begin();
  const data = bytes(40, 7);
  const path = opt("abort");
  b.server.handler = async call => slowFile(call, data);

  // Aborted while the body arrives.
  const ctl = new AbortController();
  const started = await fetchMedia(url(path), { signal: ctl.signal, preload: true });
  ctl.abort();
  await assert.rejects(body(started.response), "the caller's body fails like an aborted fetch's");
  await until(() => b.server.calls[0].aborted, "the download aborted: nobody waits for it");
  await tick(30);
  assert.deepEqual(b.stored(), []);
  assert.equal(b.idb.entries.size, 0);

  // Aborted before the server answered.
  b.server.handler = async call => hanging(call);
  const early = new AbortController();
  const pending = fetchMedia(url(path), { signal: early.signal, preload: true });
  await until(() => b.server.calls.length === 2);
  early.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await until(() => b.server.calls[1].aborted, "the request aborted");
  assert.deepEqual(b.stored(), []);

  // A signal that is already aborted never reaches the server.
  const before = b.server.calls.length;
  await assert.rejects(fetchMedia(url(path), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(b.server.calls.length, before);

  // A connection that drops mid-body stores nothing either.
  const dropped = new ReadableStream({ start(c) { c.enqueue(data.slice(0, 4)); c.error(new TypeError("network error")); } });
  b.server.handler = async () => new Response(dropped, { status: 200, headers: { "content-type": "image/webp" } });
  await assert.rejects(body((await fetchMedia(url(opt("cut")))).response));
  await tick(30);
  assert.deepEqual(b.stored(), []);
});

test("local cache: a caller that aborts does not break another caller waiting on the same download", async () => {
  await begin();
  const data = bytes(40, 8);
  const path = opt("shared");

  // The caller that started the download aborts; the one waiting gets the whole file, and it is stored.
  b.server.handler = async call => slowFile(call, data);
  const ctl = new AbortController();
  const leader = await fetchMedia(url(path), { signal: ctl.signal, preload: true });
  const waiter = fetchMedia(url(path));
  await tick(20);
  ctl.abort();
  await tick(20);
  assert.equal(b.server.calls[0].aborted, false, "the download goes on for whoever still waits");
  b.server.calls[0].finish();
  const second = await waiter;
  assert.deepEqual(await body(second.response), data);
  await assert.rejects(body(leader.response), "the caller that aborted sees the abort");
  await until(() => kept(path));
  assert.equal(b.server.calls.length, 1);

  // The caller that waits aborts; the one that started the download is not affected.
  b.server.calls.length = 0;
  const path2 = opt("shared", "webp", 2);
  const lead = await fetchMedia(url(path2));
  const wait = new AbortController();
  const impatient = fetchMedia(url(path2), { signal: wait.signal });
  await tick(20);
  wait.abort();
  await assert.rejects(impatient, { name: "AbortError" });
  assert.equal(b.server.calls[0].aborted, false);
  b.server.calls[0].finish();
  assert.deepEqual(await body(lead.response), data);
  await until(() => kept(path2));

  // Everyone gives up: the download stops and nothing is stored.
  const path3 = opt("shared", "webp", 3);
  const a = new AbortController(), c = new AbortController();
  const one = await fetchMedia(url(path3), { signal: a.signal });
  const two = fetchMedia(url(path3), { signal: c.signal });
  await tick(20);
  a.abort();
  c.abort();
  await assert.rejects(two, { name: "AbortError" });
  await assert.rejects(body(one.response));
  await until(() => b.server.calls.at(-1).aborted, "the download aborted");
  await tick(30);
  assert.equal(kept(path3), false);
});

test("local cache: a failure inside the cache falls back to the native fetch, a network failure does not", async () => {
  await begin();
  const data = bytes(25, 9);
  const input = url(opt("fallback"));
  const init = {};
  b.server.handler = answer(data);

  b.caches.faults.open = 1; // the next caches.open() throws
  const res = await fetch(input, init);
  assert.deepEqual(await body(res), data);
  assert.equal(b.server.calls.length, 1);
  assert.equal(b.server.calls[0].input, input, "the caller's own arguments");
  assert.equal(b.server.calls[0].init, init);
  assert.deepEqual(b.stored(), []);

  // The preloader's entry falls back the same way.
  b.caches.faults.open = 1;
  const media = await fetchMedia(url(opt("fallback", "webp", 2)));
  assert.equal(media.source, "net");
  assert.equal(media.response.status, 200);

  // The network itself failing is the caller's error, not a cache failure: no second request.
  b.server.calls.length = 0;
  b.server.handler = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetch(url(opt("down"))), TypeError);
  assert.equal(b.server.calls.length, 1);
  // Something the cache does not handle, asked through the preloader, is a plain fetch.
  b.server.handler = answer(bytes(5));
  assert.equal((await fetchMedia(url("scripts/x.js"))).source, "net");
});

test("local cache: the least recently used files go first, and a file may use at most half the quota", async () => {
  await begin({ cacheQuotaMB: 1000 / MIB });
  const files = Object.fromEntries("abcd".split("").map((n, i) => [n, bytes(300, i)]));
  b.server.handler = async call => fileResponse(files[/maps\/(\w)\.of/.exec(call.url)[1]]);
  const path = n => opt(n);

  await get(path("a"));
  b.time(1000);
  await get(path("b"));
  b.time(1000);
  await get(path("c"));
  assert.equal(b.stored().length, 3, "900 of 1000 bytes");

  b.time(70_000);
  await fetchMedia(url(path("a"))); // used again: no longer the oldest
  await until(() => b.idb.entries.get(key(path("a"))).lastAccess > b.idb.entries.get(key(path("b"))).lastAccess, "a touched");
  b.time(1000);
  await get(path("d"));
  await until(() => !kept(path("b")), "the least recently used file evicted");
  assert.deepEqual(b.stored().sort(), ["a", "c", "d"].map(n => key(path(n))).sort());
  assert.deepEqual([...b.idb.entries.keys()].sort(), b.stored().sort(), "the metadata follows");
  assert.deepEqual([cacheStatus().cachedFiles, cacheStatus().cachedBytes, cacheStatus().quotaBytes], [3, 900, 1000]);

  // Over half the quota: served, not stored. With a declared size it is never even tee'd; without one the stored
  // copy is checked against the cap.
  b.server.handler = async () => fileResponse(bytes(600, 9));
  const big = await fetchMedia(url(opt("huge")));
  assert.equal((await body(big.response)).length, 600);
  b.server.handler = async () => new Response(bytes(600, 9), { status: 200, headers: { "content-type": "image/webp" } });
  assert.equal((await body((await fetchMedia(url(opt("huge", "webp", 2)))).response)).length, 600);
  await tick(50);
  assert.equal(kept(opt("huge")) || kept(opt("huge", "webp", 2)), false);
  assert.equal(b.stored().length, 3);
});

test("local cache: eviction counts what other tabs stored, not just this tab's memory", async () => {
  await begin({ cacheQuotaMB: 2000 / MIB });
  // Another tab of the same origin stored two files (900 and 600 bytes); this tab never saw them.
  const now = Date.now();
  b.store(opt("tab-old"), bytes(900, 1));
  b.store(opt("tab-new"), bytes(600, 2));
  b.idb.entries.set(key(opt("tab-old")), { key: key(opt("tab-old")), bytes: 900, lastAccess: now - 5000 });
  b.idb.entries.set(key(opt("tab-new")), { key: key(opt("tab-new")), bytes: 600, lastAccess: now - 1000 });

  b.server.handler = answer(bytes(600, 3));
  await get(opt("mine")); // 2100 of 2000 bytes: this tab alone would see 600
  await until(() => !kept(opt("tab-old")), "the other tab's oldest file evicted");
  assert.equal(kept(opt("tab-new")), true);
  assert.equal(kept(opt("mine")), true);
  assert.equal(b.idb.entries.has(key(opt("tab-old"))), false);
});

test("local cache: the quota is the setting, capped at 60% of what the browser offers", async () => {
  b.reset();
  b.estimate = { quota: 1000 };
  Object.assign(b.settings, { cacheQuotaMB: 4096 });
  startLocalCache();
  await readyLocalCache();
  assert.equal(cacheStatus().quotaBytes, 600);
});

test("local cache: persistent storage is requested on Chromium only", async () => {
  await begin();
  await until(() => cacheStatus().persisted === true, "persistence granted");
  assert.equal(b.persist.asked, 1);

  b.reset();
  const agent = navigator.userAgentData;
  navigator.userAgentData = undefined; // Firefox: it would prompt, so it is only asked
  startLocalCache();
  await readyLocalCache();
  await until(() => cacheStatus().persisted === false, "queried");
  assert.equal(b.persist.asked, 0);
  navigator.userAgentData = agent;
});

test("local cache: a kept optimized sound is played from a blob URL, and nothing else is touched", async () => {
  await begin();
  const data = bytes(80, 4);
  const sound = opt("theme", "ogg");
  b.server.handler = answer(data, { "content-type": "audio/ogg" });
  await get(sound);
  const audio = () => new globalThis.HTMLAudioElement();

  const a = audio();
  a.src = sound;
  assert.match(a.src, /^blob:/);
  assert.equal(b.objectUrls.get(a.src).size, 80);
  const other = audio();
  other.src = url(sound);
  assert.equal(other.src, a.src, "an absolute URL finds the same file");

  const unknown = audio();
  unknown.src = opt("unknown", "ogg");
  assert.equal(unknown.src, opt("unknown", "ogg"), "a URL that is not kept passes through");
  const empty = audio();
  empty.src = "";
  assert.equal(empty.src, "", 'element.src = "" (how Foundry unloads a sound) behaves as before');
  const video = new globalThis.HTMLVideoElement();
  video.src = sound;
  assert.equal(video.src, sound, "only <audio> elements are touched");

  // Not kept as a sound: mutable files, and optimized files that may be video.
  b.server.handler = answer(data, { "content-type": "audio/ogg" });
  await get("music/plain.ogg");
  await get(opt("clip", "webm"));
  for (const path of ["music/plain.ogg", opt("clip", "webm")]) {
    const e = audio();
    e.src = path;
    assert.equal(e.src, path, path);
  }

  // Cleared: the blob URL is revoked and the network URL is used again.
  const blobUrl = a.src;
  await clearDeviceCache();
  assert.ok(b.revoked.includes(blobUrl));
  const after = audio();
  after.src = sound;
  assert.equal(after.src, sound);
});

test("local cache: evicting a sound revokes its blob URL, and a sound already kept is found at start", async () => {
  await begin({ cacheQuotaMB: 1000 / MIB });
  b.server.handler = async () => fileResponse(bytes(300, 1), { "content-type": "audio/ogg" });
  await get(opt("s1", "ogg"));
  const first = new globalThis.HTMLAudioElement();
  first.src = opt("s1", "ogg");
  const blobUrl = first.src;
  assert.match(blobUrl, /^blob:/);
  b.time(1000);
  await get(opt("s2", "ogg"));
  b.time(1000);
  await get(opt("s3", "ogg"));
  b.time(1000);
  await get(opt("s4", "ogg")); // 1200 of 1000: the oldest goes
  await until(() => !kept(opt("s1", "ogg")), "s1 evicted");
  assert.ok(b.revoked.includes(blobUrl));
  const again = new globalThis.HTMLAudioElement();
  again.src = opt("s1", "ogg");
  assert.equal(again.src, opt("s1", "ogg"));

  // A file stored by an earlier session is indexed when the cache starts (not before the metadata is ready).
  b.reset();
  b.store(opt("old", "ogg"), bytes(50, 2), { "content-type": "audio/ogg" });
  startLocalCache();
  await readyLocalCache();
  const probe = () => { const e = new globalThis.HTMLAudioElement(); e.src = opt("old", "ogg"); return e.src; };
  await until(() => probe().startsWith("blob:"), "kept sound indexed");
});

test("local cache: the old Service Worker is unregistered and its database deleted, the files stay and are served", async () => {
  b.reset();
  b.worker("/optimal-foundry-sw.js");
  b.worker("/vtt/modules/optimal-foundry/sw.js");
  b.worker("/modules/another-module/sw.js");
  const data = bytes(70, 6);
  b.store(opt("legacy"), data);
  startLocalCache();
  await readyLocalCache();

  assert.deepEqual(b.unregistered, ["/optimal-foundry-sw.js", "/vtt/modules/optimal-foundry/sw.js"], "only this module's workers");
  assert.deepEqual(b.indexedDB.deleted, ["optimal-foundry-sw"]);
  assert.deepEqual(b.stored(), [key(opt("legacy"))], "Cache Storage stays");
  assert.deepEqual([cacheStatus().cachedFiles, cacheStatus().cachedBytes], [1, 70], "the metadata is rebuilt from the stored files");
  assert.equal(b.idb.entries.get(key(opt("legacy"))).bytes, 70);
  const served = await fetchMedia(url(opt("legacy")));
  assert.equal(served.source, "cache");
  assert.deepEqual(await body(served.response), data);
  assert.equal(b.server.calls.length, 0);

  // Also while the cache is off: a worker left behind would keep intercepting.
  b.reset();
  b.worker("/optimal-foundry-sw.js");
  b.settings.localCache = false;
  startLocalCache();
  await readyLocalCache();
  assert.deepEqual(b.unregistered, ["/optimal-foundry-sw.js"]);
  assert.deepEqual(b.indexedDB.deleted, ["optimal-foundry-sw"]);
  assert.equal(cacheStatus().active, false);
});

test("local cache: metadata drops files that are gone, and clearing deletes every file and tells the swarm", async () => {
  await begin();
  b.server.handler = answer(bytes(100, 1));
  await get(opt("one"));
  await get(opt("two"));
  await get("maps/mutable.png");
  b.stores.get(CACHE).delete(key(opt("two"))); // another tab evicted it
  await readyLocalCache();
  assert.deepEqual([cacheStatus().cachedFiles, b.idb.entries.size], [2, 2], "the stale row is gone");

  b.stores.set("optimal-foundry-v0", new Map());
  b.stores.set("another-module", new Map());
  const { freedBytes } = await clearDeviceCache();
  assert.equal(freedBytes, 200);
  assert.deepEqual([...b.stores.keys()], ["another-module"], "only this module's caches");
  assert.deepEqual([cacheStatus().cachedFiles, b.idb.entries.size], [0, 0]);
  assert.deepEqual(await cachedOptimizedPaths(), []);
});
