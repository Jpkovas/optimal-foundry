import { mock } from "node:test";

/**
 * A fake Foundry for the network tests (test/net-*.test.mjs). This process is one browser: the coordinating GM by
 * default, or a player (`self`). Every other user exists only as messages delivered through the stubbed socket.
 * Time is a fake clock: Date, performance.now and the timers all move with `tick(ms)`.
 *
 * The world is one scene per tier holding the given files as tiles: tier 0 is a scene marked as "next", tier 1 a
 * scene on the include list, tier 3 any other scene.
 */

const T0 = 1_700_000_000_000;

/** An optimized file of the fake world, known to the library with its size. */
export const file = (name, tier, bytes) => ({ name, tier, bytes, src: `maps/${name}.of-0123abcd.webp` });

/** Let the socket's promise-based dispatch run. */
export const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {object} [options]
 * @param {object} [options.settings]   module settings over the defaults below
 * @param {object[]} [options.files]    `file()` entries
 * @param {string[]} [options.players]  connected non-GM user ids
 * @param {string} [options.self]       the user this browser belongs to (default "gm", the coordinator)
 * @param {string} [options.hostname]   where this browser reaches the server
 */
export function fakeFoundry({ settings = {}, files = [], players = ["u1", "u2"], self = "gm", hostname = "localhost" } = {}) {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: T0 });
  performance.now = () => Date.now();

  const coll = list => Object.assign(list, { get: id => list.find(d => d.id === id) ?? null, contents: list });
  const scene = (tier, list) => ({
    id: `s${tier}`, name: `tier ${tier}`, uuid: `Scene.s${tier}`, navigation: false, navOrder: 0, folder: null, sort: 0,
    playlist: null, playlistSound: null, active: false, regions: [], _stats: { modifiedTime: 0 }, levels: new Set(),
    tiles: list.map(f => ({ texture: { src: f.src } })), tokens: [], notes: [], drawings: [], walls: [], sounds: []
  });
  const tiers = [...new Set(files.map(f => f.tier))].sort();
  const scenes = coll(tiers.map(tier => scene(tier, files.filter(f => f.tier === tier))));
  scenes.active = null;

  const world = {
    sent: [],                 // every socket emit: {msg, args} (args = number of arguments, 2 for a broadcast)
    hooks: new Map(),         // hook name -> handlers
    called: [],               // Hooks.callAll names, in order
    notices: [],              // ui.notifications: [level, text]
    windowListeners: {},
    settings: {
      networkProfile: "custom", hostUploadMbps: 8, preloadSharePct: 100, maxConcurrentRequests: 150, staggerJoin: false,
      preloadEnabled: true, idleSeconds: 5, preloadMaxFileMB: 100, predecodeNext: false, preloadScope: "all",
      preloadInclude: tiers.includes(1) ? ["Scene.s1"] : [], preloadExclude: [], nextScenes: tiers.includes(0) ? ["s0"] : [],
      p2pEnabled: false, p2pParticipate: true, p2pMinFileKB: 0, p2pTimeoutSec: 8, iceServers: "", cacheQuotaMB: 4096,
      mediaEnabled: false, backfillMode: "off", backfillPaused: false, welcomeDone: true, reviewApproved: [],
      cdnStatus: {},
      library: Object.fromEntries(files.map(f => [`maps/${f.name}.png`,
        { status: "done", optimized: f.src, kind: "image", bytes: f.bytes, originalBytes: f.bytes * 4, sha256: "0".repeat(64) }])),
      ...settings
    }
  };

  const users = coll([{ id: "gm", name: "GM", isGM: true, active: true }, ...players.map(id => ({ id, name: id, isGM: false, active: true }))]);
  const me = users.get(self);
  me.isSelf = true;
  me.isActiveGM = self === "gm";
  users.activeGM = users.get("gm");

  const listeners = [];
  globalThis.window = {
    location: { hostname, origin: `https://${hostname}`, href: `https://${hostname}/game` },
    isSecureContext: true,
    addEventListener: (name, fn) => { world.windowListeners[name] = fn; }
  };
  globalThis.location = globalThis.window.location;
  globalThis.isSecureContext = true;
  globalThis.PerformanceObserver = undefined;
  globalThis.libWrapper = { register() {} };
  globalThis.PIXI = { Assets: { setPreferences() {} } };
  globalThis.CONST = {};
  globalThis.canvas = { scene: null, loading: false };
  globalThis.foundry = { utils: { deepClone: v => structuredClone(v), getRoute: p => `/${String(p).replace(/^\/+/, "")}` } };
  globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(l => [l, text => world.notices.push([l, text])])) };
  const hook = (name, fn) => { if (!world.hooks.has(name)) world.hooks.set(name, []); world.hooks.get(name).push(fn); };
  globalThis.Hooks = { on: hook, once: hook, callAll: (name, ...args) => { world.called.push(name); world.fire(name, ...args); } };
  globalThis.game = {
    world: { id: "w" },
    user: me,
    users,
    scenes,
    playlists: coll([]),
    actors: coll([]),
    journal: coll([]),
    i18n: { lang: "en", localize: key => key, format: (key, data) => `${key} ${JSON.stringify(data)}` },
    settings: {
      get: (_ns, key) => world.settings[key],
      set: async (_ns, key, value) => { world.settings[key] = value; return value; }
    },
    socket: {
      // Like the real socket, one listener list per event: only the module's own channel is delivered here.
      on: (name, fn) => { if (String(name).startsWith("module.")) listeners.push(fn); },
      emit: (...args) => world.sent.push({ msg: args[1], args: args.length })
    }
  };

  /** Run the handlers of a Foundry hook (e.g. "setup", "ready", "userConnected"). */
  world.fire = (name, ...args) => { for (const fn of world.hooks.get(name) ?? []) fn(...args); };
  /** Move the fake clock. */
  world.tick = ms => mock.timers.tick(ms);
  /** A socket message from another user arrives. */
  world.deliver = async (t, p, from, extra = {}) => {
    for (const fn of listeners) fn({ t, p, from, ...extra }, from);
    await settle();
  };
  /** A socket request from another user: resolves with this browser's answer (undefined when it sent none). */
  let seq = 0;
  world.ask = async (t, p, from) => {
    const rid = `test.${++seq}`;
    await world.deliver(t, p, from, { rid });
    return world.sent.findLast(s => s.msg.re === rid)?.msg.p;
  };
  /** A player's status report as the coordinator receives it: scene drawn, idle, on the world's public hostname. */
  world.status = (from, fields = {}) => world.deliver("net.status",
    { sceneReady: true, idle: true, urgent: 0, joining: false, local: false, publicOrigin: true, ...fields }, from);
  /** A player asks for its next preload batch. `have` lists what it already holds (needed on its first ask). */
  world.next = (from, payload = {}) => world.ask("net.preloadNext", payload, from);
  /** A player reports a finished batch. */
  world.done = (from, results) => world.deliver("net.preloadDone", { results }, from);
  /** Everything the batch handed out came from the host in full. */
  world.fetched = (from, res) => world.done(from, res.items.map(it => ({ src: it.src, ok: true, bytes: it.bytes })));
  return world;
}

/**
 * Start the network modules the way main.mjs does (network manager at init; socket, library index, optionally the
 * swarm's tracker, then preload at ready), on the fake Foundry made by `fakeFoundry`. Returns their namespaces.
 * @param {{swarm?: boolean, preload?: boolean}} [options]
 */
export async function startNetwork({ swarm = false, preload = true } = {}) {
  const mods = {
    socket: await import("../scripts/socket.mjs"),
    library: await import("../scripts/library.mjs"),
    scheduler: await import("../scripts/net/scheduler.mjs"),
    preload: await import("../scripts/net/preload.mjs"),
    swarm: await import("../scripts/p2p/swarm.mjs")
  };
  mods.scheduler.initScheduler();
  mods.socket.initSocket();
  mods.library.indexLibrary();
  if (swarm) mods.swarm.initSwarm();
  if (preload) mods.preload.initPreload();
  await settle();
  return mods;
}
