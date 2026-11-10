import { MODULE_ID, warn } from "../constants.mjs";
import { setSetting } from "../settings.mjs";
import { isCoordinator } from "../socket.mjs";
import { markNextScene, upcomingReadiness, preloadPlan } from "../net/preload.mjs";
import { detectCdn, isLocalOrigin } from "../net/cdn.mjs";
import { swarmOverview } from "../p2p/swarm.mjs";
import {
  TEMPLATE, L, maybeL, api, warnOnce, call, setting, num, fmtBytes, fmtRate, fmtCount, fmtDate, basename, yesNo,
  codeLabel, reasonLabel, blockerNote, describeCache, describeSwarm, describeSharing, describeHealth,
  convertHeavyNow, LiveApplication
} from "./common.mjs";
import { registerConnectionUI } from "./connection.mjs";
import { registerFirstRun } from "./first-run.mjs";
import { registerSettingsMenu } from "./settings-app.mjs";
import { registerTracker } from "./tracker.mjs";
import { registerWelcome } from "./welcome.mjs";
import { findCleanupCandidates, emptyOriginals } from "../media/cleanup.mjs";
import { ORIGINS, OUTCOMES } from "../media/backfill.mjs";
import { conversionBlocker } from "../media/converter.mjs";

const { DialogV2 } = foundry.applications.api;

const LIST_LIMIT = 200;
const KINDS = ["image", "video", "audio"];
const FILTERS = ["failed", "skipped", "done", "all"];
const MAX_REF_LINKS = 10;
const REVIEW_REF_LINKS = 3;
const MODE_ICONS = { auto: "fa-solid fa-wand-magic-sparkles", review: "fa-solid fa-list-check", off: "fa-solid fa-ban" };

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/** The last scan's report as table rows (origins with files only) and plain-language notes on what is not read. */
function scanContext(report) {
  if (!report?.at) return null;
  const rows = ORIGINS.map(o => {
    const c = report.byOrigin?.[o] ?? {};
    const total = OUTCOMES.reduce((n, k) => n + num(c[k]), 0);
    return total ? { label: L(`Dashboard.Scan.Origin.${o}`), hint: L(`Dashboard.Scan.OriginHint.${o}`), total: fmtCount(total),
      cells: OUTCOMES.map(k => ({ value: num(c[k]) ? fmtCount(num(c[k])) : "—", cls: k })) } : null;
  }).filter(Boolean);
  const notes = [];
  if (num(report.repaired)) notes.push(L("Dashboard.Scan.Repaired", { count: fmtCount(num(report.repaired)) }));
  if (num(report.external)) notes.push(L("Dashboard.Scan.External", { count: num(report.external), examples: (report.externalExamples ?? []).join(", ") }));
  if (num(report.vector)) notes.push(L("Dashboard.Scan.Vector", { count: num(report.vector) }));
  if (num(report.unreadPacks)) {
    notes.push(L(report.includeCompendia ? "Dashboard.Scan.Packs" : "Dashboard.Scan.PacksAll",
      { packs: num(report.unreadPacks), documents: fmtCount(num(report.unreadPackDocuments)) }));
  }
  return {
    at: L("Dashboard.Scan.LastScan", { at: fmtDate(report.at), total: fmtCount(num(report.total)) }),
    columns: OUTCOMES.map(k => ({ label: L(`Dashboard.Scan.Outcome.${k}`), hint: L(`Dashboard.Scan.OutcomeHint.${k}`) })),
    rows,
    notes
  };
}

const kindLabel = kind => maybeL(`Dashboard.Kind.${kind}`, kind ?? "—");
const choiceLabel = (key, value) => maybeL(`Settings.${key}.Choices.${value}`, String(value ?? "—"));

/** Resolve a folder or playlist UUID to something displayable. */
function describeRule(uuid) {
  let doc = null;
  try { doc = foundry.utils.fromUuidSync(uuid); } catch { /* invalid uuid */ }
  if (!doc) return { uuid, label: uuid, typeLabel: L("Dashboard.Preload.Missing"), icon: "fa-solid fa-circle-question", missing: true };
  if (doc.documentName === "Playlist") {
    return { uuid, label: doc.name, typeLabel: L("Dashboard.Preload.Playlist"), icon: "fa-solid fa-music" };
  }
  const typeLabel = doc.type === "Playlist" ? L("Dashboard.Preload.PlaylistFolder") : L("Dashboard.Preload.SceneFolder");
  return { uuid, label: doc.name, typeLabel, icon: "fa-solid fa-folder" };
}

/** A referencing document as a core content link (core opens it on click). */
function describeRef(uuid) {
  let doc = null;
  try { doc = foundry.utils.fromUuidSync(uuid); } catch { /* compendium embedded or invalid */ }
  const name = doc?.name || (doc ? [doc.documentName, doc.parent?.name].filter(Boolean).join(" · ") : uuid);
  return { uuid, name };
}

/* -------------------------------------------- */
/*  Next-scene marking                          */
/* -------------------------------------------- */

async function toggleNextScene(sceneId, mark) {
  if (!game.user.isGM || !sceneId) return;
  try {
    await markNextScene(sceneId, mark);
  } catch (err) {
    warn("dashboard: marking next scene failed", err);
    ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
  }
}

function decorateSceneDirectory(el) {
  if (!(el instanceof HTMLElement) || !game.user.isGM) return;
  const next = new Set(setting("nextScenes", []));
  for (const li of el.querySelectorAll(".directory-item[data-entry-id]")) {
    const on = next.has(li.dataset.entryId);
    li.classList.toggle("of-next-scene", on);
    const badge = li.querySelector(":scope > .of-next-indicator");
    if (on && !badge) {
      const i = document.createElement("i");
      i.className = "fa-solid fa-forward of-next-indicator";
      i.dataset.tooltip = L("Dashboard.Scene.Indicator");
      i.setAttribute("aria-label", L("Dashboard.Scene.Indicator"));
      li.append(i);
    } else if (!on) badge?.remove();
  }
}

function redecorateSceneDirectories() {
  for (const app of foundry.applications.sidebar.tabs.SceneDirectory.instances()) {
    if (app.rendered) decorateSceneDirectory(app.element);
  }
}

function addSceneContextOptions(_app, options) {
  const isNext = id => setting("nextScenes", []).includes(id);
  for (const mark of [true, false]) {
    options.push({
      label: mark ? "OPTIMALFOUNDRY.Dashboard.Scene.Mark" : "OPTIMALFOUNDRY.Dashboard.Scene.Unmark",
      icon: mark ? "fa-solid fa-forward" : "fa-solid fa-ban",
      visible: li => game.user.isGM && !!li.dataset.entryId && (isNext(li.dataset.entryId) !== mark),
      onClick: (_event, li) => toggleNextScene(li.dataset.entryId, mark)
    });
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/**
 * Called at `init`: settings menus, scene directory context menu, next-scene indicator, player panel button, the GM
 * tracker (Tokens control toggle), the GM's first-run welcome screen and the player's first-run card.
 */
export function registerUI() {
  registerSettingsMenu();
  game.settings.registerMenu(MODULE_ID, "dashboard", {
    name: "OPTIMALFOUNDRY.Dashboard.Menu.Name",
    label: "OPTIMALFOUNDRY.Dashboard.Menu.Label",
    hint: "OPTIMALFOUNDRY.Dashboard.Menu.Hint",
    icon: "fa-solid fa-gauge-high",
    type: OptimalFoundryDashboard,
    restricted: true
  });
  registerConnectionUI();
  registerTracker();
  registerWelcome();
  registerFirstRun();
  Hooks.on("getSceneContextOptions", (app, options) => {
    try { addSceneContextOptions(app, options); } catch (err) { warnOnce("scene context menu", err); }
  });
  Hooks.on("renderSceneDirectory", (_app, element) => {
    try { decorateSceneDirectory(element); } catch (err) { warnOnce("scene indicator", err); }
  });
  Hooks.on(`${MODULE_ID}.settingChanged`, key => {
    if (key !== "nextScenes") return;
    try { redecorateSceneDirectories(); } catch (err) { warnOnce("scene indicator", err); }
  });
}

/* -------------------------------------------- */
/*  Dashboard                                   */
/* -------------------------------------------- */

export class OptimalFoundryDashboard extends LiveApplication {
  static DEFAULT_OPTIONS = {
    id: "optimal-foundry-dashboard",
    classes: ["optimal-foundry"],
    tag: "div",
    window: {
      title: "OPTIMALFOUNDRY.Dashboard.Title",
      icon: "fa-solid fa-gauge-high",
      resizable: true
    },
    position: { width: 780, height: 660 },
    actions: {
      scan: OptimalFoundryDashboard.#onScan,
      start: OptimalFoundryDashboard.#onStart,
      pause: OptimalFoundryDashboard.#onPause,
      undoAll: OptimalFoundryDashboard.#onUndoAll,
      undoEntry: OptimalFoundryDashboard.#onUndoEntry,
      retryEntry: OptimalFoundryDashboard.#onRetryEntry,
      retryFiltered: OptimalFoundryDashboard.#onRetryFiltered,
      detectCdn: OptimalFoundryDashboard.#onDetectCdn,
      markScene: OptimalFoundryDashboard.#onMarkScene,
      unmarkScene: OptimalFoundryDashboard.#onUnmarkScene,
      addRule: OptimalFoundryDashboard.#onAddRule,
      removeRule: OptimalFoundryDashboard.#onRemoveRule,
      cleanupAnalyze: OptimalFoundryDashboard.#onCleanupAnalyze,
      cleanupSelected: OptimalFoundryDashboard.#onCleanupSelected,
      cleanupAll: OptimalFoundryDashboard.#onCleanupAll,
      reviewApprove: OptimalFoundryDashboard.#onReviewApprove,
      reviewApproveAll: OptimalFoundryDashboard.#onReviewApproveAll,
      reviewDecline: OptimalFoundryDashboard.#onReviewDecline,
      reviewPreview: OptimalFoundryDashboard.#onReviewPreview,
      runHeavy: () => convertHeavyNow(),
      welcome: () => api().openWelcome?.()
    }
  };

  static PARTS = {
    header: { template: TEMPLATE("dashboard") },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    media: { template: TEMPLATE("dashboard-media"), scrollable: [""] },
    network: { template: TEMPLATE("dashboard-network"), scrollable: [""] },
    p2p: { template: TEMPLATE("dashboard-p2p"), scrollable: [""] },
    preload: { template: TEMPLATE("dashboard-preload"), scrollable: [""] },
    cleanup: { template: TEMPLATE("dashboard-cleanup"), scrollable: [""] }
  };

  static TABS = {
    main: {
      tabs: [
        { id: "media", icon: "fa-solid fa-photo-film" },
        { id: "network", icon: "fa-solid fa-network-wired" },
        { id: "p2p", icon: "fa-solid fa-share-nodes" },
        { id: "preload", icon: "fa-solid fa-forward" },
        { id: "cleanup", icon: "fa-solid fa-broom" }
      ],
      initial: "media",
      labelPrefix: "OPTIMALFOUNDRY.Dashboard.Tabs"
    }
  };

  #filter = "all";
  #busy = new Set();
  /** Cleanup tab: the last analysis (expensive, so only on demand), the checked originals, the run in progress and its result. */
  #cleanup = { report: null, selected: new Set(), progress: null, last: null };
  /** Review mode: the originals checked in the "waiting for you" list, kept across refreshes. */
  #review = new Set();
  /** Preloading tab: what each "add" select shows, kept across re-renders (a refresh would reset it to the first option). */
  #picks = { scene: "", include: "", exclude: "" };

  /** Open (or focus) the single dashboard window. */
  static open() {
    return new this().render({ force: true });
  }

  /** @override */
  _canRender(options) {
    if (!game.user.isGM) throw new Error(L("Dashboard.GMOnly"));
    return super._canRender(options);
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const watched = new Set(["nextScenes", "preloadInclude", "preloadExclude", "cdnStatus", "library",
      "mediaEnabled", "backfillMode", "backfillPaused", "welcomeDone", "reviewApproved"]);
    // Hook-driven refreshes wait while the GM is choosing in a select or typing, then run once.
    this._onHook(`${MODULE_ID}.settingChanged`, key => { if (watched.has(key)) this._refreshWhenIdle(true); });
    for (const hook of ["createScene", "deleteScene", "createFolder", "deleteFolder", "createPlaylist", "deletePlaylist"]) {
      this._onHook(hook, () => { if (this.tabGroups.main === "preload") this._refreshWhenIdle(true); });
    }
    // The automatic plan changes with the world.
    this._onHook(`${MODULE_ID}.preloadPlanChanged`, () => { if (this.tabGroups.main === "preload") this._refreshWhenIdle(true); });
  }

  /** @override */
  _attachPartListeners(partId, htmlElement, options) {
    super._attachPartListeners(partId, htmlElement, options);
    if (partId === "cleanup") return this.#attachCleanupListeners(htmlElement);
    if (partId === "preload") {
      for (const select of htmlElement.querySelectorAll("select[data-of-pick]")) {
        select.addEventListener("change", event => { this.#picks[event.currentTarget.dataset.ofPick] = event.currentTarget.value; });
      }
      return;
    }
    if (partId !== "media") return;
    for (const box of htmlElement.querySelectorAll("input[data-of-review-pick]")) {
      box.addEventListener("change", event => {
        const key = event.currentTarget.dataset.ofReviewPick;
        if (event.currentTarget.checked) this.#review.add(key); else this.#review.delete(key);
        this._refresh(false);
      });
    }
    htmlElement.querySelector("input[data-of-review-all]")?.addEventListener("change", event => {
      this.#review.clear();
      if (event.currentTarget.checked) for (const i of api().backfill?.reviewList?.() ?? []) this.#review.add(i.original);
      this._refresh(false);
    });
    htmlElement.querySelector("select[data-of-filter]")?.addEventListener("change", event => {
      const value = event.currentTarget.value;
      this.#filter = FILTERS.includes(value) ? value : "all";
      event.currentTarget.blur();
      this._refresh(false);
    });
  }

  /** @override */
  changeTab(tab, group, options) {
    super.changeTab(tab, group, options);
    if (group === "main" && this.rendered) this._refresh(true);
  }

  /** The header and the active tab. The preload tab only re-renders on demand (it holds editors). @override */
  _refreshParts(force) {
    const tab = this.tabGroups.main;
    return (force || tab !== "preload") ? ["header", tab] : ["header"];
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const parts = new Set(options.parts ?? Object.keys(this.constructor.PARTS));
    const a = api();
    const coordinator = isCoordinator();
    const [backfill, net, preload, cache, swarm, eff, overview, caps] = await Promise.all([
      call("backfillStatus", a.backfill?.backfillStatus),
      call("networkStatus", a.networkStatus),
      call("preloadStatus", a.preloadStatus),
      call("cacheStatus", a.cacheStatus),
      call("swarmStatus", a.swarmStatus),
      call("effectiveNetwork", a.effectiveNetwork),
      coordinator ? call("swarmOverview", swarmOverview) : null,
      parts.has("media") ? Promise.all(KINDS.map(k => call(`canConvert.${k}`, a.canConvert, k))) : null
    ]);
    // After the probes: a conversion worker that cannot start is only known once one of them ran.
    const blocker = parts.has("media") ? await call("conversionBlocker", conversionBlocker) : null;
    // Sharing as the coordinator sees it: the GM on the server machine is never in the swarm, the players are.
    const sharing = coordinator ? describeSharing(eff, overview, net?.clients) : null;
    const raw = { a, backfill, net, preload, cache, swarm, eff, sharing, blocker, caps };
    Object.assign(context, {
      apiReady: !!game.modules.get(MODULE_ID)?.api,
      header: this.#headerContext(raw)
    });
    if (parts.has("media")) context.media = await this.#mediaContext(raw);
    if (parts.has("network")) context.network = await this.#networkContext(raw);
    if (parts.has("p2p")) context.p2p = this.#p2pContext(raw);
    if (parts.has("preload")) context.preload = this.#preloadContext();
    if (parts.has("cleanup")) context.cleanup = this.#cleanupContext();
    return context;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    const partContext = await super._preparePartContext(partId, context, options);
    if (context.tabs && partId in context.tabs) partContext.tab = context.tabs[partId];
    return partContext;
  }

  #headerContext({ backfill, net, cache, swarm, sharing }) {
    const phase = backfill?.phase ?? "idle";
    const peers = Array.isArray(swarm?.peers) ? swarm.peers.filter(p => p?.state === "open").length : 0;
    return {
      media: {
        label: backfill
          ? (backfill.paused ? L("Dashboard.Media.Paused") : maybeL(`Dashboard.Phase.${phase}`, phase))
          : L("Dashboard.Common.Unavailable"),
        cls: !backfill ? "off" : backfill.lastError ? "warn" : backfill.running && !backfill.paused ? "busy" : "ok"
      },
      network: {
        label: net ? choiceLabel("networkProfile", net.profile) : L("Dashboard.Common.Unavailable"),
        cdn: net ? (net.cdn ? L("Dashboard.Network.CdnOn") : L("Dashboard.Network.CdnOff")) : "",
        cls: net ? "ok" : "off"
      },
      // A passive GM session only knows its own browser.
      p2p: sharing ? { label: sharing.label, cls: sharing.cls, tip: sharing.reason || L("Dashboard.Tabs.p2p") } : {
        label: swarm?.enabled ? L("Dashboard.P2P.PeersCount", { count: peers }) : L("Sharing.Off"),
        cls: swarm?.enabled ? (peers ? "ok" : "idle") : "off",
        tip: L("Dashboard.Tabs.p2p")
      },
      cache: {
        label: cache?.active ? L("Dashboard.P2P.CacheActive") : L("Dashboard.P2P.CacheInactive"),
        cls: cache?.active ? "ok" : "off",
        tip: (cache && !cache.active && codeLabel(cache.reason, ["CacheReason"])) || L("Dashboard.P2P.LocalCache")
      }
    };
  }

  async #mediaContext({ a, backfill, blocker, caps }) {
    const stats = (await call("libraryStats", a.libraryStats)) ?? {};
    const library = (await call("getLibrary", a.getLibrary)) ?? {};
    const coordinator = isCoordinator();
    const mediaOn = setting("mediaEnabled", true);
    const mode = setting("backfillMode", "review");
    const persistedPause = setting("backfillPaused", false);
    const welcomed = !!setting("welcomeDone", false);
    const canAct = !!a.backfill && coordinator;
    const running = !!backfill?.running;
    const paused = !!backfill?.paused;
    const phase = backfill?.phase ?? "idle";
    const busy = this.#busy;

    const original = num(stats.originalBytes);
    const saved = num(stats.savedBytes);
    const current = backfill?.current;
    const progress = Number.isFinite(current?.progress) ? Math.round(Math.min(1, Math.max(0, current.progress)) * 100) : null;
    const le = backfill?.lastError;
    const run = backfill?.run ?? {};

    const filtered = Object.values(library)
      .filter(e => e && typeof e === "object")
      .filter(e => this.#filter === "all" || e.status === this.#filter)
      .sort((x, y) => num(y.at) - num(x.at));
    // Undo and retry never run while the cleanup empties originals (and the reverse).
    const rowActions = canAct && !busy.has("undo") && !busy.has("retry") && !busy.has("cleanup");
    const entries = filtered.slice(0, LIST_LIMIT).map(e => this.#entryRow(e, rowActions, mediaOn, mode));

    const heavy = num(backfill?.waitingForPlayers);
    return {
      available: !!a.backfill && mediaOn,
      isCoordinator: coordinator,
      // One reason for everything this browser cannot convert (a page without HTTPS, or a browser without the encoders).
      blocker: blockerNote(blocker),
      heavy: heavy ? { text: L("Dashboard.Media.HeavyWaiting", { count: fmtCount(heavy) }), canRun: canAct } : null,
      scan: scanContext(setting("scanReport", {})),
      mode: !mediaOn ? null : { label: choiceLabel("backfillMode", mode), hint: L(`Dashboard.Media.Mode.${mode}`),
        icon: MODE_ICONS[mode] ?? "fa-solid fa-circle-question", cls: mode === "off" ? "idle" : (mode === "auto" ? "ok" : "busy") },
      waitingWelcome: mediaOn && (mode !== "off") && !welcomed,
      review: this.#reviewContext(a, canAct && mediaOn && welcomed && (mode === "review") && !busy.has("review")),
      stats: {
        done: fmtCount(num(stats.done)),
        skipped: fmtCount(num(stats.skipped)),
        failed: fmtCount(num(stats.failed)),
        originalBytes: fmtBytes(original),
        optimizedBytes: fmtBytes(num(stats.optimizedBytes)),
        savedBytes: fmtBytes(Math.max(0, saved)),
        savedPct: original > 0 ? `${Math.round(saved / original * 100)}%` : "—"
      },
      status: backfill ? {
        stateLabel: paused ? L("Dashboard.Media.Paused") : running ? L("Dashboard.Media.Running") : L("Dashboard.Media.Stopped"),
        phaseLabel: maybeL(`Dashboard.Phase.${phase}`, phase),
        queued: fmtCount(num(backfill.queued)),
        done: fmtCount(num(run.done)),
        skipped: fmtCount(num(run.skipped)),
        failed: fmtCount(num(run.failed)),
        deferred: fmtCount(num(backfill.deferred)),
        lastError: le ? [le.path ? basename(le.path) : null, reasonLabel(le.reason)].filter(Boolean).join(": ") : "",
        lastErrorTitle: le ? [le.path, le.detail].filter(Boolean).join(" — ") : "",
        current: current?.original ? {
          name: basename(current.original),
          path: current.original,
          kind: kindLabel(current.kind),
          progress,
          hasProgress: progress !== null
        } : null
      } : null,
      controls: {
        scan: canAct && mediaOn && !running && !busy.has("scan") && phase !== "scanning",
        start: canAct && mediaOn && welcomed && (mode !== "off") && (!running || paused) && !busy.has("undo"),
        pause: canAct && ((running && !paused) || ((mode !== "off") && !persistedPause)),
        undoAll: canAct && num(stats.done) > 0 && !busy.has("undo") && !busy.has("cleanup"),
        retryFiltered: rowActions && mediaOn && ["failed", "skipped"].includes(this.#filter) && filtered.length > 0,
        scanBusy: busy.has("scan") || phase === "scanning",
        undoBusy: busy.has("undo"),
        retryBusy: busy.has("retry")
      },
      caps: (caps && !blocker) ? KINDS.map((k, i) => ({ label: kindLabel(k), ok: caps[i] === true, unknown: caps[i] === undefined })) : [],
      filters: FILTERS.map(f => ({ value: f, label: L(`Dashboard.Media.Filter.${f}`), selected: f === this.#filter })),
      entries,
      totalFiltered: filtered.length,
      truncated: filtered.length > LIST_LIMIT,
      truncatedLabel: L("Dashboard.Media.Truncated", { shown: LIST_LIMIT, total: filtered.length })
    };
  }

  /** Review mode: what waits for the GM, with the documents that use each file. */
  #reviewContext(a, canAct) {
    const items = (a.backfill?.reviewList?.() ?? []);
    if (!items.length) { this.#review.clear(); return null; }
    const present = new Set(items.map(i => i.original));
    for (const k of [...this.#review]) if (!present.has(k)) this.#review.delete(k);
    const picked = this.#review.size;
    return {
      count: fmtCount(items.length),
      truncated: items.length > LIST_LIMIT ? L("Dashboard.Media.Truncated", { shown: LIST_LIMIT, total: items.length }) : "",
      rows: items.slice(0, LIST_LIMIT).map(i => ({
        original: i.original,
        name: basename(i.original),
        kind: kindLabel(i.kind),
        previewable: i.kind !== "audio",
        selected: this.#review.has(i.original),
        refs: i.refs.slice(0, REVIEW_REF_LINKS).map(describeRef),
        more: i.refs.length > REVIEW_REF_LINKS ? `+${i.refs.length - REVIEW_REF_LINKS}` : ""
      })),
      allSelected: picked > 0 && picked === items.length,
      canAct,
      canSelected: canAct && picked > 0,
      approveSelected: L("Dashboard.Review.ApproveSelected", { count: picked }),
      declineSelected: L("Dashboard.Review.DeclineSelected", { count: picked }),
      approveAll: L("Dashboard.Review.ApproveAll", { count: items.length }),
      busy: this.#busy.has("review")
    };
  }

  #entryRow(e, canAct, mediaOn, mode) {
    const status = ["done", "skipped", "failed"].includes(e.status) ? e.status : "failed";
    const restored = (status === "skipped") && (e.reason === "restored") && !!e.optimized;
    const idle = !this.#busy.has(`entry:${e.original}`);
    let detail = reasonLabel(e.reason);
    if (status === "done" && Number.isFinite(e.originalBytes) && Number.isFinite(e.bytes)) {
      const pct = e.originalBytes > 0 ? Math.round((1 - e.bytes / e.originalBytes) * 100) : 0;
      detail = `${fmtBytes(e.originalBytes)} → ${fmtBytes(e.bytes)} (−${pct}%)`;
      if (e.cleaned) detail += ` · ${L("Cleanup.Emptied")}`;
    }
    if (status === "failed" && Number.isFinite(e.attempts)) {
      detail = [detail, L("Dashboard.Media.Attempts", { count: e.attempts })].filter(Boolean).join(" · ");
    }
    const refs = (status === "skipped") && (e.reason === "missing") && Array.isArray(e.refs)
      ? e.refs.slice(0, MAX_REF_LINKS).map(describeRef) : [];
    return {
      original: e.original,
      name: basename(e.original),
      optimized: e.optimized ?? "",
      kind: kindLabel(e.kind),
      status,
      statusLabel: L(`Dashboard.Status.${status}`),
      detail,
      detailTitle: [fmtDate(e.at), e.detail].filter(Boolean).join(" · "),
      refs,
      canUndo: canAct && idle && (status === "done") && !e.cleaned,
      canReoptimize: canAct && idle && mediaOn && (mode !== "off") && restored,
      canRetry: canAct && idle && mediaOn && !restored && (status !== "done")
    };
  }

  async #networkContext({ net, preload, eff, sharing }) {
    const cdnStatus = setting("cdnStatus", {}) ?? {};
    const readiness = upcomingReadiness();
    const sharingOn = !!eff?.p2p;
    const budget = net?.budget;
    const clients = Object.entries(net?.clients ?? {}).map(([userId, c]) => {
      const r = readiness[userId];
      const pos = c?.queuePosition;
      return {
        name: c?.name ?? game.users.get(userId)?.name ?? userId,
        stale: !!c?.stale,
        inflight: fmtCount(num(c?.inflight)),
        rate: fmtRate(c?.bytesPerSec),
        sceneReady: !!c?.sceneReady,
        idle: !!c?.idle,
        queue: pos === 0 ? L("Dashboard.Network.Joining") : pos > 0 ? L("Dashboard.Network.QueuePos", { position: pos }) : "",
        nextReady: r?.total ? `${fmtCount(r.have)} / ${fmtCount(r.total)}${r.bytesLeft > 0 ? ` · ${fmtBytes(r.bytesLeft)}` : ""}` : "—",
        nextDone: !!r?.total && r.have >= r.total,
        preload: c?.preload ? `${fmtCount(num(c.preload.done))} / ${fmtCount(num(c.preload.total))}` : "—",
        health: describeHealth(c, sharingOn)
      };
    }).sort((x, y) => x.name.localeCompare(y.name, game.i18n.lang));
    const detected = !!(net?.cdn ?? cdnStatus.cdn);

    return {
      available: !!net,
      profile: eff ? choiceLabel("networkProfile", eff.profile) : (net ? choiceLabel("networkProfile", net.profile) : "—"),
      chosen: choiceLabel("networkProfile", setting("networkProfile", "auto")),
      cdn: {
        detected,
        label: detected ? L("Dashboard.Network.CdnOn") : L("Dashboard.Network.CdnOff"),
        status: codeLabel(cdnStatus.status, ["Cdn.Status"]) || "—",
        checkedAt: fmtDate(cdnStatus.checkedAt),
        measuredBy: !cdnStatus.origin ? ""
          : cdnStatus.by ? L("Dashboard.Network.MeasuredBy", { by: cdnStatus.by, origin: cdnStatus.origin }) : cdnStatus.origin,
        local: isLocalOrigin()
      },
      limits: eff ? {
        maxConcurrent: fmtCount(eff.maxConcurrentRequests),
        hostUpload: fmtRate(eff.hostUploadBytesPerSec),
        preloadRate: fmtRate(eff.preloadBytesPerSec),
        staggerJoin: yesNo(eff.staggerJoin),
        p2p: sharing ? sharing.label : yesNo(eff.p2p),
        p2pReason: sharing?.reason ?? "",
        idle: Number.isFinite(eff.idleMs) ? `${Math.round(eff.idleMs / 1000)} s` : "—",
        maxFile: fmtBytes(eff.preloadMaxBytes)
      } : null,
      // The coordinator slows the preload budget down while the connection answers slowly.
      budget: budget ? {
        slowed: !!budget.slowed,
        rate: fmtRate(budget.rateBytesPerSec),
        note: budget.slowed ? L("Dashboard.Network.BudgetSlowed", { rate: fmtRate(budget.rateBytesPerSec),
          ceiling: fmtRate(budget.ceilingBytesPerSec), rtt: Number.isFinite(budget.rttMs) ? fmtCount(Math.round(budget.rttMs)) : "—" }) : ""
      } : null,
      sharingOn,
      self: net ? {
        inflight: fmtCount(num(net.inflight)),
        rate: fmtRate(net.bytesPerSec),
        idle: yesNo(net.idle)
      } : null,
      preload: preload ? {
        queueLength: fmtCount(num(preload.queueLength)),
        current: (() => {
          const c = preload.current;
          const src = typeof c === "string" ? c : (c?.src ?? c?.url);
          return src ? basename(src) : "—";
        })(),
        progress: `${fmtCount(num(preload.done))} / ${fmtCount(num(preload.total))}`,
        stateLabel: !preload.enabled ? L("Dashboard.Common.Off")
          : !preload.running ? L("Dashboard.Network.PreloadServing")
            : preload.paused ? L("Dashboard.Network.PreloadPaused") : L("Dashboard.Network.PreloadActive")
      } : null,
      clients,
      hasClients: clients.length > 0,
      cdnBusy: this.#busy.has("cdn")
    };
  }

  #p2pContext({ cache, swarm, sharing }) {
    const peers = (Array.isArray(swarm?.peers) ? swarm.peers : []).map(p => ({
      name: game.users.get(p?.userId)?.name ?? p?.userId ?? "—",
      state: codeLabel(p?.state, ["P2P.PeerState"]) || "—",
      connected: p?.state === "open",
      rtt: Number.isFinite(p?.rttMs) ? `${Math.round(p.rttMs)} ms` : "—",
      up: fmtBytes(num(p?.upBytes)),
      down: fmtBytes(num(p?.downBytes))
    }));
    return {
      blocker: window.isSecureContext ? "" : L("Blocker.insecure"),
      overview: sharing,
      cache: describeCache(cache, !window.isSecureContext),
      swarm: describeSwarm(swarm),
      peers,
      hasPeers: peers.length > 0,
      participate: yesNo(setting("p2pParticipate", true)),
      uploadCap: `${fmtCount(setting("p2pUploadCapMbps", 0))} Mbps`
    };
  }

  #preloadContext() {
    const nextIds = setting("nextScenes", []);
    const nextSet = new Set(nextIds);
    const scenes = game.scenes?.contents ?? [];
    const next = nextIds.map(id => {
      const scene = game.scenes?.get(id);
      return { id, name: scene?.name ?? id, missing: !scene };
    });
    const picks = this.#picks;
    const sceneChoices = scenes
      .filter(s => !nextSet.has(s.id))
      .map(s => ({ id: s.id, name: s.name, selected: s.id === picks.scene }))
      .sort((x, y) => x.name.localeCompare(y.name, game.i18n.lang));

    const include = setting("preloadInclude", []);
    const exclude = setting("preloadExclude", []);
    const used = new Set([...include, ...exclude]);
    const byName = (x, y) => x.name.localeCompare(y.name, game.i18n.lang);
    const folders = type => (game.folders?.filter(f => f.type === type) ?? [])
      .map(f => ({ uuid: f.uuid, name: f.name, used: used.has(f.uuid) })).sort(byName);
    const playlists = (game.playlists?.contents ?? [])
      .map(p => ({ uuid: p.uuid, name: p.name, used: used.has(p.uuid) })).sort(byName);
    const groups = [
      { label: L("Dashboard.Preload.SceneFolders"), options: folders("Scene").filter(o => !o.used) },
      { label: L("Dashboard.Preload.PlaylistFolders"), options: folders("Playlist").filter(o => !o.used) },
      { label: L("Dashboard.Preload.Playlists"), options: playlists.filter(o => !o.used) }
    ].filter(g => g.options.length);
    /** The same choices for each of the two lists, with that list's own pick selected. */
    const picked = pick => groups.map(g => ({ label: g.label, options: g.options.map(o => ({ ...o, selected: o.uuid === pick })) }));

    const p = preloadPlan();
    const tierLabel = tier => L(`Dashboard.Preload.Tier.${tier}`);
    const auto = p ? {
      built: p.built,
      tiers: p.tiers.map(t => ({ label: tierLabel(t.tier), hint: L(`Dashboard.Preload.TierHint.${t.tier}`), files: fmtCount(t.files),
        size: t.bytes > 0 ? fmtBytes(t.bytes) : "—" })),
      rows: p.plan.map(e => ({
        icon: { scene: "fa-solid fa-map", playlist: "fa-solid fa-music", actors: "fa-solid fa-users", journals: "fa-solid fa-book-open" }[e.type],
        name: e.name || L(`Dashboard.Preload.Group.${e.type}`),
        tier: tierLabel(e.tier),
        tierCls: `t${e.tier}`,
        reason: L(`Dashboard.Preload.Reason.${e.reason}`),
        files: fmtCount(e.files),
        size: e.bytes > 0 ? fmtBytes(e.bytes) : "—"
      })),
      more: p.more ? L("Dashboard.Preload.More", { count: p.more }) : ""
    } : null;

    return {
      auto,
      next,
      hasNext: next.length > 0,
      sceneChoices,
      hasSceneChoices: sceneChoices.length > 0,
      include: include.map(describeRule),
      exclude: exclude.map(describeRule),
      includeGroups: picked(picks.include),
      excludeGroups: picked(picks.exclude),
      hasGroups: groups.length > 0,
      enabled: setting("preloadEnabled", true)
    };
  }

  #cleanupContext() {
    const { report, selected, progress, last } = this.#cleanup;
    const candidates = report?.candidates ?? [];
    const busy = this.#busy.has("cleanup");
    const coordinator = isCoordinator();
    const canAct = coordinator && !busy && !this.#busy.has("undo") && !this.#busy.has("retry");
    const picked = candidates.filter(c => selected.has(c.original));
    const sum = list => list.reduce((s, c) => s + num(c.originalBytes), 0);
    const notes = report ? [
      report.inUse ? L("Cleanup.InUse", { count: report.inUse }) : "",
      report.outsideWorld ? L("Cleanup.OutsideWorld", { count: report.outsideWorld }) : "",
      report.brokenCopy ? L("Cleanup.BrokenCopy", { count: report.brokenCopy }) : "",
      report.gone ? L("Cleanup.Gone", { count: report.gone }) : "",
      report.missing ? L("Cleanup.Missing", { count: report.missing }) : ""
    ].filter(Boolean).join(" · ") : "";
    return {
      isCoordinator: coordinator,
      canAct,
      progressLabel: progress ? L("Cleanup.Progress", { done: progress.done, total: progress.total }) : "",
      last: last ? {
        at: fmtDate(last.at),
        summary: L("Cleanup.LastSummary", { emptied: last.emptied.length, kept: last.kept.length, freed: fmtBytes(last.freedBytes) }),
        kept: last.kept.map(k => ({ original: k.original, name: basename(k.original), reason: maybeL(`Cleanup.Reason.${k.reason}`, k.reason) }))
      } : null,
      analyzed: !!report,
      analyzing: busy && this.#busy.has("cleanup:analyze"),
      busy,
      notes,
      candidates: candidates.map(c => ({
        original: c.original,
        optimized: c.optimized,
        name: basename(c.original),
        kind: kindLabel(c.kind),
        originalSize: fmtBytes(c.originalBytes),
        optimizedSize: fmtBytes(c.optimizedBytes),
        selected: selected.has(c.original)
      })),
      allSelected: candidates.length > 0 && picked.length === candidates.length,
      canSelected: canAct && picked.length > 0,
      selectedLabel: L("Cleanup.CleanSelected", { count: picked.length, size: fmtBytes(sum(picked)) }),
      allLabel: L("Cleanup.CleanAll", { count: candidates.length, size: fmtBytes(sum(candidates)) })
    };
  }

  #attachCleanupListeners(el) {
    const selected = this.#cleanup.selected;
    for (const box of el.querySelectorAll("input[data-of-pick]")) {
      box.addEventListener("change", event => {
        const key = event.currentTarget.dataset.ofPick;
        if (event.currentTarget.checked) selected.add(key); else selected.delete(key);
        this._refresh(false);
      });
    }
    el.querySelector("input[data-of-pick-all]")?.addEventListener("change", event => {
      selected.clear();
      if (event.currentTarget.checked) for (const c of this.#cleanup.report?.candidates ?? []) selected.add(c.original);
      this._refresh(false);
    });
  }

  /** Confirm, empty the originals (irreversible) and drop the emptied ones from the list. */
  async #emptyOriginals(items) {
    if (!items.length) return;
    const size = fmtBytes(items.reduce((s, c) => s + num(c.originalBytes), 0));
    const ok = await DialogV2.confirm({
      window: { title: "OPTIMALFOUNDRY.Cleanup.ConfirmTitle", icon: "fa-solid fa-broom" },
      // Said in the dialog itself, not behind a hover: what is not checked, and that there is no way back.
      content: `<p>${L("Cleanup.Confirm", { count: items.length, size })}</p>
        <p><strong>${L("Cleanup.ConfirmOtherWorlds")}</strong></p>
        <p><strong>${L("Cleanup.ConfirmNoUndo")}</strong></p>`,
      yes: { label: "OPTIMALFOUNDRY.Cleanup.ConfirmYes", icon: "fa-solid fa-trash-can" },
      no: { default: true },
      rejectClose: false
    });
    if (!ok) return;
    this.#cleanup.progress = { done: 0, total: items.length };
    try {
      await this.#run("cleanup", async () => {
        const r = await emptyOriginals(items, {
          onProgress: (done, total) => { this.#cleanup.progress = { done, total }; this._refresh(false); }
        });
        const gone = new Set(r.emptied);
        // Kept for good (already empty, vanished, or no longer eligible): they leave the list of candidates too.
        for (const k of r.kept) if (["gone", "missing", "notEligible"].includes(k.reason)) gone.add(k.original);
        const report = this.#cleanup.report;
        if (report) report.candidates = report.candidates.filter(c => !gone.has(c.original));
        for (const k of gone) this.#cleanup.selected.delete(k);
        this.#cleanup.last = { at: Date.now(), ...r };
        const summary = L("Cleanup.LastSummary", { emptied: r.emptied.length, kept: r.kept.length, freed: fmtBytes(r.freedBytes) });
        if (r.kept.length) ui.notifications.warn(summary);
        else ui.notifications.info(summary);
      });
    } finally {
      this.#cleanup.progress = null;
      this._refresh(true);
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** Run an action with a busy flag, error notification and a refresh afterwards. */
  async #run(key, fn) {
    if (key && this.#busy.has(key)) return;
    if (key) this.#busy.add(key);
    this._refresh(true);
    try {
      return await fn();
    } catch (err) {
      warn(`dashboard: action ${key ?? ""} failed`, err);
      ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
    } finally {
      if (key) this.#busy.delete(key);
      this._refresh(true);
    }
  }

  /** Retry or re-optimize library entries through backfill.retry() and report the outcome. */
  async #retry(key, originals) {
    const fn = api().backfill?.retry;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    await this.#run(key, async () => {
      const n = await fn(originals);
      if (n === null || n === undefined) ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
      else if (n > 0) ui.notifications.info(L("Dashboard.Notify.Retried", { count: n }));
    });
  }

  static async #onScan() {
    const fn = api().backfill?.scan;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    await this.#run("scan", async () => {
      const r = await fn();
      if (r) {
        ui.notifications.info(L("Dashboard.Notify.ScanDone", { paths: r.paths, convert: r.convert, rewrite: r.rewrite,
          image: r.kinds?.image ?? 0, audio: r.kinds?.audio ?? 0, video: r.kinds?.video ?? 0 }));
        return;
      }
      const le = api().backfill?.backfillStatus?.()?.lastError;
      const error = le ? [reasonLabel(le.reason), le.detail].filter(Boolean).join(": ") : L("Dashboard.Notify.Unavailable");
      ui.notifications.warn(L("Dashboard.Notify.ScanFailed", { error }));
    });
  }

  /** Start clears `backfillPaused`, so a reload resumes; start() may run until the queue drains. */
  static async #onStart() {
    const fn = api().backfill?.start;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    try {
      if (setting("backfillPaused", false)) await setSetting("backfillPaused", false);
    } catch (err) { warn("dashboard: could not resume background optimization", err); }
    Promise.resolve().then(() => fn()).catch(err => {
      warn("dashboard: backfill start failed", err);
      ui.notifications.error(L("Dashboard.Notify.ActionFailed", { error: err?.message ?? String(err) }));
    }).finally(() => this._refresh(false));
    setTimeout(() => this._refresh(false), 250);
  }

  /** Pause stops now and persists `backfillPaused`, so a reload does not auto-start it again. */
  static async #onPause() {
    const fn = api().backfill?.pause;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    await this.#run(null, async () => {
      fn();
      if (!setting("backfillPaused", false)) await setSetting("backfillPaused", true);
    });
  }

  /** Approve (and start converting) or decline what waits for review; null = not the coordinating session. */
  async #reviewAction(fnName, originals, notify) {
    const fn = api().backfill?.[fnName];
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    await this.#run("review", async () => {
      const n = await fn(originals);
      if (n === null || n === undefined) return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
      for (const k of originals ?? [...this.#review]) this.#review.delete(k);
      if (n > 0) ui.notifications.info(L(notify, { count: n }));
    });
  }

  static async #onReviewApprove() {
    if (this.#review.size) await this.#reviewAction("approve", [...this.#review], "Dashboard.Review.Approved");
  }

  static async #onReviewApproveAll() {
    const count = api().backfill?.reviewList?.()?.length ?? 0;
    if (!count) return;
    const ok = await DialogV2.confirm({
      window: { title: "OPTIMALFOUNDRY.Dashboard.Review.ApproveAllTitle", icon: "fa-solid fa-check-double" },
      content: `<p>${L("Dashboard.Review.ApproveAllConfirm", { count })}</p>`,
      rejectClose: false
    });
    if (ok) await this.#reviewAction("approve", undefined, "Dashboard.Review.Approved");
  }

  static async #onReviewDecline() {
    if (this.#review.size) await this.#reviewAction("decline", [...this.#review], "Dashboard.Review.Declined");
  }

  /** Show an image or video before deciding (core's popout; it loads the original once). */
  static #onReviewPreview(_event, target) {
    const src = target?.dataset.original;
    if (!src) return;
    new foundry.applications.apps.ImagePopout({ src, window: { title: basename(src) } }).render({ force: true });
  }

  static async #onUndoAll() {
    const fn = api().backfill?.undo;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    const ok = await DialogV2.confirm({
      window: { title: "OPTIMALFOUNDRY.Dashboard.Media.UndoAllTitle", icon: "fa-solid fa-rotate-left" },
      content: `<p>${L("Dashboard.Media.UndoAllConfirm")}</p>`,
      rejectClose: false
    });
    if (!ok) return;
    await this.#run("undo", () => fn()); // undo() reports its own result
  }

  static async #onUndoEntry(_event, target) {
    const original = target?.dataset.original;
    const fn = api().backfill?.undo;
    if (!original) return;
    if (typeof fn !== "function") return ui.notifications.warn(L("Dashboard.Notify.Unavailable"));
    await this.#run(`entry:${original}`, () => fn([original])); // undo() reports its own result
  }

  static async #onRetryEntry(_event, target) {
    const original = target?.dataset.original;
    if (original) await this.#retry(`entry:${original}`, [original]);
  }

  static async #onRetryFiltered() {
    if (!["failed", "skipped"].includes(this.#filter)) return;
    const library = (await call("getLibrary", api().getLibrary)) ?? {};
    const originals = Object.values(library).filter(e => e?.status === this.#filter).map(e => e.original);
    if (!originals.length) return;
    const ok = await DialogV2.confirm({
      window: { title: "OPTIMALFOUNDRY.Dashboard.Media.RetryFiltered", icon: "fa-solid fa-rotate-right" },
      content: `<p>${L("Dashboard.Media.RetryFilteredConfirm", { count: originals.length })}</p>`,
      rejectClose: false
    });
    if (ok) await this.#retry("retry", originals);
  }

  static async #onDetectCdn() {
    await this.#run("cdn", () => detectCdn({ force: true }));
  }

  static async #onMarkScene(_event, target) {
    const id = target?.closest(".of-adder")?.querySelector("select")?.value;
    if (!id) return;
    await this.#run(`scene:${id}`, () => toggleNextScene(id, true));
  }

  static async #onUnmarkScene(_event, target) {
    const id = target?.dataset.sceneId;
    if (!id) return;
    await this.#run(`scene:${id}`, () => toggleNextScene(id, false));
  }

  static async #onAddRule(_event, target) {
    const list = target?.dataset.list;
    const uuid = target?.closest(".of-adder")?.querySelector("select")?.value;
    if (!uuid || !["include", "exclude"].includes(list)) return;
    await this.#run("rules", async () => {
      const key = list === "include" ? "preloadInclude" : "preloadExclude";
      const other = list === "include" ? "preloadExclude" : "preloadInclude";
      const current = setting(key, []);
      const otherList = setting(other, []);
      if (otherList.includes(uuid)) await setSetting(other, otherList.filter(u => u !== uuid));
      if (!current.includes(uuid)) await setSetting(key, [...current, uuid]);
    });
  }

  static async #onCleanupAnalyze() {
    this.#busy.add("cleanup:analyze");
    try {
      await this.#run("cleanup", async () => {
        const report = await findCleanupCandidates();
        const keep = new Set(report.candidates.map(c => c.original));
        for (const k of [...this.#cleanup.selected]) if (!keep.has(k)) this.#cleanup.selected.delete(k);
        this.#cleanup.report = report;
      });
    } finally {
      this.#busy.delete("cleanup:analyze");
      this._refresh(true);
    }
  }

  static async #onCleanupSelected() {
    const selected = this.#cleanup.selected;
    await this.#emptyOriginals((this.#cleanup.report?.candidates ?? []).filter(c => selected.has(c.original)));
  }

  static async #onCleanupAll() {
    await this.#emptyOriginals([...(this.#cleanup.report?.candidates ?? [])]);
  }

  static async #onRemoveRule(_event, target) {
    const { list, uuid } = target?.dataset ?? {};
    if (!uuid || !["include", "exclude"].includes(list)) return;
    await this.#run("rules", async () => {
      const key = list === "include" ? "preloadInclude" : "preloadExclude";
      await setSetting(key, setting(key, []).filter(u => u !== uuid));
    });
  }
}
