import { mock } from "node:test";

/**
 * A browser for the local cache's tests (scripts/net/local-cache.mjs): Cache Storage, IndexedDB, a service-worker
 * container, `navigator.storage`, a server behind `fetch`, a clock that can be moved, audio elements and Foundry's
 * `game` / `Hooks`. One instance per test file (the module keeps its state for the whole file); `reset()` empties
 * the stores between tests. Import this BEFORE local-cache.mjs and call `installBrowser()` once.
 */
export const ORIGIN = "https://vtt.example";
export const CACHE = "optimal-foundry-v1";

export const bytes = (n, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);
export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
/** Wait (really) until `cond()` holds. */
export async function until(cond, label = "condition") {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await tick(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}
export const body = async res => new Uint8Array(await res.arrayBuffer());

/** Cache Storage: name -> Map<url, {headers, body}>. A body that fails while it is read is never stored. */
function fakeCaches(stores) {
  const faults = { open: 0 };
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
    faults,
    async open(name) {
      if (faults.open > 0) { faults.open--; throw new Error("Cache Storage is broken"); }
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name));
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
}

/** IndexedDB with the one store the cache uses; a transaction completes on the next microtask. */
function fakeIndexedDB(idb) {
  const done = result => ({ result });
  const store = map => ({
    getAll: () => done([...map.values()].map(v => structuredClone(v))),
    put: value => { map.set(value.key, structuredClone(value)); return done(undefined); },
    delete: key => { map.delete(key); return done(undefined); },
    clear: () => { map.clear(); return done(undefined); }
  });
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = { objectStore: () => store(idb.entries) };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }
  };
  return {
    deleted: [],
    open() { const req = { result: db }; queueMicrotask(() => req.onsuccess?.()); return req; },
    deleteDatabase(name) { this.deleted.push(name); return {}; }
  };
}

/** A page that stores things on `audio.src`: what the browser would be told to load. */
class FakeMediaElement { get src() { return this._src ?? ""; } set src(value) { this._src = String(value); } }
class FakeAudioElement extends FakeMediaElement {}
class FakeVideoElement extends FakeMediaElement {}

/**
 * @param {object} [options]
 * @param {object} [options.settings]  module settings over the defaults
 */
export function installBrowser({ settings = {} } = {}) {
  const b = {
    settings: { localCache: true, cacheQuotaMB: 4096, p2pTimeoutSec: 8, ...settings },
    stores: new Map(),
    idb: { entries: new Map() },
    server: { calls: [], handler: async () => new Response("not found", { status: 404 }) },
    registrations: [],
    unregistered: [],
    hooks: [],
    objectUrls: new Map(),
    revoked: [],
    clockOffset: 0,
    persist: { persisted: false, asked: 0 },
    estimate: { quota: 1e12, usage: 0 }
  };
  b.caches = fakeCaches(b.stores);
  b.indexedDB = fakeIndexedDB(b.idb);

  const realNow = Date.now;
  Date.now = () => realNow() + b.clockOffset;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let urlSeq = 0;
  URL.createObjectURL = blob => { const url = `blob:${ORIGIN}/${++urlSeq}`; b.objectUrls.set(url, blob); return url; };
  URL.revokeObjectURL = url => { b.revoked.push(url); b.objectUrls.delete(url); };

  Object.assign(globalThis, {
    caches: b.caches,
    indexedDB: b.indexedDB,
    isSecureContext: true,
    location: { origin: ORIGIN, href: `${ORIGIN}/game`, hostname: "vtt.example" },
    document: { baseURI: `${ORIGIN}/game` },
    HTMLMediaElement: FakeMediaElement,
    HTMLAudioElement: FakeAudioElement,
    HTMLVideoElement: FakeVideoElement,
    canvas: { loading: false },
    foundry: { utils: { getRoute: p => `/${String(p).replace(/^\/+/, "")}`, deepClone: v => structuredClone(v) } },
    Hooks: { on: (name, fn) => b.hooks.push([name, fn]), once() {}, callAll: (name, ...args) => { for (const [n, fn] of b.hooks) if (n === name) fn(...args); } },
    game: { user: {}, settings: { get: (_ns, key) => b.settings[key] } }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, writable: true,
    value: {
      serviceWorker: { getRegistrations: async () => b.registrations },
      storage: {
        estimate: async () => b.estimate,
        persisted: async () => b.persist.persisted,
        persist: async () => { b.persist.asked++; b.persist.persisted = true; return true; }
      },
      userAgentData: { brands: [{ brand: "Chromium" }] },
      deviceMemory: 8
    }
  });
  /** The server: every `fetch` the page makes that the cache does not answer lands here. */
  globalThis.fetch = async (input, init = {}) => {
    const call = { input, init, url: typeof input === "string" ? input : (input.url ?? String(input)), headers: new Headers(init.headers ?? input.headers) };
    b.server.calls.push(call);
    return b.server.handler(call);
  };

  b.time = ms => { b.clockOffset += ms; };
  /** Empty every store, forget the clock and the server's history; the next test starts from a bare browser. */
  b.reset = () => {
    b.stores.clear();
    b.idb.entries.clear();
    b.server.calls.length = 0;
    b.server.handler = async () => new Response("not found", { status: 404 });
    b.registrations.length = 0;
    b.unregistered.length = 0;
    b.indexedDB.deleted.length = 0;
    b.revoked.length = 0;
    b.clockOffset += 3_600_000; // validations of an earlier test are long past
    b.caches.faults.open = 0;
    b.persist.persisted = false;
    b.persist.asked = 0;
    b.estimate = { quota: 1e12, usage: 0 };
    globalThis.isSecureContext = true;
    globalThis.canvas = { loading: false };
    Object.assign(b.settings, { localCache: true, cacheQuotaMB: 4096, p2pTimeoutSec: 8 });
  };
  /** The files in Cache Storage, as keys. */
  b.stored = () => [...(b.stores.get(CACHE)?.keys() ?? [])];
  /** Put a file in Cache Storage the way an earlier version (or another tab) would have. */
  b.store = (path, data, headers = {}) => {
    if (!b.stores.has(CACHE)) b.stores.set(CACHE, new Map());
    b.stores.get(CACHE).set(`${ORIGIN}/${path}`, {
      headers: [["content-type", "image/webp"], ["content-length", String(data.length)], ...Object.entries(headers)], body: data
    });
  };
  /** A service-worker registration as `getRegistrations()` lists it. */
  b.worker = script => {
    const reg = { active: { scriptURL: `${ORIGIN}${script}` }, unregister: async () => { b.unregistered.push(script); return true; } };
    b.registrations.push(reg);
    return reg;
  };
  b.restore = () => {
    Date.now = realNow;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  };
  return b;
}

/** A 200 answer for a file. */
export const fileResponse = (data, headers = {}) =>
  new Response(data, { status: 200, headers: { "content-type": "image/webp", "content-length": String(data.length), ...headers } });

/**
 * A 200 answer whose body stays open until `call.finish()`, and fails when the request's signal aborts (as a real
 * connection does). `call.aborted` says whether it did.
 */
export function slowFile(call, data, headers = {}) {
  let stream;
  const res = new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(data.slice(0, 4)); } }),
    { status: 200, headers: { "content-type": "image/webp", "content-length": String(data.length), ...headers } });
  call.aborted = false;
  call.init.signal?.addEventListener("abort", () => { call.aborted = true; stream.error(new DOMException("aborted", "AbortError")); });
  call.finish = () => { stream.enqueue(data.slice(4)); stream.close(); };
  return res;
}

export { mock };
