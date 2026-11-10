import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, settle } from "./net-harness.mjs";

/**
 * A player's browser: what it reports to the coordinator, when, and how its own preloads give way to the game.
 * It reaches the server at a private address (a LAN or a VPN), and this device's `preloadScope` starts "off".
 */
let w, scheduler;
const statuses = () => w.sent.filter(s => s.msg.t === "net.status").map(s => s.msg);
const asks = () => w.sent.filter(s => s.msg.t === "net.preloadNext").map(s => s.msg);
const urgentHooks = () => w.called.filter(name => name === "optimal-foundry.urgentLoad").length;
/** A load the test finishes by hand. */
function pending() {
  let finish;
  const promise = new Promise(resolve => { finish = resolve; });
  return { promise, finish };
}

before(async () => {
  w = fakeFoundry({ self: "u1", hostname: "192.168.1.20", settings: { staggerJoin: true, preloadScope: "off" } });
  ({ scheduler } = await startNetwork());
});

test("client: a queued joiner waits at most 30 s after the GM's last word", async () => {
  w.fire("setup");
  assert.equal(scheduler.networkStatus().joinTurn, false);
  assert.equal(statuses().at(-1).p.joining, true, "it announces itself");

  // Third in the queue, a minute and a half to go by the GM's estimate.
  await w.deliver("net.joinTurn", { go: false, position: 3, etaMs: 100_000 }, "gm");
  w.tick(20_000);
  await w.deliver("net.joinTurn", { go: false, position: 2, etaMs: 100_000 }, "gm"); // a fresh word moves the deadline
  w.tick(29_000);
  assert.equal(scheduler.networkStatus().joinTurn, false, "49 s in, 29 s after the last message");
  w.tick(1_500); // the GM went away
  assert.equal(scheduler.networkStatus().joinTurn, true);
});

test("client: the status report says where this browser is and what it can do", async () => {
  w.fire("ready");
  const report = statuses().at(-1);
  assert.deepEqual(report.to, ["gm"]);
  assert.ok(report.rid, "a request: the coordinator's answer is timed");
  const { local, publicOrigin, secure, cache, p2p, joining } = report.p;
  // A private address is not the server's own machine (it is charged), and it cannot see a public CDN.
  assert.deepEqual({ local, publicOrigin, secure, cache, p2p, joining },
    { local: false, publicOrigin: false, secure: true, cache: false, p2p: false, joining: false });
});

test("client: each report carries the round trip of the one before", async () => {
  const sentAt = statuses().at(-1);
  assert.equal(sentAt.p.rttMs, null, "nothing measured yet");
  w.tick(120);
  await w.deliver(undefined, true, "gm", { re: sentAt.rid }); // the coordinator's answer
  w.tick(1880);                                               // the timed report, 2 s after the last one
  const next = statuses().at(-1);
  assert.notEqual(next.rid, sentAt.rid);
  assert.equal(next.p.rttMs, 120);

  // No answer within 5 s is a round trip at least that slow.
  w.tick(5000);
  await settle();
  w.tick(2000);
  assert.equal(statuses().at(-1).p.rttMs, 5000);
});

test("client: an urgent load is reported at once, fires the hook once, and its end is reported when things settle", async () => {
  w.tick(10_000);
  const before = statuses().length;
  const hooks = urgentHooks();
  const first = pending(), second = pending();
  const a = scheduler.schedule(() => first.promise, { priority: "urgent" });
  assert.equal(urgentHooks(), hooks + 1, "0 -> 1 fires optimal-foundry.urgentLoad");
  assert.equal(statuses().length, before + 1, "and a status report, without waiting for the timer");
  assert.equal(statuses().at(-1).p.urgent, 1);

  const b = scheduler.schedule(() => second.promise, { priority: "urgent" });
  assert.equal(urgentHooks(), hooks + 1, "1 -> 2 is not a start");
  assert.equal(statuses().length, before + 1);

  first.finish();
  second.finish();
  await Promise.all([a, b]);
  assert.equal(statuses().length, before + 1, "not yet: another load may follow");
  w.tick(300);
  assert.equal(statuses().length, before + 2);
  assert.equal(statuses().at(-1).p.urgent, 0);

  await scheduler.schedule(async () => {}, { priority: "urgent" });
  assert.equal(urgentHooks(), hooks + 2, "back at 0, the next load is a start again");
});

test("client: an urgent load aborts a running preload even when a Service Worker controls the page", async () => {
  const told = []; // what the page tells its Service Worker
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { serviceWorker: { controller: { postMessage: message => told.push(message) }, addEventListener() {} } } });
  w.tick(10_000); // idle again
  const run = (url, total, received) => {
    const hold = pending();
    const result = scheduler.schedule(ctx => {
      Object.assign(ctx.progress, { total, received });
      return Promise.race([hold.promise, new Promise((_, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)))]);
    }, { priority: "preload", url }).then(() => "kept", err => err.name);
    return { result, finish: hold.finish };
  };
  const early = run("https://192.168.1.20/maps/a.of-0123abcd.webp", 1000, 100);
  const late = run("https://192.168.1.20/maps/b.of-0123abcd.webp", 1000, 600);
  await settle();
  assert.equal(scheduler.networkStatus().preloading, 2);

  await scheduler.schedule(async () => {}, { priority: "urgent" });
  const outcome = await Promise.race([early.result, settle().then(() => "still running")]);
  assert.equal(outcome, "AbortError", "an optimized file is no longer exempt");
  late.finish();
  assert.equal(await late.result, "kept", "past half of its bytes, it finishes");
  // The worker downloads on its own behalf: it is told to stop the same file, and only that one.
  assert.equal(told.length, 1);
  assert.match(JSON.stringify(told[0]), /maps\/a\.of-0123abcd\.webp/);
  assert.doesNotMatch(JSON.stringify(told[0]), /maps\/b\.of-0123abcd\.webp/);
});

test("client: a video still buffering counts as activity", async () => {
  const video = { networkState: 2, readyState: 2 }; // loading, not enough data to keep playing
  globalThis.canvas.primary = { videoMeshes: new Set([{ sourceElement: video }]) };
  w.tick(10_000);
  assert.equal(scheduler.networkStatus().idle, false);
  video.readyState = 4;
  w.tick(4000);
  assert.equal(scheduler.networkStatus().idle, false, "idle only 5 s after the last activity");
  w.tick(1500);
  assert.equal(scheduler.networkStatus().idle, true);
});

test("client: preloadScope decides whether this browser preloads, and whether it takes the last tier", async () => {
  await settle();
  w.tick(30_000);
  await settle();
  assert.equal(asks().length, 0, '"off": it never asks for a batch');

  const answer = async () => {
    const ask = asks().at(-1);
    await w.deliver(undefined, { items: [], waitMs: 30_000, total: 0, done: 0 }, "gm", { re: ask.rid });
    return ask.p;
  };
  const change = async scope => {
    w.settings.preloadScope = scope;
    w.fire("optimal-foundry.settingChanged", "preloadScope");
    await settle();
    w.tick(1000); // the idle window opens on the manager's tick
    await settle();
  };
  await change("session");
  assert.equal(asks().length, 1);
  assert.equal((await answer()).full, true, '"session": without the last tier');

  await change("all");
  assert.equal(asks().length, 2);
  assert.equal((await answer()).full, undefined, '"all": everything');
});
