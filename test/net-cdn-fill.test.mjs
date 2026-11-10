import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork, file } from "./net-harness.mjs";

/**
 * The `cdn` profile. Only the first request for a file reaches the host (the edge fill): that handout is charged
 * and goes to one player; once it reports the file, the edge serves everyone else for free.
 * 8 Mbps of upload at the profile's 90% share = 900,000 bytes/s, so a 1,800,000-byte burst.
 */
const files = "abcdef".split("").map(name => file(name, 0, 600_000));
const extra = "gh".split("").map(name => file(name, 0, 600_000)); // for the last test only
const src = list => list.items.map(it => it.src);
/** What a player already holds: these files, and the two kept for the last test. */
const have = list => [...list, ...extra].map(f => f.src);
let w, scheduler, effectiveNetwork;

before(async () => {
  w = fakeFoundry({ files: [...files, ...extra], settings: { networkProfile: "cdn", p2pEnabled: true }, players: ["u1", "u2", "u3", "u4"] });
  ({ scheduler } = await startNetwork());
  ({ effectiveNetwork } = await import("../scripts/settings.mjs"));
  w.tick(10_000);
  for (const id of ["u1", "u2", "u3"]) await w.status(id);
});

test("cdn: the profile has a budget, sized by its share of the host upload", () => {
  const n = effectiveNetwork();
  assert.equal(n.profile, "cdn");
  assert.equal(n.preloadBytesPerSec, 900_000);
  assert.equal(n.p2p, false);
  assert.equal(scheduler.networkStatus().budget.ceilingBytesPerSec, 900_000);
});

test("cdn: the first handout of each file is charged and goes to one player", async () => {
  const a = await w.next("u1", { have: have([]) });
  assert.deepEqual(src(a), [files[0].src, files[1].src, files[2].src], "1.8 MB of tokens: three edge fills");

  // u2 is not handed the files u1 is pulling through the edge, and the bucket is empty for new fills.
  const b = await w.next("u2", { have: have([]) });
  assert.deepEqual(b.items, []);

  // u3 only misses those three: it waits for the edge, not for tokens.
  const c = await w.next("u3", { have: have(files.slice(3)) });
  assert.deepEqual(c, { items: [], waitMs: 2000, total: 8, done: 5 });
});

test("cdn: once the edge holds a file, every later handout is free", async () => {
  await w.fetched("u1", { items: files.slice(0, 3) });
  // No time passed: the bucket is still empty, yet u2 and u3 get the three files the edge now holds.
  const b = await w.next("u2");
  assert.deepEqual(src(b), [files[0].src, files[1].src, files[2].src]);
  const c = await w.next("u3");
  assert.deepEqual(src(c), [files[0].src, files[1].src, files[2].src]);
  // What they report for those is not settled against the bucket: after 0.7 s there is still only one fill's worth.
  await w.fetched("u2", b);
  w.tick(700);
  assert.deepEqual(src(await w.next("u2")), [files[3].src]);
});

test("cdn: an edge hit refunds the fill, a failed fill is handed out again", async () => {
  await w.fetched("u2", { items: [files[3]] }); // d is on the edge now
  w.tick(1300);                                 // 30 KB were left: now exactly two fills' worth
  const a = await w.next("u1");
  assert.deepEqual(src(a), [files[3].src, files[4].src, files[5].src], "d from the edge, e and f as fills");
  // The edge already had e (the page saw cf-cache-status HIT: no host bytes), and the download of f was aborted
  // before a byte moved. Both charges come back.
  await w.done("u1", [
    { src: files[3].src, ok: true, bytes: 600_000 },
    { src: files[4].src, ok: true, bytes: 0 },
    { src: files[5].src, ok: false, aborted: true, bytes: 0 }
  ]);
  const c = await w.next("u3", { have: have(files.slice(0, 5)) });
  assert.deepEqual(src(c), [files[5].src], "f is filled again, paid by the refunds");
  assert.deepEqual(src(await w.next("u2")), [files[4].src], "e is free for everyone; f is u3's fill now");
});

test("cdn: a player loading a scene pauses the fills, not what the edge already holds", async () => {
  await w.done("u3", [{ src: files[5].src, ok: false, aborted: true, bytes: 0 }]); // f is nobody's again
  w.tick(10_000);
  for (const id of ["u1", "u3"]) await w.status(id);
  await w.status("u2", { sceneReady: false });
  const a = await w.next("u1", { have: have(files.slice(0, 4)) });
  assert.deepEqual(src(a), [files[4].src], "e is on the edge; f would be a fill from the host");
  await w.status("u2");
  assert.deepEqual(src(await w.next("u1")), [files[4].src, files[5].src]);
});

test("cdn: a browser on a private address does not go through the edge: it is charged and fills nothing", async () => {
  w.tick(10_000);
  await w.status("u1");
  await w.status("u4", { publicOrigin: false }); // the same world over the LAN, or over a VPN
  const all = files.map(f => f.src);
  const lan = await w.next("u4", { have: all });
  assert.deepEqual(src(lan), [extra[0].src, extra[1].src], "1.2 MB of the 1.8 MB");
  await w.fetched("u4", lan);
  // For a player behind the CDN those two are still first handouts: charged, so only one fits what is left.
  assert.deepEqual(src(await w.next("u1", { have: all })), [extra[0].src]);
});
