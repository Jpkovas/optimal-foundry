import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * swarm.mjs with a stubbed Foundry, socket, local cache and RTCPeerConnection: when a browser is in
 * the swarm, what the coordinator's tracker reports, and how a download leaves a peer for the host.
 * The fake peer connection opens its data channel at once and hands every message to `seeder`, a scripted remote
 * player. The module keeps its state for the whole file, so the tests run in order and build on each other.
 */
const ORIGIN = "https://vtt.example";
const MIB = 1_048_576;
const settings = {
  p2pEnabled: true, networkProfile: "auto", cdnStatus: {}, p2pParticipate: true, connectionChoiceDone: false,
  localCache: true, hostUploadMbps: 20, preloadSharePct: 60, maxConcurrentRequests: 150, staggerJoin: true,
  idleSeconds: 5, preloadMaxFileMB: 100, p2pTimeoutSec: 8, cacheQuotaMB: 4096, p2pMinFileKB: 0, iceServers: "",
  p2pUploadCapMbps: 4, library: {}
};
const hooks = new Map();
const fire = (name, ...args) => { for (const fn of hooks.get(name) ?? []) fn(...args); };
const set = (key, value) => { settings[key] = value; fire("optimal-foundry.settingChanged", key, value); };
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const until = async cond => { while (!cond()) await tick(5); };

const users = new Map(["gm", "me", "p2", "p3"].map(id => [id, { id, name: id, isGM: id === "gm", active: true }]));
const sent = [];          // every envelope this browser put on the socket
let deliver = null;       // socket.mjs's listener: deliver(envelope, senderId) is a message arriving
let wantReply = () => ({ p: { peers: [], sha256: null, bytes: 0 } });

/** The remote player's side of every data channel. `answer(req)`: bytes to send for a piece request, or null to stay silent. */
const seeder = { requests: [], answer: () => null, connections: 0 };
class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  send(data) {
    if (typeof data !== "string") return;
    const msg = JSON.parse(data);
    if (msg.op === "ping") return this.receive(JSON.stringify({ op: "pong", t: msg.t }));
    if (msg.op !== "req") return;
    seeder.requests.push(msg);
    const bytes = seeder.answer(msg);
    if (!bytes) return;
    const packet = new Uint8Array(8 + bytes.length);
    new DataView(packet.buffer).setUint32(0, msg.rid);
    packet.set(bytes, 8);
    this.receive(packet.buffer);
    this.receive(JSON.stringify({ op: "end", rid: msg.rid }));
  }
  receive(data) { setTimeout(() => this.onmessage?.({ data }), 0); }
  close() { this.readyState = "closed"; }
}
class FakePeerConnection {
  constructor() { seeder.connections++; }
  sctp = { maxMessageSize: 65536 };
  signalingState = "stable";
  localDescription = { toJSON: () => ({ type: "answer", sdp: "" }) };
  createDataChannel() {
    const dc = new FakeChannel();
    setTimeout(() => { dc.readyState = "open"; dc.onopen?.(); }, 0);
    return dc;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

/** A library entry for an optimized file with real bytes, so the SHA-256 check is the real one. */
function addFile(name, size, seed) {
  const data = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i += 97) { x = (x * 1664525 + 1013904223) >>> 0; data[i] = x >>> 24; }
  const optimized = `maps/${name}.of-${String(seed).padStart(8, "0")}.webp`;
  settings.library[`maps/${name}.png`] = { status: "done", kind: "image", optimized, bytes: size,
    sha256: createHash("sha256").update(data).digest("hex") };
  return { path: optimized, data, size };
}
const pieceOf = (file, req) => (req.path === file.path ? file.data.subarray(req.start, req.end) : null);

/** The host answering a Range request in several chunks; records what was asked. */
function hostServing(file, calls) {
  globalThis.fetch = async (url, init) => {
    const range = init.headers.Range;
    calls.push({ url: String(url), range });
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range);
    const part = file.data.subarray(Number(from), Number(to) + 1);
    const step = Math.ceil(part.length / 4);
    return new Response(new ReadableStream({
      start(c) { for (let at = 0; at < part.length; at += step) c.enqueue(part.subarray(at, at + step)); c.close(); }
    }), { status: 206 });
  };
}

let swarm, socket, MSG, cache;
const realFetch = globalThis.fetch;

before(async () => {
  // The module's housekeeping intervals must not keep the test process alive.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); t.unref(); return t; };
  globalThis.window = globalThis;
  globalThis.isSecureContext = true;
  globalThis.location = { origin: ORIGIN, hostname: "vtt.example", href: `${ORIGIN}/game` };
  Object.defineProperty(globalThis, "navigator", { value: { deviceMemory: 8 }, configurable: true, writable: true });
  globalThis.caches = { open: async () => ({ keys: async () => [], match: async () => undefined }) };
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.foundry = { utils: { getRoute: p => `/${String(p).replace(/^\/+/, "")}`, deepClone: v => structuredClone(v) } };
  globalThis.Hooks = {
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    once() {},
    callAll: fire
  };
  globalThis.game = {
    user: users.get("me"),
    users: { get: id => users.get(id) ?? null, get activeGM() { return users.get("gm"); } },
    settings: { get: (_ns, key) => settings[key] },
    socket: {
      on: (name, fn) => { if (String(name).startsWith("module.")) deliver = fn; },
      emit: (_name, msg) => {
        sent.push(msg);
        if (msg.t === MSG.P2P_WANT) setTimeout(() => deliver({ re: msg.rid, to: [game.user.id], ...wantReply(msg) }, "gm"), 0);
      }
    }
  };
  socket = await import("../scripts/socket.mjs");
  MSG = socket.MSG;
  swarm = await import("../scripts/p2p/swarm.mjs");
  cache = await import("../scripts/net/local-cache.mjs");
  cache.installLocalCache();
  cache.startLocalCache();
  socket.initSocket();
});

after(() => {
  set("p2pEnabled", false); // closes every connection and its timers
  globalThis.fetch = realFetch;
});

const state = () => { const s = swarm.swarmStatus(); return s.enabled ? "on" : s.reason; };
const wants = () => sent.filter(m => m.t === MSG.P2P_WANT).length;

test("swarm: a browser is in the swarm only when the settings, the player and the page allow it", async () => {
  swarm.initSwarm();
  // A player who has not answered the first-run card: no peer connection, no signaling answered.
  assert.equal(state(), "notChosen");
  deliver({ t: MSG.P2P_SIGNAL, p: { sid: "x:1", description: { type: "offer", sdp: "" } }, to: ["me"] }, "p3");
  await tick();
  assert.equal(seeder.connections, 0, "no RTCPeerConnection before the player chose");
  assert.equal(swarm.swarmStatus().peers.length, 0);

  set("connectionChoiceDone", true);
  assert.equal(state(), "on");
  set("p2pParticipate", false);
  assert.equal(state(), "optOut");
  set("p2pParticipate", true);
  assert.equal(state(), "on");

  // Behind a caching CDN the automatic profile turns P2P off; so does the world setting.
  set("cdnStatus", { cdn: true });
  assert.equal(state(), "cdn");
  set("networkProfile", "quickTunnel");
  assert.equal(state(), "on");
  set("p2pEnabled", false);
  assert.equal(state(), "disabled");
  set("p2pEnabled", true);
  set("networkProfile", "auto");
  set("cdnStatus", {});
  assert.equal(state(), "on");

  // The local cache is not active in this browser: nothing to fetch into or serve from. The swarm follows it
  // turning off and on again by itself (no settings change needed).
  settings.localCache = false;
  cache.startLocalCache();
  assert.equal(cache.cacheStatus().active, false);
  assert.equal(state(), "noCache");
  settings.localCache = true;
  cache.startLocalCache();
  assert.equal(state(), "on");

  // Only the server's own machine counts as local: a LAN or VPN address is a normal player.
  location.hostname = "127.0.0.1";
  set("p2pParticipate", true);
  assert.equal(state(), "local");
  location.hostname = "192.168.1.20";
  set("p2pParticipate", true);
  assert.equal(state(), "on");
  location.hostname = "vtt.example";

  globalThis.isSecureContext = false;
  set("p2pParticipate", true);
  assert.equal(state(), "insecure");
  globalThis.isSecureContext = true;
  set("p2pParticipate", true);
  assert.equal(state(), "on");

  // A GM is never asked the player's question.
  settings.connectionChoiceDone = false;
  users.get("me").isGM = true;
  set("connectionChoiceDone", false);
  assert.equal(state(), "on");
  users.get("me").isGM = false;
  set("connectionChoiceDone", true);

  // In the swarm, an offer from another player is answered.
  deliver({ t: MSG.P2P_SIGNAL, p: { sid: "x:2", description: { type: "offer", sdp: "" } }, to: ["me"] }, "p3");
  await tick();
  assert.equal(swarm.swarmStatus().peers.map(p => p.userId).join(), "p3");
});

test("swarm: after a tracker request that got no answer, the tracker is left alone until it is back", async () => {
  const file = addFile("skip", 4096, 11);
  (await import("../scripts/library.mjs")).indexLibrary();
  wantReply = () => ({ err: "no coordinator" });
  assert.equal(await swarm.fetchFromPeers(file.path), null);
  assert.equal(wants(), 1);
  assert.equal(await swarm.fetchFromPeers(file.path), null);
  assert.equal(wants(), 1, "the second miss does not wait for the tracker again");
  // The coordinator announces itself (it started, or took over): ask again.
  deliver({ t: MSG.P2P_RESYNC, p: {}, to: ["me"] }, "gm");
  await tick();
  wantReply = () => ({ p: { peers: [], sha256: null, bytes: 0 } });
  assert.equal(await swarm.fetchFromPeers(file.path), null);
  assert.equal(wants(), 2);
});

test("swarm: on a device with little memory, large files are not fetched over P2P", async () => {
  settings.library["maps/huge.png"] = { status: "done", kind: "video", optimized: "maps/huge.of-000000ff.webm", bytes: 200 * MIB, sha256: "ab" };
  (await import("../scripts/library.mjs")).indexLibrary();
  const before = wants();
  navigator.deviceMemory = 4;
  assert.equal(await swarm.fetchFromPeers("maps/huge.of-000000ff.webm"), null);
  assert.equal(wants(), before, "over the 128 MB cap: the tracker is not even asked");
  navigator.deviceMemory = 8;
  assert.equal(await swarm.fetchFromPeers("maps/huge.of-000000ff.webm"), null);
  assert.equal(wants(), before + 1);
});

test("swarm: when an urgent load starts, a background download takes the rest of its file from the host", async () => {
  const file = addFile("background", 2 * MIB + 100_000, 21);
  (await import("../scripts/library.mjs")).indexLibrary();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/background.png"].sha256, bytes: file.size } });
  seeder.requests.length = 0;
  seeder.answer = req => (req.start === 0 ? pieceOf(file, req) : null); // the first piece arrives, the others never do
  const calls = [];
  hostServing(file, calls);
  let pings = 0;

  const pending = swarm.fetchFromPeers(`${ORIGIN}/${file.path}`, { onProgress: () => { pings++; } });
  await until(() => seeder.requests.length === 3); // piece 0 delivered, pieces 1 and 2 asked and silent
  await tick(20);
  assert.equal(calls.length, 0, "a background download waits for its peers");
  const pingsBefore = pings;

  const t0 = performance.now();
  fire("optimal-foundry.urgentLoad");
  const blob = await pending;
  assert.ok(performance.now() - t0 < 1000, "at once, not after the silent peer's timeout");
  assert.ok(blob, "the file is complete and passed the SHA-256 check");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file.data);
  assert.deepEqual(calls, [{ url: `${ORIGIN}/${file.path}`, range: `bytes=${MIB}-${file.size - 1}` }], "one Range request for what was missing");
  assert.ok(pings - pingsBefore >= 4, "the host fill reports progress chunk by chunk");
  assert.equal(seeder.requests.length, 3, "no further piece was asked from the peer");
  assert.equal(swarm.swarmStatus().fetchedFiles, 1);
});

test("swarm: an urgent download that crawls for two seconds finishes from the host", async () => {
  const file = addFile("urgent", MIB + 10_000, 31);
  (await import("../scripts/library.mjs")).indexLibrary();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/urgent.png"].sha256, bytes: file.size } });
  seeder.requests.length = 0;
  seeder.answer = req => (req.start === MIB ? pieceOf(file, req) : null); // 10 KB arrive, the big piece never does
  const calls = [];
  hostServing(file, calls);

  const t0 = performance.now();
  const blob = await swarm.fetchFromPeers(file.path, { urgent: true });
  const took = performance.now() - t0;
  assert.ok(blob);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file.data);
  assert.deepEqual(calls.map(c => c.range), [`bytes=0-${MIB - 1}`]);
  assert.ok(took >= 1900 && took < 2900, `switched after the 2 s window, before the 3 s piece timeout (${Math.round(took)} ms)`);
});

test("swarm: a fast urgent download stays on its peer", async () => {
  const file = addFile("fast", 2 * MIB, 41);
  (await import("../scripts/library.mjs")).indexLibrary();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/fast.png"].sha256, bytes: file.size } });
  seeder.answer = req => pieceOf(file, req);
  const calls = [];
  hostServing(file, calls);
  const blob = await swarm.fetchFromPeers(file.path, { urgent: true });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file.data);
  assert.equal(calls.length, 0);
});

test("swarm: the coordinator knows who can seed and sums what players report", async () => {
  assert.equal(swarm.canSeed("p2"), false, "only the coordinator answers");
  assert.deepEqual(swarm.swarmOverview(), { sharing: 0, links: 0, upBytes: 0, downBytes: 0 });

  set("p2pParticipate", false); // this browser leaves the swarm, as a GM on the server's machine would
  game.user = Object.assign(users.get("gm"), { isActiveGM: true });
  const have = (from, p) => deliver({ t: MSG.P2P_HAVE, p, to: ["gm"] }, from);
  const stats = (from, p) => deliver({ t: MSG.P2P_STATS, p, to: ["gm"] }, from);

  assert.equal(swarm.canSeed("p2"), false, "a player that never announced cannot seed");
  have("p2", { add: [], drop: [], reset: true }); // an empty cache still announces: the browser is in the swarm
  have("p3", { add: ["maps/a.of-0000000a.webp"], drop: [], reset: true });
  stats("p2", { up: 1000, down: 200, peers: 1, rates: {} });
  stats("p3", { up: 200, down: 1000, peers: 1, rates: {} });
  await tick();
  assert.equal(swarm.canSeed("p2"), true);
  assert.equal(swarm.canSeed("p3"), true);
  assert.equal(swarm.canSeed("me"), false);
  assert.equal(swarm.holderCount("maps/a.of-0000000a.webp", "gm"), 1);
  assert.deepEqual(swarm.swarmOverview(), { sharing: 2, links: 1, upBytes: 1200, downBytes: 1200 });

  // A browser that leaves the swarm (opted out, lost its cache) says so: it holds nothing and seeds nothing.
  have("p3", { off: true });
  await tick();
  assert.equal(swarm.canSeed("p3"), false);
  assert.equal(swarm.holderCount("maps/a.of-0000000a.webp", "gm"), 0);
  assert.equal(swarm.swarmOverview().sharing, 1);

  users.get("p2").active = false;
  assert.equal(swarm.canSeed("p2"), false, "a disconnected player cannot seed");
  assert.equal(swarm.swarmOverview().sharing, 0);
  users.get("p2").active = true;
});
