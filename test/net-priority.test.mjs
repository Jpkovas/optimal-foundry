import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, file } from "./net-harness.mjs";

/**
 * Priority in the bucket (1,000,000 bytes/s, 2,000,000-byte burst). A 3 MB map of the first tier needs a full
 * bucket; other players' small files of the last tier must not keep taking the tokens from under it.
 */
const big = file("big", 0, 3_000_000);
const small = Array.from({ length: 40 }, (_, i) => file(`small${i}`, 3, 250_000));
let w;

before(async () => {
  w = fakeFoundry({ files: [big, ...small], players: ["u1", "u2", "u3"] });
  await startNetwork();
  w.tick(10_000);
  for (const id of ["u1", "u2", "u3"]) await w.status(id);
});

test("priority: a player refused for tokens on an early tier keeps later tiers away from the bucket", async () => {
  // u1 already holds the map and drains small files of the last tier.
  const first = await w.next("u1", { have: [big.src] });
  assert.equal(first.items.length, 4, "the last tier's allowance (half the burst) pays for four 250 KB files");
  await w.fetched("u1", first);

  // u2 needs the map next: 1 MB of tokens is left, the map waits for a full bucket.
  const refused = await w.next("u2", { have: [] });
  assert.deepEqual(refused.items, []);
  assert.equal(refused.waitMs, 1000, "one second until the bucket is full");

  // While that claim is live, u1 gets nothing of a later tier, however small.
  const blocked = await w.next("u1");
  assert.deepEqual(blocked.items, []);
  assert.equal(blocked.waitMs, 1500);

  w.tick(1000);
  const served = await w.next("u2");
  assert.deepEqual(served.items.map(it => it.src), [big.src], "the map arrives, alone");
});

test("priority: a claim nobody comes back for expires after 5 s", async () => {
  // The bucket is in debt after the map; u3 needs the map too and is refused.
  const refused = await w.next("u3", { have: [] });
  assert.deepEqual(refused.items, []);
  assert.equal((await w.next("u1")).waitMs, 1500, "u1 waits behind u3's claim");

  w.tick(5001); // u3 never asks again
  const res = await w.next("u1");
  assert.ok(res.items.length > 0, "the last tier flows again");
  assert.ok(res.items.every(it => it.tier === 3));
});

test("priority: players waiting on the same tier do not block each other", async () => {
  w.tick(10_000);
  const a = await w.next("u1", { have: [big.src] });
  await w.fetched("u1", a);
  // Both u1 and u2 want last-tier files; u2's refusal for tokens must not turn u1 away with the claim's wait.
  const b = await w.next("u2", { have: [big.src] });
  const c = await w.next("u1");
  assert.equal(b.items.length, 0);
  assert.equal(c.items.length, 0);
  assert.notEqual(c.waitMs, 1500, "u1 is short of tokens, not held back by a claim");
});
