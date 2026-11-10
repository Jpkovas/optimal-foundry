import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, file } from "./net-harness.mjs";

/**
 * The preload budget on the coordinator: a token bucket whose ceiling comes from the settings (here 8 Mbps at a
 * 100% share = 1,000,000 bytes/s, so a 2,000,000-byte burst) and whose rate follows the players' status round trips.
 */
const now = Array.from({ length: 8 }, (_, i) => file(`now${i}`, 0, 500_000));
const later = Array.from({ length: 60 }, (_, i) => file(`later${i}`, 3, 250_000));
let w, scheduler;
const budget = () => scheduler.networkStatus().budget;

/** Every second for `seconds`: each player reports its round trip, then the coordinator looks at the budget. */
async function report(seconds, rtt) {
  for (let s = 0; s < seconds; s++) {
    for (const [id, fields] of Object.entries(rtt)) await w.status(id, typeof fields === "number" ? { rttMs: fields } : fields);
    w.tick(1000);
    budget();
  }
}

before(async () => {
  w = fakeFoundry({ files: [...now, ...later], players: ["u1", "u2", "u3"] });
  ({ scheduler } = await startNetwork());
  w.tick(10_000); // the bucket starts empty and fills in two seconds
});

test("budget: a remote player is charged, a browser on the server's own machine is not", async () => {
  await w.status("u1");                    // somewhere on the internet (or a private address: also charged)
  await w.status("u2", { local: true });   // loopback
  const remote = await w.next("u1", { have: later.map(f => f.src) });
  assert.equal(remote.items.length, 4, "the 2 MB burst pays for four 500 KB files");
  assert.equal((await w.next("u1")).items.length, 0, "and then the bucket is empty");
  const local = await w.next("u2", { have: later.map(f => f.src) });
  assert.equal(local.items.length, 8, "loopback costs the host no upload: a full batch from an empty bucket");
});

test("budget: the rate starts at the ceiling, halves when most players' round trips rise, and recovers slowly", async () => {
  w.tick(10_000);
  assert.deepEqual(budget(), { rateBytesPerSec: 1_000_000, ceilingBytesPerSec: 1_000_000, slowed: false, rttMs: null });

  await report(5, { u1: 40, u2: 60 });
  assert.equal(budget().slowed, false);
  assert.equal(budget().rttMs, 60, "the median recent round trip");

  // One player's own slow link is not the host's uplink.
  await report(10, { u1: 400, u2: 60 });
  assert.equal(budget().slowed, false, "one of two players is not a majority");

  // Both well above twice their best plus 100 ms: the uplink is queueing. One step every 5 s.
  await report(5, { u1: 400, u2: 500 });
  assert.deepEqual(budget(), { rateBytesPerSec: 500_000, ceilingBytesPerSec: 1_000_000, slowed: true, rttMs: 500 });
  await report(10, { u1: 400, u2: 500 });
  assert.equal(budget().rateBytesPerSec, 125_000);
  await report(5, { u1: 400, u2: 500 });
  assert.equal(budget().rateBytesPerSec, 125_000, "never below an eighth of the ceiling");

  // Back to normal: a tenth of the ceiling every 5 s.
  await report(5, { u1: 45, u2: 70 });
  assert.equal(budget().rateBytesPerSec, 225_000);
  assert.equal(budget().slowed, true);
  await report(40, { u1: 45, u2: 70 });
  assert.deepEqual(budget(), { rateBytesPerSec: 1_000_000, ceilingBytesPerSec: 1_000_000, slowed: false, rttMs: 70 });
});

test("budget: a player on the server's own machine has no say about the uplink", async () => {
  await report(5, { u1: 40, u2: 60 });
  await report(15, { u1: 40, u2: { local: true, rttMs: 4000 } });
  assert.equal(budget().slowed, false);
  // Its earlier remote samples go stale; the only fresh reporter left is fine.
  assert.equal(budget().rttMs, 40);
});

test("budget: one player high out of one is a majority", async () => {
  w.tick(15_000); // every earlier report is stale
  await report(5, { u3: 30 });
  await report(10, { u3: 900 });
  assert.equal(budget().slowed, true);
  await report(60, { u3: 30 });
  assert.equal(budget().slowed, false);
});

test("budget: round trips measured while a player loads neither slow the budget nor let it recover", async () => {
  w.tick(15_000);
  await report(5, { u1: 40, u2: 60 });
  // u3 draws a scene: the game fills the uplink and everyone's round trip rises. That is not preloading's doing.
  await report(20, { u1: 600, u2: 700, u3: { sceneReady: false } });
  assert.equal(budget().slowed, false);
  // u3 is done. What the next reports carry was still measured during the load.
  await report(4, { u1: 600, u2: 700, u3: {} });
  assert.equal(budget().slowed, false);
  // Nobody loads and the round trips stay high: now it is the uplink.
  await report(10, { u1: 600, u2: 700, u3: {} });
  assert.equal(budget().slowed, true);

  // The rate does not climb back while a player loads, whatever the round trips say meanwhile.
  const held = budget().rateBytesPerSec;
  await report(15, { u1: 40, u2: 60, u3: { urgent: 1 } });
  assert.equal(budget().rateBytesPerSec, held);
  await report(60, { u1: 40, u2: 60, u3: {} });
  assert.equal(budget().slowed, false);
});

test("budget: the last tier gets at most half of the rate", async () => {
  w.tick(15_000);
  await w.status("u1");
  const have = now.map(f => f.src); // only "later" files are left for this player
  let handed = 0, elapsed = 0, first = true;
  while (elapsed < 20_000) {
    const res = await w.next("u1", first ? { have } : {});
    first = false;
    if (res.items.length) {
      assert.ok(res.items.every(it => it.tier === 3));
      handed += res.items.reduce((n, it) => n + it.bytes, 0);
      await w.fetched("u1", res);
    } else {
      w.tick(res.waitMs);
      elapsed += res.waitMs;
      await w.status("u1");
    }
  }
  // A full allowance to start with (one second of the rate), then half of 1,000,000 bytes/s for 20 s.
  assert.ok(handed <= 11_000_000, `handed ${handed}`);
  assert.ok(handed >= 9_500_000, `handed ${handed}`);
});
