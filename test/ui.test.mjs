import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatMbps, playerHealth, upcomingScene, readyCue } from "../scripts/ui/format.mjs";

/** The pure helpers of the UI: units on screen, a player's health, and the "everyone is ready" cue. */

test("units: sizes are binary and labelled KB/MB/GB, like the size settings", () => {
  assert.equal(formatBytes(4096 * 1_048_576, "en"), "4 GB", "the 4096 MB cache quota");
  assert.equal(formatBytes(100 * 1_048_576, "en"), "100 MB", "the 100 MB preload limit");
  assert.equal(formatBytes(512 * 1024, "en"), "512 KB", "the 512 KB sharing floor");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(0, "en"), "0 B");
  assert.equal(formatBytes(1023, "en"), "1,023 B");
  assert.equal(formatBytes(1024 * 1024 - 1, "en"), "1 MB", "never 1,024 KB");
  assert.equal(formatBytes(1.5 * 1_048_576, "pt-BR"), "1,5 MB", "the game's number format");
  for (const bad of [NaN, -1, Infinity, undefined]) assert.equal(formatBytes(bad, "en"), "—");
});

test("units: rates are megabits per second, like the speed settings", () => {
  assert.equal(formatMbps(20 * 125_000, "en"), "20 Mbps", "hostUploadMbps = 20");
  assert.equal(formatMbps(4 * 125_000, "en"), "4 Mbps", "p2pUploadCapMbps = 4");
  assert.equal(formatMbps(20 * 125_000 * 0.6, "en"), "12 Mbps", "60% of the upload for preloading");
  assert.equal(formatMbps(187_500, "en"), "1.5 Mbps");
  assert.equal(formatMbps(50_000, "en"), "0.4 Mbps");
  assert.equal(formatMbps(5_000, "en"), "0.04 Mbps");
  assert.equal(formatMbps(0, "en"), "0 Mbps");
  assert.equal(formatMbps(Infinity, "en"), "∞", "an unlimited profile");
  for (const bad of [NaN, -1, undefined]) assert.equal(formatMbps(bad, "en"), "—");
});

test("player health: the first thing that keeps a browser from sharing", () => {
  assert.deepEqual(playerHealth({ secure: true, cache: true, p2p: true }),
    { known: true, secure: true, cache: true, share: true, blocker: null });
  assert.equal(playerHealth({ secure: false, cache: false, p2p: false }).blocker, "https", "plain HTTP comes first");
  assert.equal(playerHealth({ secure: true, cache: false, p2p: false }).blocker, "cache");
  assert.equal(playerHealth({ secure: true, cache: true, p2p: false, local: true }).blocker, "local");
  assert.equal(playerHealth({ secure: true, cache: true, p2p: false }).blocker, "choice", "turned off, or not chosen yet");
  // A status from before the browser reported these fields is unknown, never "no".
  for (const old of [undefined, {}, { inflight: 0, p2p: { up: 1, down: 2, peers: 1 } }]) {
    assert.deepEqual(playerHealth(old), { known: false, secure: false, cache: false, share: false, blocker: null });
  }
});

const PLAN = [
  { type: "scene", id: "view", name: "Tavern", tier: 0, reason: "playerViewing" },
  { type: "scene", id: "act", name: "Road", tier: 1, reason: "active" },
  { type: "playlist", id: "pl", name: "Music", tier: 1, reason: "active" },
  { type: "scene", id: "next", name: "Cave", tier: 1, reason: "navigation" },
  { type: "scene", id: "far", name: "Castle", tier: 2, reason: "navigationBar" }
];

test("ready cue: the scene it names is the first one not on screen yet", () => {
  assert.deepEqual(upcomingScene(PLAN), { id: "next", name: "Cave" });
  assert.deepEqual(upcomingScene([{ type: "scene", id: "m", name: "Boss", tier: 0, reason: "marked" }, ...PLAN]), { id: "m", name: "Boss" });
  assert.equal(upcomingScene(PLAN.slice(0, 3)), null, "only what is on screen");
  assert.equal(upcomingScene([PLAN[4]]), null, "a scene of a later tier is not what the readiness covers");
  assert.equal(upcomingScene(undefined), null);
});

test("ready cue: once per scene, only when every connected player is ready", () => {
  const announced = new Set();
  const cave = { id: "next", name: "Cave" };
  assert.equal(readyCue([{ ready: true }, { ready: false }], cave, announced), null, "one player still downloading");
  assert.equal(readyCue([], cave, announced), null, "nobody connected");
  assert.equal(readyCue([{ ready: true }], null, announced), null, "nothing comes next");
  assert.deepEqual(readyCue([{ ready: true }, { ready: true }], cave, announced), cave);
  assert.equal(readyCue([{ ready: true }, { ready: true }], cave, announced), null, "not repeated");
  // The queue rebuilt and filled again: still the same scene, still no second notice.
  assert.equal(readyCue([{ ready: false }], cave, announced), null);
  assert.equal(readyCue([{ ready: true }], cave, announced), null);
  assert.deepEqual(readyCue([{ ready: true }], { id: "m", name: "Boss" }, announced), { id: "m", name: "Boss" }, "another scene is announced");
});

/* -------------------------------------------- */
/*  The live window, under a stubbed Foundry    */
/* -------------------------------------------- */

/** What LiveApplication needs from ApplicationV2, recording each render's parts. */
class StubApplication {
  rendered = true;
  minimized = false;
  renders = [];
  listeners = {};
  element = { contains: el => el === this.focused, addEventListener: (type, fn) => { this.listeners[type] = fn; } };
  get id() { return "stub"; }
  async render(options) { this.renders.push(options.parts.join()); }
  async _onFirstRender() {}
  _onClose() {}
}

async function liveApplication() {
  globalThis.foundry = {
    applications: { api: { ApplicationV2: StubApplication, HandlebarsApplicationMixin: Base => Base }, instances: new Map() },
    utils: {}
  };
  globalThis.Hooks = { on: () => 1, once: () => 1, off() {}, callAll() {} };
  globalThis.game = { i18n: { lang: "en" }, modules: new Map(), settings: { get: () => undefined } };
  globalThis.window = globalThis;
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.location ??= { hostname: "example.com", origin: "https://example.com" };
  globalThis.document = { hidden: false, activeElement: null };
  const { LiveApplication } = await import("../scripts/ui/common.mjs");
  return class extends LiveApplication {
    static PARTS = { body: {} };
    _refreshParts(force) { return [force ? "forced" : "timer"]; }
  };
}

test("live window: a refresh asked by a hook waits while the user is editing, then runs once", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const App = await liveApplication();
  const app = new App();
  await app._onFirstRender({}, {});
  const settle = () => new Promise(resolve => setImmediate(resolve));

  // Nobody is editing: the hook's refresh runs at once.
  app._refreshWhenIdle(true);
  await settle();
  assert.deepEqual(app.renders, ["forced"]);

  // A select of this window has the focus: two hooks fire, nothing is replaced under the user.
  app.focused = { matches: () => true };
  document.activeElement = app.focused;
  app._refreshWhenIdle(false);
  app._refreshWhenIdle(true);
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(app.renders, ["forced"], "neither the hooks nor the timer render while editing");

  // The focus leaves: one refresh, with the strongest of the flags that were held back.
  document.activeElement = null;
  app.listeners.focusout();
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(app.renders, ["forced", "forced"]);

  // Nothing is left over: the next tick is an ordinary periodic refresh.
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(app.renders, ["forced", "forced", "timer"]);

  // A pointer button held inside the window holds a hook's refresh back the same way, until the next tick.
  app.listeners.pointerdown();
  app._refreshWhenIdle(true);
  await settle();
  assert.equal(app.renders.length, 3);
  app._onClose({});
});
