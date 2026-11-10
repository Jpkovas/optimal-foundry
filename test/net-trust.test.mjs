import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, file } from "./net-harness.mjs";

/**
 * What the coordinator believes of a player's own numbers. Bucket: 1,000,000 bytes/s, 2,000,000-byte burst, and
 * files of at most 4 MiB, which is also the deepest debt the bucket accepts.
 */
const files = "abcdefgh".split("").map(name => file(name, 0, 500_000));
const never = "maps/never.of-0123abcd.webp";
let w;

before(async () => {
  w = fakeFoundry({ files, settings: { preloadMaxFileMB: 4 }, players: ["u1", "u2", "u3"] });
  await startNetwork();
  w.tick(10_000);
});

test("trust: a player that stays busy for 75 s no longer pauses everyone else", async () => {
  const all = files.map(f => f.src);
  await w.status("u1");
  await w.status("u2", { urgent: 1 });
  const paused = await w.next("u1", { have: all.slice(1) });
  assert.deepEqual(paused, { items: [], waitMs: 1500, total: 8, done: 7 });

  for (let s = 0; s < 74; s += 2) { w.tick(2000); await w.status("u2", { urgent: 1 }); }
  assert.equal((await w.next("u1")).items.length, 0, "74 s in, still believed");
  w.tick(2000);
  await w.status("u2", { sceneReady: false }); // busy in another way: the streak continues
  assert.equal((await w.next("u1")).items.length, 1, "76 s of busy without a break: ignored");

  // One report that is not busy and the next streak counts again.
  await w.status("u2");
  await w.status("u2", { urgent: 2 });
  assert.equal((await w.next("u1", { have: all.slice(2) })).items.length, 0);
});

test("trust: a batch settles against what the coordinator charged, and the debt is clamped", async () => {
  w.tick(20_000); // u2's last report is stale, the bucket is full
  await w.status("u1");
  const res = await w.next("u1", { have: [] });
  assert.equal(res.items.length, 4, "2 MB of tokens, four 500 KB files");

  // A file the player was never handed is ignored, whatever it claims.
  await w.done("u1", [{ src: never, ok: true, bytes: 5e9, est: 0 }]);
  // A wrong number for one it was handed counts as the largest file preloading accepts (4 MiB), not 5 GB.
  await w.done("u1", [
    { src: res.items[0].src, ok: true, bytes: 5e9 },
    ...res.items.slice(1).map(it => ({ src: it.src, ok: true, bytes: it.bytes }))
  ]);
  const refused = await w.next("u1");
  assert.deepEqual(refused.items, []);
  // The bucket owes 4 MiB - 500 KB; the next 500 KB file is affordable 4.2 s later instead of 83 minutes.
  w.tick(4200);
  assert.equal((await w.next("u1")).items.length, 1);
});

test("trust: each handed file settles once, and never for more than it was charged", async () => {
  w.tick(20_000);
  await w.status("u3");
  const res = await w.next("u3", { have: files.slice(3).map(f => f.src) });
  assert.equal(res.items.length, 3, "a, b, c: 1.5 MB of the 2 MB");
  // Aborted before a byte moved: the charge comes back. Sending it again, or claiming a huge refund, adds nothing.
  const aborted = { src: res.items[0].src, ok: false, aborted: true, bytes: 0, est: 5e9 };
  await w.done("u3", [aborted]);
  await w.done("u3", [aborted]);
  await w.done("u3", [{ ...aborted, bytes: -5e9 }]);
  await w.status("u2");
  const other = await w.next("u2", { have: [] });
  assert.equal(other.items.length, 2, "1 MB of tokens: 500 KB left plus one refund of 500 KB");
});
