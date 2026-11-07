import { MODULE_ID, log, warn } from "./constants.mjs";
import { registerSettings, getSetting, effectiveNetwork } from "./settings.mjs";
import { initSocket, isCoordinator } from "./socket.mjs";
import { indexLibrary, libraryStats, getLibrary, flushLibrary, forgetApproved } from "./library.mjs";
import { initUploadHook } from "./media/upload-hook.mjs";
import { installRewriteGuards } from "./media/references.mjs";
import { optimizeFile, canConvert } from "./media/converter.mjs";
import * as backfill from "./media/backfill.mjs";
import { initScheduler, networkStatus } from "./net/scheduler.mjs";
import { initPreload, preloadStatus } from "./net/preload.mjs";
import { detectCdn } from "./net/cdn.mjs";
import { initServiceWorker, cleanupServiceWorker, swStatus } from "./p2p/sw-client.mjs";
import { initSwarm, swarmStatus } from "./p2p/swarm.mjs";
import { registerUI, OptimalFoundryDashboard } from "./ui/dashboard.mjs";
import { setTrackerVisible } from "./ui/tracker.mjs";
import { openWelcome } from "./ui/welcome.mjs";

/** Run one subsystem step; a failure disables only that step. */
async function step(name, fn) {
  try { await fn(); }
  catch (err) { warn(`${name} failed to start`, err); }
}

Hooks.once("init", () => {
  registerSettings();
  step("ui", registerUI);
  if (getSetting("mediaEnabled")) step("upload hook", initUploadHook);
  if (getSetting("mediaEnabled")) step("rewrite guards", installRewriteGuards);
  step("network manager", initScheduler);
});

Hooks.once("ready", async () => {
  game.modules.get(MODULE_ID).api = {
    optimizeFile, canConvert, backfill,
    libraryStats, getLibrary, effectiveNetwork,
    networkStatus, preloadStatus, swStatus, swarmStatus,
    openDashboard: () => new OptimalFoundryDashboard().render({ force: true }),
    openTracker: () => setTrackerVisible(true),
    openWelcome
  };

  initSocket();
  indexLibrary();
  Hooks.on(`${MODULE_ID}.settingChanged`, key => {
    if (key === "library") indexLibrary();
    else if (key === "reviewApproved") forgetApproved();
  });
  window.addEventListener("beforeunload", () => { flushLibrary(); });

  // The probe can take several seconds behind a tunnel; nothing below needs its result to start.
  if (isCoordinator()) detectCdn().catch(err => warn("CDN detection failed", err));
  // Not awaited: registration can take seconds and nothing below needs it.
  if (getSetting("serviceWorker")) step("service worker", initServiceWorker);
  else step("service worker cleanup", cleanupServiceWorker);
  if (effectiveNetwork().p2p) await step("p2p swarm", initSwarm);
  await step("preload", initPreload);
  if (getSetting("mediaEnabled")) await step("background optimizer", backfill.initBackfill);
  log("ready", effectiveNetwork());
});
