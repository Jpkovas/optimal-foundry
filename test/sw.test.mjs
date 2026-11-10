import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/**
 * sw.js in a `node:vm` sandbox with stubbed `self`, `caches`, `indexedDB`, `fetch` and `clients`: what the worker
 * answers, what it asks the page and the network for, and when it removes itself. Each `boot()` is one worker
 * instance; passing the same `disk` to a second boot is the browser restarting the worker.
 */
const SOURCE = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const ORIGIN = "https://vtt.example";
const CACHE = "optimal-foundry-v1";
const SOURCE_HEADER = "X-Optimal-Foundry-Source";
const PRELOAD = { "X-Optimal-Foundry-Preload": "1" };

const bytes = (n, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Cache Storage: name -> Map<url, {headers, body}>. A body that fails while it is read is never stored. */
function fakeCaches(stores) {
  const cache = map => ({
    async match(key) {
      const e = map.get(String(key));
      return e ? new Response(e.body, { status: 200, headers: e.headers }) : undefined;
    },
    async put(key, res) { map.set(String(key), { headers: [...res.headers], body: new Uint8Array(await res.arrayBuffer()) }); },
    async delete(key) { return map.delete(String(key)); },
    async keys() { return [...map.keys()].map(url => ({ url })); }
  });
  return {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name));
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
}

/** IndexedDB with the two stores the worker uses; transactions complete on the next microtask. */
function fakeIndexedDB(idb) {
  const done = result => ({ result });
  const store = (map, keyPath) => ({
    get: key => done(structuredClone(map.get(key))),
    getAll: () => done([...map.values()].map(v => structuredClone(v))),
    put: (value, key) => { map.set(keyPath ? value[keyPath] : key, structuredClone(value)); return done(undefined); },
    delete: key => { map.delete(key); return done(undefined); },
    clear: () => { map.clear(); return done(undefined); }
  });
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(name) {
      const tx = { objectStore: () => store(idb[name], name === "entries" ? "key" : null) };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }
  };
  return { open() { const req = { result: db }; queueMicrotask(() => req.onsuccess?.()); return req; } };
}

class FakePort {
  onmessage = null;
  postMessage(data) { queueMicrotask(() => this.other.onmessage?.({ data })); }
  close() {}
}
class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

function boot({ scope = `${ORIGIN}/`, disk = {}, fetch = async () => new Response("unexpected", { status: 500 }) } = {}) {
  disk.caches ??= new Map();
  disk.idb ??= { entries: new Map(), kv: new Map() };
  const listeners = {};
  const pages = new Map(); // client id -> {id, type, messages: [{msg, port}]}
  const w = { disk, pages, fetched: [], unregistered: 0, warnings: [] };
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: new URL(`${scope}optimal-foundry-sw.js`),
    registration: { scope, unregister: async () => { w.unregistered++; return true; } },
    clients: {
      get: async id => pages.get(id) ?? null,
      matchAll: async () => [...pages.values()],
      claim: async () => {}
    },
    skipWaiting: async () => {}
  };
  const timers = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  vm.runInNewContext(SOURCE, {
    self, caches: fakeCaches(disk.caches), indexedDB: fakeIndexedDB(disk.idb),
    fetch: (input, init = {}) => {
      const call = { url: typeof input === "string" ? input : input.url, init, headers: new Headers(init.headers ?? input.headers) };
      w.fetched.push(call);
      return fetch(call);
    },
    Response, Request, Headers, Blob, URL, AbortController, MessageChannel: FakeMessageChannel,
    setTimeout: timers, clearTimeout, console: { warn: (...a) => w.warnings.push(a.join(" ")) }
  }, { filename: "sw.js" });

  w.page = id => {
    const page = { id, type: "window", messages: [], postMessage(msg, transfer) { page.messages.push({ msg, port: transfer?.[0] }); } };
    pages.set(id, page);
    return page;
  };
  /** Dispatch a fetch event. Resolves `{handled, response?}` once the worker's own follow-up work is done too. */
  w.get = (path, { headers = {}, clientId = "page-1", navigate = false } = {}) => {
    const url = new URL(path, scope).href;
    const request = navigate
      ? { method: "GET", mode: "navigate", url, cache: "default", destination: "document", headers: new Headers() }
      : new Request(url, { headers });
    const waits = [];
    let responding = null;
    listeners.fetch({ request, clientId, waitUntil: p => waits.push(p), respondWith: p => { responding = Promise.resolve(p); } });
    const settled = async () => { for (let i = 0; i < waits.length; i++) await waits[i]; };
    if (!responding) return settled().then(() => ({ handled: false, settled }));
    return responding.then(response => ({ handled: true, response, settled }));
  };
  /** Post a message from a page; resolves with the worker's reply (or undefined when it sends none). */
  w.tell = async (data, clientId = "page-1") => {
    const waits = [];
    let answer;
    listeners.message({ data, source: { id: clientId }, ports: [{ postMessage: v => { answer = v; } }], waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return answer === undefined ? undefined : structuredClone(answer); // a real port clones what it carries
  };
  w.stored = () => [...(disk.caches.get(CACHE)?.keys() ?? [])];
  w.store = (path, body, headers = {}) => {
    if (!disk.caches.has(CACHE)) disk.caches.set(CACHE, new Map());
    disk.caches.get(CACHE).set(new URL(path, scope).href, { headers: [["content-type", "image/webp"], ["content-length", String(body.length)], ...Object.entries(headers)], body });
  };
  return w;
}

const body = async res => new Uint8Array(await res.arrayBuffer());
/** The questions the worker sent to a page (it also tells every page about each file it stores). */
const asks = page => page.messages.filter(m => m.msg.type === "p2p-get");
const fileResponse = (data, headers = {}) => new Response(data, { status: 200, headers: { "content-type": "image/webp", "content-length": String(data.length), ...headers } });

test("sw: a Range request on a stored file is sliced from the stored body", async () => {
  const w = boot();
  const data = bytes(100);
  w.store("maps/cave.of-1a2b3c4d.webp", data);

  const mid = (await w.get("maps/cave.of-1a2b3c4d.webp", { headers: { Range: "bytes=10-19" } })).response;
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(mid.headers.get("content-length"), "10");
  assert.deepEqual(await body(mid), data.slice(10, 20));
  assert.equal(mid.headers.get(SOURCE_HEADER), "cache");

  const tail = (await w.get("maps/cave.of-1a2b3c4d.webp", { headers: { Range: "bytes=-5" } })).response;
  assert.equal(tail.headers.get("content-range"), "bytes 95-99/100");
  assert.deepEqual(await body(tail), data.slice(95));

  const open = (await w.get("maps/cave.of-1a2b3c4d.webp", { headers: { Range: "bytes=90-" } })).response;
  assert.equal(open.headers.get("content-range"), "bytes 90-99/100");

  const past = (await w.get("maps/cave.of-1a2b3c4d.webp", { headers: { Range: "bytes=40-4000" } })).response;
  assert.equal(past.headers.get("content-range"), "bytes 40-99/100", "an end past the file is clamped");

  const beyond = (await w.get("maps/cave.of-1a2b3c4d.webp", { headers: { Range: "bytes=100-" } })).response;
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), "bytes */100");

  const whole = (await w.get("maps/cave.of-1a2b3c4d.webp")).response;
  assert.equal(whole.status, 200);
  assert.deepEqual(await body(whole), data);
  assert.equal(whole.headers.get(SOURCE_HEADER), "cache");
  assert.equal(w.fetched.length, 0, "nothing went to the network");
});

test("sw: a Range request on a missing file goes straight to the network and is not stored", async () => {
  const w = boot({ fetch: async call => new Response(bytes(10), { status: 206, headers: {
    "content-range": "bytes 0-9/100", via: call.headers.get("range"), mark: call.headers.get("x-optimal-foundry-preload") ?? "none"
  } }) });
  const r = await w.get("music/theme.of-00000001.ogg", { headers: { Range: "bytes=0-9", ...PRELOAD } });
  await r.settled();
  assert.equal(r.response.status, 206);
  assert.equal(r.response.headers.get("via"), "bytes=0-9", "the page's Range header reached the server");
  assert.equal(r.response.headers.get("mark"), "none", "the preload mark did not");
  assert.equal(r.response.headers.get(SOURCE_HEADER), null, "a response passed through as it came is not marked");
  assert.deepEqual(w.stored(), []);
});

test("sw: only media is handled, and a folder named like a Foundry route is media too", async () => {
  const w = boot({ fetch: async () => fileResponse(bytes(8)) });
  assert.equal((await w.get("scripts/foundry.js")).handled, false);
  assert.equal((await w.get("socket.io/?EIO=4")).handled, false);
  assert.equal((await w.get("game", { navigate: true })).handled, false);
  // The old prefix list skipped any Data folder whose name starts with upload, setup, join or auth.
  for (const path of ["uploads/map.webp", "setup-art/a.png", "joined/b.webp", "authors/c.of-0000000a.webp"]) {
    assert.equal((await w.get(path)).handled, true, path);
  }
});

test("sw: the file's source is named on every response the worker builds", async () => {
  const data = bytes(64, 3);
  const w = boot({ fetch: async () => fileResponse(data, { "cf-cache-status": "HIT" }) });
  const first = await w.get("maps/a.of-0000000b.webp");
  assert.equal(first.response.headers.get(SOURCE_HEADER), "net");
  assert.equal(first.response.headers.get("cf-cache-status"), "HIT", "the CDN's verdict on this download reaches the page");
  assert.deepEqual(await body(first.response), data);
  await first.settled();
  assert.deepEqual(w.stored(), [`${ORIGIN}/maps/a.of-0000000b.webp`]);
  const kept = disk(w).get(`${ORIGIN}/maps/a.of-0000000b.webp`).headers.map(([k]) => k.toLowerCase());
  assert.equal(kept.includes(SOURCE_HEADER.toLowerCase()) || kept.includes("cf-cache-status"), false,
    "the stored copy carries neither mark of the request that fetched it");

  const again = await w.get("maps/a.of-0000000b.webp");
  assert.equal(again.response.headers.get(SOURCE_HEADER), "cache");
  assert.equal(again.response.headers.get("cf-cache-status"), null);
  assert.deepEqual(await body(again.response), data);
  assert.equal(w.fetched.length, 1);
});
const disk = w => w.disk.caches.get(CACHE);

test("sw: a page is asked for P2P only after it said hello with p2p on", async () => {
  const data = bytes(50, 9);
  const w = boot({ fetch: async () => fileResponse(data) });
  const page = w.page("page-1");
  const other = w.page("page-2");

  // No hello yet (the browser just restarted the worker, or the module is disabled): straight to the network.
  const cold = await w.get("maps/one.of-00000001.webp", { clientId: "page-1" });
  assert.equal(cold.response.headers.get(SOURCE_HEADER), "net");
  await cold.settled();
  assert.equal(asks(page).length, 0, "a page that never said hello is not asked");

  assert.equal((await w.tell({ type: "config", p2p: true, timeoutMs: 8000, quotaBytes: 1e9 }, "page-1")).ok, true);
  assert.equal((await w.tell({ type: "stats" }, "page-1")).p2p, true);
  assert.equal((await w.tell({ type: "stats" }, "page-2")).p2p, false);

  // Another page of the same browser did not say hello: its requests do not wait for anyone.
  const foreign = await w.get("maps/two.of-00000002.webp", { clientId: "page-2" });
  assert.equal(foreign.response.headers.get(SOURCE_HEADER), "net");
  await foreign.settled();
  assert.equal(asks(page).length + asks(other).length, 0);

  // The page that said hello is asked, and its answer is served and stored.
  const pending = w.get("maps/three.of-00000003.webp", { clientId: "page-1" });
  while (!asks(page).length) await tick();
  const { msg, port } = asks(page)[0];
  assert.equal(msg.type, "p2p-get");
  assert.equal(msg.url, `${ORIGIN}/maps/three.of-00000003.webp`);
  port.postMessage({ id: msg.id, kind: "progress" });
  port.postMessage({ id: msg.id, kind: "done", blob: new Blob([data], { type: "image/webp" }) });
  const peer = await pending;
  assert.equal(peer.response.headers.get(SOURCE_HEADER), "p2p");
  assert.deepEqual(await body(peer.response), data);
  await peer.settled();
  assert.ok(w.stored().includes(`${ORIGIN}/maps/three.of-00000003.webp`));
  assert.equal(w.fetched.length, 2, "the P2P file cost no network request");

  // Mutable media and media elements never wait for P2P; a page that turned P2P off is not asked either.
  await (await w.get("maps/plain.webp", { clientId: "page-1" })).settled();
  await w.tell({ type: "config", p2p: false }, "page-1");
  await (await w.get("maps/four.of-00000004.webp", { clientId: "page-1" })).settled();
  assert.equal(asks(page).length, 1);
});

test("sw: game-page loads without a hello are counted and the fourth unregisters the worker", async () => {
  const data = bytes(20);
  const w = boot({ fetch: async call => (call.url.endsWith("module.json") ? new Response("{}", { status: 200 }) : fileResponse(data)) });
  w.store("maps/kept.of-0000000c.webp", data);
  const kv = w.disk.idb.kv;

  await w.get("join", { navigate: true });
  await w.get("game/extra", { navigate: true });
  assert.equal(kv.get("missedHellos") ?? 0, 0, "only the game page counts");

  await w.get("game", { navigate: true });
  await w.get("game", { navigate: true });
  assert.equal(kv.get("missedHellos"), 2);
  await w.tell({ type: "config", p2p: false });
  assert.equal(kv.get("missedHellos"), 0, "a hello starts the count again");

  for (let i = 0; i < 3; i++) await w.get("game", { navigate: true });
  assert.equal(kv.get("missedHellos"), 3);
  assert.equal(w.unregistered, 0, "three loads without a hello are still tolerated");
  assert.equal((await w.get("maps/kept.of-0000000c.webp")).handled, true);

  await w.get("game", { navigate: true });
  assert.equal(w.unregistered, 1);
  const manifest = w.fetched.find(c => c.url === `${ORIGIN}/modules/optimal-foundry/module.json`);
  assert.equal(manifest?.init.cache, "no-store");
  assert.deepEqual(w.stored(), [`${ORIGIN}/maps/kept.of-0000000c.webp`], "module still installed: the files stay for the worlds that use it");
  assert.equal((await w.get("maps/kept.of-0000000c.webp")).handled, false, "the retired worker leaves the open page alone");

  // The browser restarts the retired worker for a page it still controls: it stays out and stores nothing,
  // also for a request that arrives before it has read its state back.
  const again = boot({ disk: w.disk, fetch: async () => fileResponse(data) });
  const early = await again.get("maps/early.of-0000000d.webp");
  await early.settled();
  assert.equal(early.response.headers.get(SOURCE_HEADER), null, "passed through to the network untouched");
  assert.equal((await again.get("maps/new.of-0000000d.webp")).handled, false);
  assert.deepEqual(again.stored(), [`${ORIGIN}/maps/kept.of-0000000c.webp`]);
  // The module is enabled again: its page says hello and the worker works again.
  await again.tell({ type: "config", p2p: false });
  assert.equal((await again.get("maps/kept.of-0000000c.webp")).handled, true);
});

test("sw: when the module folder is gone the worker deletes its caches and metadata before it unregisters", async () => {
  const data = bytes(20);
  const w = boot({ scope: `${ORIGIN}/vtt/`, fetch: async call => (call.url.endsWith("module.json") ? new Response("Cannot GET", { status: 404 }) : fileResponse(data)) });
  await w.tell({ type: "config", p2p: true, quotaBytes: 5e8 });
  await (await w.get("maps/a.of-0000000e.webp")).settled();
  w.disk.caches.set("optimal-foundry-v0", new Map()); // a cache of an older worker version
  w.disk.caches.set("another-module", new Map());
  assert.equal(w.disk.idb.entries.size, 1);

  for (let i = 0; i < 4; i++) await w.get("game", { navigate: true });
  assert.ok(w.fetched.some(c => c.url === `${ORIGIN}/vtt/modules/optimal-foundry/module.json`), "the route prefix is kept");
  assert.equal(w.unregistered, 1);
  assert.deepEqual([...w.disk.caches.keys()], ["another-module"], "only this module's caches are deleted");
  assert.equal(w.disk.idb.entries.size, 0);
  assert.equal(w.disk.idb.kv.has("config"), false);
});

/** A network answer whose body stays open until `finish()`, and fails when the request's signal aborts. */
function slowFile(call, data) {
  let stream;
  const res = new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(data.slice(0, 4)); } }),
    { status: 200, headers: { "content-type": "image/webp", "content-length": String(data.length) } });
  call.init.signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
  call.finish = () => { stream.enqueue(data.slice(4)); stream.close(); };
  return res;
}

test("sw: a preload is fetched at low priority without its mark, and the page can abort it", async () => {
  const data = bytes(40, 5);
  const w = boot({ fetch: async call => slowFile(call, data) });
  const url = `${ORIGIN}/maps/big.of-000000aa.webp`;

  const pre = await w.get("maps/big.of-000000aa.webp", { headers: PRELOAD });
  const call = w.fetched[0];
  assert.equal(call.headers.get("x-optimal-foundry-preload"), null, "the mark never reaches the server");
  assert.equal(call.init.priority, "low");
  assert.equal(call.init.signal.aborted, false);
  assert.equal(pre.response.headers.get(SOURCE_HEADER), "net");

  assert.deepEqual(await w.tell({ type: "abort-preload", urls: [url] }), { ok: true, stopped: 1 });
  assert.equal(call.init.signal.aborted, true);
  await assert.rejects(body(pre.response), "the page's copy of the stream fails");
  await pre.settled();
  assert.deepEqual(w.stored(), [], "the partial copy is discarded");
  assert.deepEqual(await w.tell({ type: "abort-preload", urls: [url] }), { ok: true, stopped: 0 });

  // What the game asks for afterwards is a normal download.
  const urgent = await w.get("maps/big.of-000000aa.webp");
  assert.equal(w.fetched[1].init.priority, undefined);
  assert.equal(w.fetched[1].init.signal, undefined);
  w.fetched[1].finish();
  assert.deepEqual(await body(urgent.response), data);
  await urgent.settled();
  assert.deepEqual(w.stored(), [url]);
});

test("sw: a preload aborted before the server answered ends in an error, not in a second download", async () => {
  const w = boot({
    fetch: call => new Promise((_, reject) => call.init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  });
  const pending = w.get("maps/slow.of-000000ab.webp", { headers: PRELOAD });
  while (!w.fetched.length) await tick();
  await w.tell({ type: "abort-preload", urls: ["maps/slow.of-000000ab.webp"] });
  const r = await pending;
  assert.equal(r.response.type, "error");
  assert.equal(w.fetched.length, 1);
});

test("sw: a preload the game started waiting for can no longer be aborted", async () => {
  const data = bytes(40, 6);
  const w = boot({ fetch: async call => slowFile(call, data) });
  const pre = await w.get("maps/next.of-000000ac.webp", { headers: PRELOAD });
  const game = w.get("maps/next.of-000000ac.webp"); // the scene's own request joins the download in flight
  await tick();
  assert.deepEqual(await w.tell({ type: "abort-preload", urls: [`${ORIGIN}/maps/next.of-000000ac.webp`] }), { ok: true, stopped: 0 });
  assert.equal(w.fetched[0].init.signal.aborted, false);
  w.fetched[0].finish();
  assert.deepEqual(await body(pre.response), data);
  const joined = (await game).response;
  assert.deepEqual(await body(joined), data);
  assert.equal(joined.headers.get(SOURCE_HEADER), "cache", "the second request cost no download of its own");
  assert.equal(w.fetched.length, 1);
});

test("sw: a stored mutable file is revalidated, and a preload of it is abortable too", async () => {
  const old = bytes(30, 1);
  const fresh = bytes(40, 2);
  let answer = () => new Response(null, { status: 304 });
  const w = boot({ fetch: async call => answer(call) });
  w.store("maps/town.webp", old, { etag: '"v1"' });

  const same = await w.get("maps/town.webp");
  assert.equal(w.fetched[0].headers.get("if-none-match"), '"v1"');
  assert.equal(same.response.headers.get(SOURCE_HEADER), "cache");
  assert.deepEqual(await body(same.response), old);

  // A different worker instance (no recent validation): the file changed, and the preload fetching it is aborted.
  const w2 = boot({ disk: w.disk, fetch: async call => slowFile(call, fresh) });
  const pre = await w2.get("maps/town.webp", { headers: PRELOAD });
  assert.equal(w2.fetched[0].init.priority, "low");
  assert.equal(pre.response.headers.get(SOURCE_HEADER), "net");
  assert.deepEqual(await w2.tell({ type: "abort-preload", urls: ["maps/town.webp"] }), { ok: true, stopped: 1 });
  await pre.settled();
  assert.deepEqual(w2.stored(), [], "neither the outdated copy nor the partial new one stays");
  answer = null;
});
