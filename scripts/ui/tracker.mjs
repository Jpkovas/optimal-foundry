import { MODULE_ID } from "../constants.mjs";
import { setSetting } from "../settings.mjs";
import { isCoordinator } from "../socket.mjs";
import { upcomingReadiness, preloadPlan } from "../net/preload.mjs";
import { networkStatus } from "../net/scheduler.mjs";
import { swarmOverview } from "../p2p/swarm.mjs";
import {
  TEMPLATE, L, api, call, warnOnce, setting, num, fmtBytes, fmtRate, fmtCount, basename, describeSharing,
  describeHealth, convertHeavyNow, LiveApplication
} from "./common.mjs";
import { upcomingScene, readyCue } from "./format.mjs";

/**
 * The GM's floating status panel: a small frameless box over the canvas, dragged by its title bar, collapsed to one
 * line, remembered per browser (position, collapsed, shown). It reads the same status the dashboard reads, every 2 s.
 * Toggled from the Tokens controls; never shown to players.
 */

const DEFAULT_POSITION = { left: 120, top: 120 };
const WIDTH = 290;
const READY_WATCH_MS = 3000;

export class OptimalFoundryTracker extends LiveApplication {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-tracker",
    classes: ["optimal-foundry", "of-tracker", "themed", "theme-dark"],
    tag: "aside",
    window: { frame: false, positioned: true },
    position: { width: WIDTH, height: "auto" },
    actions: {
      collapse: OptimalFoundryTracker.#onCollapse,
      hide: OptimalFoundryTracker.#onHide,
      dashboard: OptimalFoundryTracker.#onDashboard,
      welcome: OptimalFoundryTracker.#onWelcome,
      runHeavy: () => convertHeavyNow()
    }
  };

  static PARTS = { body: { template: TEMPLATE("tracker") } };

  /** @override */
  _canRender(options) {
    if (!game.user.isGM) return false;
    return super._canRender(options);
  }

  /** @override */
  _initializeApplicationOptions(options) {
    const opts = super._initializeApplicationOptions(options);
    const saved = setting("trackerPosition", {}) ?? {};
    const left = Number.isFinite(saved.left) ? saved.left : DEFAULT_POSITION.left;
    const top = Number.isFinite(saved.top) ? saved.top : DEFAULT_POSITION.top;
    Object.assign(opts.position, { left, top });
    return opts;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("pointerdown", event => this.#startDrag(event));
    const watched = new Set(["trackerCollapsed", "backfillMode", "welcomeDone", "mediaEnabled", "preloadEnabled", "p2pEnabled"]);
    this._onHook(`${MODULE_ID}.settingChanged`, key => { if (watched.has(key)) this._refreshWhenIdle(true); });
  }

  /** Collapsed it shrinks to its one line; the height follows the content. Both stay inside the screen. @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.setPosition({ width: context.collapsed ? "auto" : WIDTH, height: "auto" });
  }

  /** Drag by the title bar; buttons in it still click. The position is saved when the drag ends. */
  #startDrag(event) {
    if ((event.button !== 0) || !event.target.closest("[data-of-drag]") || event.target.closest("button, a, input")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: this.position.left, top: this.position.top };
    const move = e => this.setPosition({ left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const { left, top } = this.position;
      if ((left !== start.left) || (top !== start.top)) setSetting("trackerPosition", { left, top }).catch(() => {});
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const a = api();
    const coordinator = isCoordinator();
    const [backfill, net, stats, eff, overview] = await Promise.all([
      call("backfillStatus", a.backfill?.backfillStatus),
      call("networkStatus", a.networkStatus),
      call("libraryStats", a.libraryStats),
      call("effectiveNetwork", a.effectiveNetwork),
      coordinator ? call("swarmOverview", swarmOverview) : null
    ]);
    const media = mediaLine(backfill, stats ?? {});
    const plan = coordinator ? preloadPlan() : null;
    const tier = t => num(plan?.tiers?.find(x => x.tier === t)?.files);
    const players = playerRows(net, tier(0) + tier(1), !!eff?.p2p);
    const ready = players.filter(p => p.ready).length;
    const next = upcomingScene(plan?.plan);
    // The GM on the server machine is never in the swarm, so the line comes from what the players report.
    const sharing = coordinator ? describeSharing(eff, overview, net?.clients) : null;
    if (sharing) {
      sharing.tip = [`${L("Sharing.Title")}: ${sharing.label}`, sharing.on ? `↑ ${sharing.up} · ↓ ${sharing.down}` : "", sharing.reason]
        .filter(Boolean).join(" · ");
    }
    return Object.assign(context, {
      collapsed: !!setting("trackerCollapsed", false),
      coordinator,
      media,
      players,
      // Players are known to the coordinating session only.
      playersNote: !coordinator ? L("Tracker.PlayersOtherGM") : (!players.length ? L("Tracker.NoPlayers") : ""),
      preloadOn: !!setting("preloadEnabled", true),
      readyTip: players.length ? L("Tracker.ReadyCount", { ready, total: players.length }) : "",
      allReady: (next && players.length && (ready === players.length)) ? L("Tracker.AllReady", { scene: next.name }) : "",
      plan: plan?.built ? { now: fmtCount(tier(0)), likely: fmtCount(tier(1)), later: fmtCount(tier(2) + tier(3)) } : null,
      sharing
    });
  }

  static async #onCollapse() {
    await setSetting("trackerCollapsed", !setting("trackerCollapsed", false));
  }

  static async #onHide() {
    await setTrackerVisible(false);
  }

  static #onDashboard() {
    api().openDashboard?.();
  }

  static #onWelcome() {
    api().openWelcome?.();
  }
}

/**
 * The one line that says what the media side is doing, most important first: a conversion in progress, then what is
 * waiting for the GM, then a pause or a stop, then "all done".
 * `short` is what the collapsed line shows next to the icon (progress, a count, or nothing).
 * @returns {{icon: string, cls: string, text: string, short?: string, progress?: number, hasProgress?: boolean, action?: string, actionLabel?: string}}
 */
function mediaLine(b, stats) {
  if (!setting("mediaEnabled", true)) return { icon: "fa-solid fa-image", cls: "idle", text: L("Tracker.Media.Off") };
  if (!isCoordinator()) return { icon: "fa-solid fa-user-shield", cls: "idle", text: L("Tracker.Media.OtherGM") };
  if (!b) return { icon: "fa-solid fa-circle-question", cls: "idle", text: L("Dashboard.Common.Unavailable") };
  const saved = num(stats.originalBytes) > 0 ? Math.round(num(stats.savedBytes) / num(stats.originalBytes) * 100) : 0;
  if (b.current?.original) {
    const progress = Number.isFinite(b.current.progress) ? Math.round(Math.min(1, Math.max(0, b.current.progress)) * 100) : undefined;
    return { icon: "fa-solid fa-gear fa-spin", cls: "busy", text: L("Tracker.Media.Converting", { name: basename(b.current.original),
      queued: fmtCount(num(b.queued)) }), progress, hasProgress: progress !== undefined,
      short: progress !== undefined ? `${progress}%` : fmtCount(num(b.queued)) };
  }
  if (b.waitingWelcome && (b.mode !== "off")) {
    return { icon: "fa-solid fa-hand", cls: "warn", text: L("Tracker.Media.WaitingWelcome"), action: "welcome", actionLabel: L("Tracker.Setup"),
      short: "!" };
  }
  if (num(b.review)) {
    return { icon: "fa-solid fa-list-check", cls: "warn", text: L("Tracker.Media.Review", { count: fmtCount(num(b.review)) }),
      action: "dashboard", actionLabel: L("Tracker.Review"), short: fmtCount(num(b.review)) };
  }
  if (b.paused) return { icon: "fa-solid fa-pause", cls: "idle", text: L("Tracker.Media.Paused", { queued: fmtCount(num(b.queued)) }) };
  if (num(b.waitingForPlayers)) {
    return { icon: "fa-solid fa-user-clock", cls: "idle", text: L("Tracker.Media.HeavyWaiting", { count: fmtCount(num(b.waitingForPlayers)) }),
      action: "runHeavy", actionLabel: L("Tracker.ConvertNow"), short: fmtCount(num(b.waitingForPlayers)) };
  }
  if (b.running && num(b.queued)) {
    return { icon: "fa-solid fa-hourglass-half", cls: "busy", text: L("Tracker.Media.Waiting", { queued: fmtCount(num(b.queued)) }),
      short: fmtCount(num(b.queued)) };
  }
  if (b.mode === "off") return { icon: "fa-solid fa-ban", cls: "idle", text: L("Tracker.Media.ExistingOff") };
  return { icon: "fa-solid fa-check", cls: "ok", text: saved ? L("Tracker.Media.Done", { saved }) : L("Tracker.Media.Idle") };
}

/**
 * One row per connected player: readiness for what comes next (tiers 0–1), overall preload, transfer rate, and
 * what that browser can do (HTTPS, local cache, sharing) in the tooltip.
 * `upcoming` is the number of tier 0–1 files: a player the coordinator has no readiness for yet (preloading off on
 * that device, not asked yet) is "unknown", never "ready", unless there is nothing upcoming at all.
 */
function playerRows(net, upcoming, sharingOn) {
  const readiness = upcomingReadiness();
  return Object.entries(net?.clients ?? {})
    .filter(([userId]) => !game.users.get(userId)?.isGM)
    .map(([userId, c]) => {
      const r = readiness[userId];
      const total = r ? num(r.total) : upcoming;
      const have = r ? Math.min(num(r.have), total) : 0;
      const known = !!r || (upcoming === 0);
      const ready = !c?.stale && known && (have >= total);
      const pos = c?.queuePosition;
      const state = c?.stale ? "stale" : (pos >= 0 ? "joining" : (num(c?.bytesPerSec) > 0 ? "loading"
        : (ready ? "ready" : (known ? "waiting" : "unknown"))));
      const name = c?.name ?? game.users.get(userId)?.name ?? userId;
      const stateText = pos > 0 ? L("Tracker.State.queued", { position: pos }) : L(`Tracker.State.${state}`);
      return {
        name,
        ready,
        state,
        pct: total ? Math.round(have / total * 100) : (known ? 100 : 0),
        next: (known && total) ? `${fmtCount(have)}/${fmtCount(total)}` : "—",
        dotTip: `${name}: ${stateText}`,
        tooltip: [
          stateText,
          known ? L("Tracker.NextTip", { next: total ? `${fmtCount(have)}/${fmtCount(total)}` : "—", left: fmtBytes(num(r?.bytesLeft)) }) : "",
          num(c?.bytesPerSec) > 0 ? fmtRate(c.bytesPerSec) : "",
          c?.preload ? L("Tracker.PreloadTip", { done: fmtCount(num(c.preload.done)), total: fmtCount(num(c.preload.total)) }) : "",
          describeHealth(c, sharingOn).tip
        ].filter(Boolean).join(" · ")
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name, game.i18n.lang));
}

/** Show or hide the panel, remember it, and keep the Tokens control toggle in step. */
export async function setTrackerVisible(visible) {
  if (!game.user.isGM) return;
  if (setting("trackerVisible", true) !== visible) await setSetting("trackerVisible", visible);
  const open = foundry.applications.instances.get(OptimalFoundryTracker.DEFAULT_OPTIONS.id);
  if (visible) (open ?? new OptimalFoundryTracker()).render({ force: true });
  else await open?.close();
  const tool = ui.controls?.controls?.tokens?.tools?.ofTracker;
  if (tool && (tool.active !== visible)) ui.controls.render({ reset: true });
}

/** Scenes the "everyone is ready" cue already announced in this session. */
const announced = new Set();

/**
 * Coordinator: one notice per scene when every connected player holds everything that comes next. It runs on its
 * own timer, so the GM gets it with the panel collapsed or hidden too.
 */
function watchReadiness() {
  if (!isCoordinator()) return;
  try {
    const plan = preloadPlan();
    if (!plan?.built) return;
    const upcoming = plan.tiers.reduce((n, t) => n + (t.tier <= 1 ? t.files : 0), 0);
    const scene = readyCue(playerRows(networkStatus(), upcoming, false), upcomingScene(plan.plan), announced);
    if (scene) ui.notifications.info(L("Tracker.AllReadyNotice", { scene: scene.name }));
  } catch (err) {
    warnOnce("ready cue", err);
  }
}

/**
 * Registered at init: the Tokens control toggle; at ready the panel opens for GMs who left it shown and the
 * "everyone is ready" watch starts.
 */
export function registerTracker() {
  Hooks.on("getSceneControlButtons", controls => {
    const tokens = controls.tokens;
    if (!tokens || !game.user.isGM) return;
    tokens.tools.ofTracker = {
      name: "ofTracker",
      order: Object.keys(tokens.tools).length + 1,
      title: "OPTIMALFOUNDRY.Tracker.Toggle",
      icon: "fa-solid fa-gauge-high",
      toggle: true,
      active: !!setting("trackerVisible", true),
      onChange: (_event, active) => setTrackerVisible(active)
    };
  });
  Hooks.once("ready", () => {
    if (!game.user.isGM) return;
    if (setting("trackerVisible", true)) new OptimalFoundryTracker().render({ force: true });
    setInterval(watchReadiness, READY_WATCH_MS);
  });
}
