import { test, before, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, file } from "./net-harness.mjs";

/** CDN detection as a GM reaching the world through a public hostname, and who counts as "on the server". */
let w, cdn;
let header = null; // the cf-cache-status the fake edge answers with
const moveTo = hostname => Object.assign(window.location, { hostname, origin: `https://${hostname}` });

before(async () => {
  w = fakeFoundry({ files: [file("map", 0, 100_000)], hostname: "one.trycloudflare.com" });
  mock.method(console, "log", () => {}); // every stored result is logged
  globalThis.fetch = async () => new Response(null, { status: 200, headers: header ? { "cf-cache-status": header } : {} });
  cdn = await import("../scripts/net/cdn.mjs");
});

test("cdn: only loopback is the server's own machine; private ranges are just not behind a public CDN", () => {
  for (const host of ["localhost", "foundry.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) {
    assert.equal(cdn.isLoopbackOrigin(host), true, host);
    assert.equal(cdn.isLocalOrigin(host), true, host);
  }
  // A LAN, or a VPN across the host's uplink (Tailscale's 100.64/10, ZeroTier on RFC 1918): charged like anyone.
  for (const host of ["192.168.1.10", "10.0.0.2", "172.16.4.1", "100.100.20.3", "gm-pc.local", "foundry"]) {
    assert.equal(cdn.isLoopbackOrigin(host), false, host);
    assert.equal(cdn.isLocalOrigin(host), true, host);
  }
  for (const host of ["play.example.com", "one.trycloudflare.com", "1270.0.0.1", "8.8.8.8"]) {
    assert.equal(cdn.isLoopbackOrigin(host), false, host);
    assert.equal(cdn.isLocalOrigin(host), false, host);
  }
});

test("cdn: the probe records Cloudflare, and the GM hears only when a CDN is found or lost", async () => {
  assert.equal(cdn.behindCloudflare(), false, "before the first probe");

  header = "DYNAMIC"; // a quick tunnel: Cloudflare, not caching
  await cdn.detectCdn();
  assert.deepEqual({ ...w.settings.cdnStatus, checkedAt: 0 },
    { cdn: false, status: "DYNAMIC", url: "maps/map.of-0123abcd.webp", cloudflare: true, origin: "https://one.trycloudflare.com", checkedAt: 0 });
  assert.equal(cdn.behindCloudflare(), true);
  assert.deepEqual(w.notices, [], "the first result is not news");

  // The tunnel restarts with a new hostname: stored, but nothing to tell.
  moveTo("two.trycloudflare.com");
  await cdn.detectCdn();
  assert.equal(w.settings.cdnStatus.origin, "https://two.trycloudflare.com");
  assert.deepEqual(w.notices, []);

  // A caching CDN appears.
  header = "MISS";
  await cdn.detectCdn();
  assert.equal(w.settings.cdnStatus.cdn, true);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0][1], /Cdn\.Found/);

  // Another header value, another hostname: still a caching CDN.
  header = "HIT";
  moveTo("play.example.com");
  await cdn.detectCdn();
  assert.equal(w.settings.cdnStatus.status, "HIT");
  assert.equal(w.notices.length, 1);

  // No header at all: the CDN is gone, and so is Cloudflare.
  header = null;
  await cdn.detectCdn();
  assert.equal(w.settings.cdnStatus.cdn, false);
  assert.equal(cdn.behindCloudflare(), false);
  assert.equal(w.notices.length, 2);
  assert.match(w.notices[1][1], /Cdn\.NotFound/);
});
