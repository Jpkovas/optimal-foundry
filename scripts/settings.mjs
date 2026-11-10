import { MODULE_ID } from "./constants.mjs";

/**
 * Every setting of the module, declared once. None is listed in Foundry's own settings page: the GM edits the
 * world settings in the module's Settings window (presets, basic and advanced sections), each player edits the
 * client settings in "My connection", and the rest is internal state or edited from the dashboard.
 * Labels live in lang/*.json under OPTIMALFOUNDRY.Settings.<key>.Name / .Hint.
 */

/** Data saver on, or a cellular link: this browser starts with the lighter per-device defaults. */
const CONSTRAINED = !!globalThis.navigator?.connection?.saveData || globalThis.navigator?.connection?.type === "cellular";

const DEFS = {
  // ---------- Media ----------
  mediaEnabled:        { scope: "world", type: Boolean, default: true, config: false, group: "media" },
  optimizeUploads:     { scope: "world", type: Boolean, default: true, config: false, group: "media" },
  /** Existing world media: "auto" converts everything, "review" only what the GM approves, "off" leaves it alone. */
  backfillMode:        { scope: "world", type: String,  default: "review", config: false, group: "media", choices: { auto: "auto", review: "review", off: "off" } },
  keepResolution:      { scope: "world", type: Boolean, default: true, config: false, group: "media" },
  maxImageSide:        { scope: "world", type: Number,  default: 8192, config: false, group: "media", range: { min: 1024, max: 16383, step: 1 } },
  maxVideoHeight:      { scope: "world", type: Number,  default: 1080, config: false, group: "media", choices: { 720: "720p", 1080: "1080p", 1440: "1440p", 2160: "2160p" } },
  imageQuality:        { scope: "world", type: Number,  default: 0.85, config: false, group: "media", range: { min: 0.5, max: 1, step: 0.01 } },
  videoQuality:        { scope: "world", type: String,  default: "medium", config: false, group: "media", choices: { low: "low", medium: "medium", high: "high" } },
  videoStripAudio:     { scope: "world", type: Boolean, default: false, config: false, group: "media" },
  audioBitrate:        { scope: "world", type: Number,  default: 128, config: false, group: "media", choices: { 64: "64 kbps", 96: "96 kbps", 128: "128 kbps", 160: "160 kbps", 192: "192 kbps" } },
  skipMp3BelowKbps:    { scope: "world", type: Number,  default: 160, config: false, group: "media", range: { min: 0, max: 320, step: 16 } },
  minSavingsPct:       { scope: "world", type: Number,  default: 10, config: false, group: "media", range: { min: 0, max: 50, step: 1 } },
  convertAnimatedGif:  { scope: "world", type: Boolean, default: true, config: false, group: "media" },
  includeCompendia:    { scope: "world", type: Boolean, default: true, config: false, group: "media" },
  protectActiveScene:  { scope: "world", type: Boolean, default: true, config: false, group: "media" },

  // ---------- Network ----------
  networkProfile:      { scope: "world", type: String,  default: "auto", config: false, group: "network", choices: { auto: "auto", quickTunnel: "quickTunnel", cdn: "cdn", custom: "custom" } },
  hostUploadMbps:      { scope: "world", type: Number,  default: 20, config: false, group: "network", range: { min: 1, max: 1000, step: 1 } },
  preloadSharePct:     { scope: "world", type: Number,  default: 60, config: false, group: "network", range: { min: 10, max: 100, step: 5 } },
  maxConcurrentRequests:{ scope: "world", type: Number, default: 150, config: false, group: "network", range: { min: 4, max: 1000, step: 1 } },
  staggerJoin:         { scope: "world", type: Boolean, default: true, config: false, group: "network" },
  preloadEnabled:      { scope: "world", type: Boolean, default: true, config: false, group: "network" },
  idleSeconds:         { scope: "world", type: Number,  default: 5, config: false, group: "network", range: { min: 1, max: 60, step: 1 } },
  preloadMaxFileMB:    { scope: "world", type: Number,  default: 100, config: false, group: "network", range: { min: 1, max: 2000, step: 1 } },
  predecodeNext:       { scope: "world", type: Boolean, default: false, config: false, group: "network" },
  // client (per player, per browser): "all" preloads the whole queue, "session" stops before the "later" tier, "off" nothing
  preloadScope:        { scope: "client", type: String,  default: CONSTRAINED ? "session" : "all", config: false, group: "network", choices: { all: "all", session: "session", off: "off" } },
  preloadInclude:      { scope: "world", type: Array,   default: [], config: false }, // folder / playlist UUIDs always preloaded
  preloadExclude:      { scope: "world", type: Array,   default: [], config: false }, // folder / playlist UUIDs never preloaded

  // ---------- P2P / Service Worker ----------
  p2pEnabled:          { scope: "world", type: Boolean, default: true, config: false, group: "p2p" },
  serviceWorker:       { scope: "world", type: Boolean, default: true, config: false, group: "p2p" },
  iceServers:          { scope: "world", type: String,  default: "stun:stun.cloudflare.com:3478, stun:stun.l.google.com:19302", config: false, group: "p2p" },
  p2pMinFileKB:        { scope: "world", type: Number,  default: 512, config: false, group: "p2p", range: { min: 0, max: 102400, step: 64 } },
  p2pTimeoutSec:       { scope: "world", type: Number,  default: 8, config: false, group: "p2p", range: { min: 2, max: 60, step: 1 } },
  // client (per player, per browser)
  p2pParticipate:      { scope: "client", type: Boolean, default: !CONSTRAINED, config: false, group: "p2p" },
  /** Megabits per second, like every other rate the module shows. */
  p2pUploadCapMbps:    { scope: "client", type: Number,  default: 4, config: false, group: "p2p", range: { min: 1, max: 200, step: 1 } },
  cacheQuotaMB:        { scope: "client", type: Number,  default: 4096, config: false, group: "p2p", range: { min: 256, max: 65536, step: 256 } },

  // ---------- Internal state ----------
  /** Map originalPath -> LibraryEntry (see library.mjs). */
  library:             { scope: "world", type: Object,  default: {}, config: false },
  /** Scene ids the GM marked as "next" for preloading. */
  nextScenes:          { scope: "world", type: Array,   default: [], config: false },
  /** What the last backfill scan found, by origin and outcome (see media/backfill.mjs scanReport). */
  scanReport:          { scope: "world", type: Object,  default: {}, config: false },
  /** The GM paused the background optimization (dashboard): a reload does not start it again. */
  backfillPaused:      { scope: "world", type: Boolean, default: false, config: false },
  /** Originals the GM approved for conversion in review mode. */
  reviewApproved:      { scope: "world", type: Array,   default: [], config: false },
  /** A GM finished (or skipped for good) the welcome screen; nothing converts existing files before that. */
  welcomeDone:         { scope: "world", type: Boolean, default: false, config: false },
  /**
   * This player answered the first-run card of "My connection" on this browser. Until then a player's browser
   * opens no peer connection, so no IP address is exchanged before the player chose.
   */
  connectionChoiceDone: { scope: "client", type: Boolean, default: false, config: false },
  /** GM tracker panel (per browser): shown, collapsed, and where it was left ({left, top}). */
  trackerVisible:      { scope: "client", type: Boolean, default: true, config: false },
  trackerCollapsed:    { scope: "client", type: Boolean, default: false, config: false },
  trackerPosition:     { scope: "client", type: Object,  default: {}, config: false },
  /** Result of CDN detection: { cdn: boolean, checkedAt: number, status: string }. */
  cdnStatus:           { scope: "world", type: Object,  default: {}, config: false }
};

/** Settings that only apply under the "custom" network profile; the Settings window greys them out otherwise. */
export const PROFILE_KEYS = ["maxConcurrentRequests", "preloadSharePct", "staggerJoin"];
/** Changing one of these needs every client to reload. */
export const RELOAD_KEYS = ["serviceWorker", "p2pEnabled", "mediaEnabled"];

/**
 * Register every setting. Each one fires `optimal-foundry.settingChanged(key, value, options, userId)` on every
 * change, including the first write of a world setting (a Setting create, which `updateSetting` misses) and
 * client-scope settings. Listen to that hook instead of `updateSetting` / `clientSettingChanged`.
 */
export function registerSettings() {
  for (const [key, def] of Object.entries(DEFS)) {
    const { group, ...data } = def;
    const label = `OPTIMALFOUNDRY.Settings.${key}`;
    if (data.choices) data.choices = Object.fromEntries(Object.keys(data.choices).map(v => [v, `${label}.Choices.${v}`]));
    game.settings.register(MODULE_ID, key, {
      name: `${label}.Name`,
      hint: `${label}.Hint`,
      requiresReload: RELOAD_KEYS.includes(key),
      onChange: (value, options, userId) => Hooks.callAll(`${MODULE_ID}.settingChanged`, key, value, options, userId),
      ...data
    });
  }
}

/** Declaration of one setting (scope, type, default, choices, range), for the Settings window. */
export const settingDef = key => DEFS[key];

/**
 * Presets the Settings window offers. Each lists the values it sets; a preset is "current" when every one of its
 * values matches. "networkOnly" leaves files alone and keeps the network features. Whether existing files convert on
 * their own or after review (`backfillMode`) is a separate choice, never part of a preset.
 */
export const PRESETS = {
  recommended: { mediaEnabled: true, optimizeUploads: true, keepResolution: true, imageQuality: 0.85,
    videoQuality: "medium", audioBitrate: 128, videoStripAudio: false, preloadEnabled: true, p2pEnabled: true },
  saver: { mediaEnabled: true, optimizeUploads: true, keepResolution: false, maxImageSide: 4096,
    maxVideoHeight: 720, imageQuality: 0.75, videoQuality: "low", audioBitrate: 96, videoStripAudio: true, preloadEnabled: true,
    p2pEnabled: true },
  quality: { mediaEnabled: true, optimizeUploads: true, keepResolution: true, imageQuality: 0.92,
    videoQuality: "high", audioBitrate: 160, videoStripAudio: false, preloadEnabled: true, p2pEnabled: true },
  networkOnly: { mediaEnabled: false, preloadEnabled: true, p2pEnabled: true }
};

/** The preset whose values all match `values` (a key -> value map), or "custom". */
export function matchPreset(values) {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (Object.entries(preset).every(([k, v]) => values[k] === v)) return id;
  }
  return "custom";
}

export const getSetting = key => game.settings.get(MODULE_ID, key);
export const setSetting = (key, value) => game.settings.set(MODULE_ID, key, value);
export const SETTING_GROUPS = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.group ?? "internal"]));

/**
 * Fixed limits per network profile; `custom` and the bandwidth come from the settings. P2P is its own setting.
 * Behind a caching CDN only the first request for a file reaches the host (the edge fill) and what players load
 * for the game mostly comes from the edge, so that fill may use most of the uplink; the edge has no request limit.
 */
const PROFILES = {
  quickTunnel: { maxConcurrentRequests: 150, preloadSharePct: 60, staggerJoin: true },
  cdn:         { maxConcurrentRequests: Infinity, preloadSharePct: 90, staggerJoin: false }
};

/**
 * The limits actually in force. `auto` picks `cdn` when the CDN detector confirmed a caching CDN,
 * otherwise `quickTunnel`. Behind a CDN players never exchange files: the edge already spares the host's upload,
 * so P2P would only spend the players' upload and exchange their IP addresses.
 * `preloadBytesPerSec` is the ceiling of the preload budget on every profile (the network manager adapts below it):
 * everything the host uploads for preloading, which behind a CDN is the first handout of each file.
 */
export function effectiveNetwork() {
  const chosen = getSetting("networkProfile");
  const cdn = !!getSetting("cdnStatus")?.cdn;
  const profile = chosen === "auto" ? (cdn ? "cdn" : "quickTunnel") : chosen;
  const custom = {
    maxConcurrentRequests: getSetting("maxConcurrentRequests"),
    preloadSharePct: getSetting("preloadSharePct"),
    staggerJoin: getSetting("staggerJoin")
  };
  const limits = profile === "custom" ? custom : PROFILES[profile];
  const uploadBytesPerSec = getSetting("hostUploadMbps") * 125_000;
  return {
    profile, cdn, ...limits,
    p2p: getSetting("p2pEnabled") && profile !== "cdn",
    hostUploadBytesPerSec: uploadBytesPerSec,
    preloadBytesPerSec: uploadBytesPerSec * limits.preloadSharePct / 100,
    idleMs: getSetting("idleSeconds") * 1000,
    preloadMaxBytes: getSetting("preloadMaxFileMB") * 1_048_576
  };
}
