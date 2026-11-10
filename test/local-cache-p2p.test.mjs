import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installBrowser, ORIGIN, bytes, tick, until, body, fileResponse } from "./cache-fakes.mjs";

/**
 * The local cache with the real swarm (scripts/p2p/swarm.mjs) behind it: a miss asks the other players, a file
 * that came from them is stored and reported as "p2p", a silent peer ends in the network, the swarm is told what is
 * kept and evicted, and what the swarm serves is read from the cache. The remote player is scripted: its side of
 * the data channel is `seeder.respond`. State carries over between the tests, in order.
 */
const b = installBrowser({
  settings: {
    p2pEnabled: true, networkProfile: "auto", cdnStatus: {}, p2pParticipate: true, connectionChoiceDone: true,
    hostUploadMbps: 20, preloadSharePct: 60, maxConcurrentRequests: 150, staggerJoin: true, idleSeconds: 5,
    preloadMaxFileMB: 100, p2pTimeoutSec: 8, cacheQuotaMB: 4096, p2pMinFileKB: 0, iceServers: "", p2pUploadCapMbps: 400,
    library: {}
  }
});
const settings = b.settings;
const users = new Map(["gm", "me", "p2"].map(id => [id, { id, name: id, isGM: id === "gm", active: true }]));
const sent = [];
let deliver = null;
let wantReply = () => ({ p: { peers: [], sha256: null, bytes: 0 } });

const seeder = { requests: [], respond: null, channels: [], uploads: [] };
class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  constructor() { seeder.channels.push(this); }
  send(data) {
    if (typeof data !== "string") return seeder.uploads.push(data);
    const msg = JSON.parse(data);
    if (msg.op === "ping") return this.receive(JSON.stringify({ op: "pong", t: msg.t }));
    if (msg.op === "end") seeder.uploads.push(msg);
    if (msg.op !== "req") return;
    seeder.requests.push(msg);
    seeder.respond?.(msg, this);
  }
  receive(data) { setTimeout(() => this.onmessage?.({ data }), 0); }
  close() { this.readyState = "closed"; }
}
class FakePeerConnection {
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
/** Send `data` for a piece request, in `chunks` parts `gap` ms apart. */
function sendPiece(channel, req, data, { chunks = 1, gap = 0 } = {}) {
  const part = Math.ceil(data.length / chunks);
  for (let i = 0; i < chunks; i++) {
    setTimeout(() => {
      const piece = data.subarray(i * part, (i + 1) * part);
      const packet = new Uint8Array(8 + piece.length);
      new DataView(packet.buffer).setUint32(0, req.rid);
      new DataView(packet.buffer).setUint32(4, i * part);
      packet.set(piece, 8);
      channel.onmessage?.({ data: packet.buffer });
      if (i === chunks - 1) channel.onmessage?.({ data: JSON.stringify({ op: "end", rid: req.rid }) });
    }, i * gap);
  }
}

function addFile(name, size, seed) {
  const data = bytes(size, seed);
  const path = `maps/${name}.of-${String(seed).padStart(8, "0")}.webp`;
  settings.library[`maps/${name}.png`] = { status: "done", kind: "image", optimized: path, bytes: size,
    sha256: createHash("sha256").update(data).digest("hex") };
  return { path, data, size, url: `${ORIGIN}/${path}` };
}
const wants = () => sent.filter(m => m.t === "p2p.want").length;
const announced = kind => sent.filter(m => m.t === "p2p.have").flatMap(m => m.p[kind] ?? []);

Object.assign(globalThis, {
  window: globalThis,
  RTCPeerConnection: FakePeerConnection,
  game: {
    user: users.get("me"),
    users: { get: id => users.get(id) ?? null, get activeGM() { return users.get("gm"); } },
    settings: { get: (_ns, key) => settings[key] },
    socket: {
      on: (name, fn) => { if (String(name).startsWith("module.")) deliver = fn; },
      emit: (_name, msg) => {
        sent.push(msg);
        if (msg.t === "p2p.want") setTimeout(() => deliver({ re: msg.rid, to: ["me"], ...wantReply(msg) }, "gm"), 0);
      }
    }
  }
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); t.unref(); return t; };

const { installLocalCache, startLocalCache, readyLocalCache, fetchMedia, cacheStatus, clearDeviceCache } = await import("../scripts/net/local-cache.mjs");
const socket = await import("../scripts/socket.mjs");
const swarm = await import("../scripts/p2p/swarm.mjs");
const library = await import("../scripts/library.mjs");
installLocalCache();
startLocalCache();
await readyLocalCache();
socket.initSocket();
swarm.initSwarm();
after(() => { settings.p2pEnabled = false; Hooks.callAll("optimal-foundry.settingChanged", "p2pEnabled", false); b.restore(); });

const reindex = () => library.indexLibrary();

test("local cache + swarm: the swarm follows the local cache", async () => {
  assert.equal(swarm.swarmStatus().enabled, true);
  assert.equal(cacheStatus().active, true);
});

test("local cache + swarm: while the game waits, only open peers are asked; a preload may wait for new ones", async () => {
  const file = addFile("urgent", 4096, 17);
  reindex();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/urgent.png"].sha256, bytes: file.size } });
  b.server.handler = async () => fileResponse(file.data);

  globalThis.canvas = { loading: true };
  const game = await fetchMedia(file.url);
  assert.equal(game.source, "net", "the scene is drawing: no link is open yet, so no P2P attempt, no wait");
  assert.equal(wants(), 0, "the tracker was not even asked");
  await body(game.response);
  await until(() => b.stored().includes(file.url));

  const other = addFile("urgent2", 4096, 18);
  reindex();
  b.server.handler = async () => fileResponse(other.data);
  seeder.respond = () => {}; // silent
  settings.p2pTimeoutSec = 0.05;
  const preload = await fetchMedia(other.url, { preload: true });
  assert.equal(wants(), 1, "a preload is background work even while a scene draws: it asks");
  assert.equal(preload.source, "net");
  await body(preload.response);
  globalThis.canvas = { loading: false };
});

test("local cache + swarm: a file from other players is stored, reported as p2p, and announced", async () => {
  const file = addFile("shared", 300_000, 21);
  reindex();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/shared.png"].sha256, bytes: file.size } });
  settings.p2pTimeoutSec = 8;
  seeder.respond = (req, channel) => sendPiece(channel, req, file.data.subarray(req.start, req.end));
  b.server.calls.length = 0;
  b.server.handler = async () => fileResponse(file.data);

  const got = await fetchMedia(file.url, { preload: true });
  assert.equal(got.source, "p2p");
  assert.equal(got.edge, null);
  assert.deepEqual(await body(got.response), file.data);
  assert.equal(b.server.calls.length, 0, "it cost the server nothing");
  await until(() => b.idb.entries.has(file.url), "stored");
  assert.ok(b.stored().includes(file.url));
  assert.equal(swarm.swarmStatus().fetchedFiles, 1);

  await until(() => announced("add").includes(file.path), "announced to the tracker");
  const again = await fetchMedia(file.url);
  assert.equal(again.source, "cache");
  assert.equal(b.server.calls.length, 0);
});

test("local cache + swarm: the inactivity timeout is p2pTimeoutSec, and progress starts it over", async () => {
  // Slow but steady: three chunks 80 ms apart, longer than the 120 ms timeout in all, never silent for 120 ms.
  const slow = addFile("steady", 300_000, 31);
  reindex();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/steady.png"].sha256, bytes: slow.size } });
  settings.p2pTimeoutSec = 0.12;
  seeder.respond = (req, channel) => sendPiece(channel, req, slow.data.subarray(req.start, req.end), { chunks: 4, gap: 80 });
  b.server.calls.length = 0;
  b.server.handler = async () => fileResponse(slow.data);
  const steady = await fetchMedia(slow.url, { preload: true });
  assert.equal(steady.source, "p2p", "progress kept it alive past the timeout");
  await body(steady.response);
  assert.equal(b.server.calls.length, 0);

  // A silent peer: the timeout fires and the network answers.
  const mute = addFile("mute", 300_000, 41);
  reindex();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/mute.png"].sha256, bytes: mute.size } });
  settings.p2pTimeoutSec = 0.2;
  seeder.respond = () => {};
  b.server.handler = async () => fileResponse(mute.data);
  const t0 = performance.now();
  const net = await fetchMedia(mute.url, { preload: true });
  assert.ok(performance.now() - t0 < 2000, "well before the piece timeout");
  assert.equal(net.source, "net");
  assert.deepEqual(await body(net.response), mute.data);
  assert.equal(b.server.calls.length, 1);
  await until(() => b.stored().includes(mute.url));
  settings.p2pTimeoutSec = 8;
});

test("local cache + swarm: the swarm is told about evictions, and serves what the cache holds", async () => {
  // Seeding reads the kept file through the cache.
  const shared = `${ORIGIN}/maps/shared.of-00000021.webp`;
  const channel = seeder.channels.at(-1);
  seeder.uploads.length = 0;
  channel.onmessage({ data: JSON.stringify({ op: "req", rid: 9, path: "maps/shared.of-00000021.webp", start: 0, end: 100_000 }) });
  await until(() => seeder.uploads.some(u => u.op === "end"), "served");
  const packets = seeder.uploads.filter(u => u.op !== "end");
  const out = new Uint8Array(100_000);
  for (const p of packets) {
    const view = new DataView(p.buffer, p.byteOffset);
    out.set(new Uint8Array(p.buffer, p.byteOffset + 8, p.byteLength - 8), view.getUint32(4));
  }
  assert.deepEqual(out, bytes(300_000, 21).subarray(0, 100_000));
  assert.ok(b.stored().includes(shared));

  // Eviction: shrink the quota under what is kept; the oldest optimized files are dropped and announced.
  const before = announced("drop").length;
  settings.cacheQuotaMB = 400_000 / 1_048_576;
  Hooks.callAll("optimal-foundry.settingChanged", "cacheQuotaMB", settings.cacheQuotaMB);
  await until(() => announced("drop").length > before, "eviction announced");
  const dropped = announced("drop");
  assert.ok(dropped.every(p => /\.of-[0-9a-f]{8}\./.test(p)));
  for (const path of dropped) assert.equal(b.stored().includes(`${ORIGIN}/${path}`), false);

  // Clearing tells the swarm about everything that was left.
  const left = (await import("../scripts/net/local-cache.mjs")).cachedOptimizedPaths;
  const remaining = await left();
  const dropsBefore = announced("drop").length;
  await clearDeviceCache();
  if (remaining.length) await until(() => announced("drop").length >= dropsBefore + remaining.length, "clear announced");
  for (const path of remaining) assert.ok(announced("drop").includes(path));
  await tick(5);
});

test("local cache + swarm: the preloader counts a file from other players as free for the host", async () => {
  const { warm } = await import("../scripts/net/preload.mjs");
  const file = addFile("free", 200_000, 51);
  reindex();
  wantReply = () => ({ p: { peers: ["p2"], sha256: settings.library["maps/free.png"].sha256, bytes: file.size } });
  settings.p2pTimeoutSec = 8;
  seeder.respond = (req, channel) => sendPiece(channel, req, file.data.subarray(req.start, req.end));
  b.server.calls.length = 0;
  const progress = { total: 0, received: 0 };
  assert.deepEqual(await warm(file.url, undefined, undefined, progress), { ok: true, bytes: 0 });
  assert.equal(progress.offHost, true);
  assert.equal(progress.received, file.size);
  assert.equal(b.server.calls.length, 0);
});
