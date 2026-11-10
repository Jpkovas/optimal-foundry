import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, file } from "./net-harness.mjs";

/**
 * Coordinated seeding, without a CDN and with sharing on: a file is reserved for its first fetcher only when that
 * browser can share it afterwards. Bucket: 1,000,000 bytes/s, 2,000,000-byte burst.
 */
const x = file("x", 0, 600_000);
const y = file("y", 0, 600_000);
const z = file("z", 0, 600_000);
let w, swarm;

/** The player's browser tells the tracker which optimized files it holds (what a sharing browser does). */
const announce = (from, add = []) => w.deliver("p2p.have", { add, drop: [], reset: true }, from);

before(async () => {
  w = fakeFoundry({ files: [x, y, z], settings: { p2pEnabled: true }, players: ["u1", "u2", "u3", "u4"] });
  ({ swarm } = await startNetwork({ swarm: true }));
  w.tick(10_000);
  for (const id of ["u1", "u2", "u3", "u4"]) await w.status(id);
});

test("seeding: nobody waits on a player whose browser never announces", async () => {
  assert.equal(swarm.canSeed("u1"), false);
  const a = await w.next("u1", { have: [z.src] });
  assert.deepEqual(a.items.map(it => it.src), [x.src, y.src]);

  // The second player gets the same file from the host at once (the bucket has 800 KB left: one file).
  const b = await w.next("u2", { have: [z.src] });
  assert.deepEqual(b.items.map(it => it.src), [x.src], "not held back for 2 minutes");

  // Even with tokens to spare, nothing is "reserved": a third player is turned away for tokens only, or served.
  w.tick(2000);
  const c = await w.next("u3", { have: [z.src] });
  assert.deepEqual(c.items.map(it => it.src), [x.src, y.src]);
});

test("seeding: a file is reserved for a player that can share, and the others who can share wait for it", async () => {
  w.tick(10_000);
  await announce("u1");
  await announce("u2");
  assert.equal(swarm.canSeed("u1"), true);
  const have = [x.src, y.src];
  const a = await w.next("u1", { have });
  assert.deepEqual(a.items.map(it => it.src), [z.src]);

  const b = await w.next("u2", { have });
  assert.deepEqual(b.items, [], "u2 will take it from u1");
  assert.equal(b.waitMs, 2000);

  // A player that cannot share would gain nothing by waiting: it fetches from the host.
  const c = await w.next("u3", { have });
  assert.deepEqual(c.items.map(it => it.src), [z.src]);
});

test("seeding: once the fetcher reports the file, the reservation lasts about 5 s more", async () => {
  await w.fetched("u1", { items: [{ src: z.src, bytes: z.bytes }] });
  w.tick(4000);
  assert.deepEqual((await w.next("u2")).items, [], "u1 has a few seconds to announce it");
  w.tick(1500);
  // No announcement came (its cache did not keep the file): u2 fetches it from the host instead of waiting on.
  assert.deepEqual((await w.next("u2")).items.map(it => it.src), [z.src]);
});

test("seeding: a file a seeder holds costs the bucket nothing, unless it comes from the host after all", async () => {
  await announce("u1", [z.src]);
  await announce("u4");
  await w.status("u3", { urgent: 1 }); // a remote player is loading: nothing that costs host upload is handed out
  const have = [x.src, y.src];
  const a = await w.next("u4", { have });
  assert.deepEqual(a.items.map(it => it.src), [z.src], "from the peer: free, even now");

  // The peer transfer failed and the Service Worker took it from the host: that is charged afterwards.
  await w.status("u3");
  w.tick(10_000);
  for (const id of ["u1", "u2", "u3", "u4"]) await w.status(id);
  await w.done("u4", [{ src: z.src, ok: true, bytes: z.bytes }]);
  const b = await w.next("u3", { have: [z.src] });
  assert.deepEqual(b.items.map(it => it.src), [x.src, y.src], "1.4 MB left of the 2 MB burst: two 600 KB files");
  assert.deepEqual((await w.next("u2", { have: [z.src] })).items, [], "200 KB left: not a third");
});

test("seeding: a reservation ends when its holder can no longer share", async () => {
  w.tick(10_000);
  for (const id of ["u1", "u2"]) await w.status(id);
  await announce("u1");
  await announce("u2");
  const a = await w.next("u1", { have: [y.src, z.src] });
  assert.deepEqual(a.items.map(it => it.src), [x.src]);
  assert.deepEqual((await w.next("u2", { have: [y.src, z.src] })).items, []);
  // u1 leaves: Foundry fires userConnected(false), the tracker forgets it.
  game.users.get("u1").active = false;
  w.fire("userConnected", game.users.get("u1"), false);
  assert.deepEqual((await w.next("u2")).items.map(it => it.src), [x.src]);
});
