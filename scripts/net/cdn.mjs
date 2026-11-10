import { EXT, extOf, isOptimizedPath, log, warn } from "../constants.mjs";
import { getSetting, setSetting } from "../settings.mjs";
import { getLibrary, getEntry, normalizePath } from "../library.mjs";
import { MSG, on, request, isCoordinator } from "../socket.mjs";

/**
 * Caching-CDN detection. A Cloudflare-proxied origin answers cacheable requests with `cf-cache-status`.
 * The probe uses HEAD first: our Service Worker only intercepts GET, so HEAD reaches the edge untouched
 * and costs no body transfer. GET with a 1-byte Range is the fallback when HEAD is refused.
 */

/** Socket message for the delegated probe (GM on localhost asks a remote player). Not in the shared MSG catalog. */
const PROBE_MSG = "net.cdnProbe";
const PROBE_TIMEOUT_MS = 6000;
const REMOTE_RESULT_TTL_MS = 7 * 24 * 3600 * 1000;
const REWRITE_AFTER_MS = 3600 * 1000;
const CACHING = new Set(["HIT", "MISS", "EXPIRED", "REVALIDATED", "UPDATING", "STALE"]);
const MEDIA_EXT = new Set([...EXT.image, ...EXT.video, ...EXT.audio]);
/** Core public asset that every Foundry server ships; last-resort probe target. */
const CORE_PROBE = "ui/denim075.png";

let responderReady = false;
let delegationHooked = false;
let delegated = false;
/** Players whose status reported a remote origin and a ready scene: their handlers exist and they see the edge. */
const remoteReady = new Set();

/**
 * True when the page is served by this very machine (localhost, 127.0.0.0/8, ::1). Only then does a download cost
 * the host no upload: a private address may be a LAN, but just as well a VPN (Tailscale, ZeroTier) across the
 * host's uplink, so the budget charges those like any remote client.
 */
export function isLoopbackOrigin(hostname = window.location.hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * True when the page origin cannot be behind a public CDN (loopback, private LAN, link-local, CGNAT, mDNS).
 * For the CDN probe only; what a client costs the host is `isLoopbackOrigin`.
 */
export function isLocalOrigin(hostname = window.location.hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || isLoopbackOrigin(h) || h === "0.0.0.0" || h === "::") return true;
  if (/\.(local|lan|home\.arpa|internal)$/.test(h) || (!h.includes(".") && !h.includes(":"))) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return /^(fc|fd|fe[89ab])/.test(h) || h.startsWith("::ffff:127.") || h.startsWith("::ffff:10.")
    || h.startsWith("::ffff:192.168.");
  return false;
}

/** Same-origin, non-virtual media path suitable for a probe, or null. */
function usable(src) {
  if (typeof src !== "string" || !src || src.startsWith("#")) return null;
  if (/^(data|blob):/i.test(src)) return null;
  const p = normalizePath(src);
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return null;
  return MEDIA_EXT.has(extOf(p)) ? p : null;
}

/** Media referenced by the viewed/active scene, optimized versions first. */
function activeSceneMedia() {
  const scene = globalThis.canvas?.scene ?? game.scenes?.active ?? game.scenes?.current;
  if (!scene) return [];
  const out = [];
  const add = src => { const p = usable(src); if (p) out.push(p); };
  try {
    for (const lv of scene.levels ?? []) { add(lv.background?.src); add(lv.foreground?.src); }
    for (const t of scene.tiles ?? []) add(t.texture?.src);
    for (const t of scene.tokens ?? []) add(t.texture?.src);
  } catch (err) { warn("CDN probe: could not read scene media", err); }
  return out.map(p => {
    const e = getEntry(p);
    return e?.status === "done" && e.optimized ? normalizePath(e.optimized) : p;
  });
}

/** Ordered probe candidates: optimized scene media, smallest optimized library file, any scene media, core asset. */
function probeCandidates() {
  const scene = activeSceneMedia();
  const lib = Object.values(getLibrary())
    .filter(e => e?.status === "done" && e.optimized && usable(e.optimized))
    .sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))
    .map(e => normalizePath(e.optimized));
  const ordered = [...scene.filter(isOptimizedPath), ...lib.slice(0, 3), ...scene.filter(p => !isOptimizedPath(p)), CORE_PROBE];
  return [...new Set(ordered)].slice(0, 6);
}

async function probeRequest(url, method) {
  const init = { method, cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
  if (method === "GET") init.headers = { Range: "bytes=0-0" };
  const res = await fetch(url, init);
  if (method === "GET") res.body?.cancel().catch(() => {});
  return res;
}

/** Request one URL twice and classify the second answer. Returns null when the URL is unusable (404, refused). */
async function probeUrl(path) {
  const url = new URL(foundry.utils.getRoute(path), window.location.origin).href;
  for (const method of ["HEAD", "GET"]) {
    let first;
    try { first = await probeRequest(url, method); } catch { continue; }
    if (first.status === 404 || first.status === 410) return null;
    if (!first.ok && first.status !== 206) continue; // HEAD refused (405 etc.): try GET
    let second = first;
    try { second = await probeRequest(url, method); } catch { /* keep the first answer */ }
    const raw = second.headers.get("cf-cache-status") ?? first.headers.get("cf-cache-status");
    const status = raw ? raw.trim().toUpperCase() : "none";
    return { cdn: CACHING.has(status), status, url: path, cloudflare: !!raw };
  }
  return null;
}

/** Run the probe from this page. Local origins never probe. */
async function runProbe() {
  const origin = window.location.origin;
  if (isLocalOrigin()) return { cdn: false, status: "local", origin, checkedAt: Date.now() };
  for (const path of probeCandidates()) {
    const r = await probeUrl(path);
    if (r) return { ...r, origin, checkedAt: Date.now() };
  }
  return { cdn: false, status: "noProbe", origin, checkedAt: Date.now() };
}

/** Store a result. Unchanged results are rewritten at most hourly, unless `force` (a manual re-detection). */
async function store(result, force = false) {
  const prev = getSetting("cdnStatus") ?? {};
  const changed = prev.cdn !== result.cdn || prev.status !== result.status || prev.origin !== result.origin
    || !!prev.cloudflare !== !!result.cloudflare;
  if (!changed && !force && Date.now() - (prev.checkedAt ?? 0) < REWRITE_AFTER_MS) return;
  await setSetting("cdnStatus", result);
  if (!changed) return;
  log("CDN status", result);
  // Tell the GM only when a CDN is found or lost. A quick tunnel gets a new hostname at every restart and the
  // header value varies between probes; neither is news. "local" only means this browser cannot see the edge.
  if (prev.status === undefined || result.status === "local" || !!prev.cdn === !!result.cdn) return;
  const key = result.cdn ? "OPTIMALFOUNDRY.Cdn.Found" : "OPTIMALFOUNDRY.Cdn.NotFound";
  ui.notifications?.info(game.i18n.format(key, { status: result.status }));
}

/**
 * True when the last CDN probe saw a `cf-cache-status` header: the world is reached through Cloudflare (a tunnel
 * or a proxied domain), cached or not. False before the first probe and on any other kind of host.
 */
export function behindCloudflare() {
  try { return !!getSetting("cdnStatus")?.cloudflare; } catch { return false; }
}

/**
 * Every client answers delegated probes so a GM playing on localhost can learn what remote players see.
 * Called from preload's init on every client (main.mjs does not call cdn.mjs on players).
 */
export function initCdnResponder() {
  if (responderReady) return;
  responderReady = true;
  on(PROBE_MSG, async () => {
    try { return await runProbe(); }
    catch (err) { warn("CDN probe failed", err); return { cdn: false, status: "error", origin: window.location.origin, checkedAt: Date.now() }; }
  });
}

/**
 * GM on localhost: ask one remote player to probe from their origin. One success per session is enough unless
 * `force` (the dashboard's detect button). Returns whether a usable result was stored; `by` names the player.
 */
async function delegateTo(user, force = false) {
  if ((delegated && !force) || !user || user.isSelf || !user.active || !isCoordinator()) return false;
  try {
    const r = await request(PROBE_MSG, {}, user.id, PROBE_TIMEOUT_MS * 4);
    if (!r || typeof r !== "object" || ["local", "error", "noProbe"].includes(r.status)) return false;
    delegated = true;
    await store({ cdn: !!r.cdn, status: String(r.status), url: r.url, cloudflare: !!r.cloudflare,
      origin: String(r.origin ?? ""), by: user.name, checkedAt: Date.now() }, force);
    return true;
  } catch (err) {
    warn(`CDN probe delegated to ${user.name} failed`, err?.message ?? err);
    return false;
  }
}

const firstPlayer = () => game.users.find(u => u.active && remoteReady.has(u.id))
  ?? game.users.find(u => u.active && !u.isSelf && !u.isGM);

function hookDelegation() {
  if (delegationHooked) return;
  delegationHooked = true;
  // Delegate on a player's first ready status from a public origin, not on a timer after userConnected: a player
  // behind a tunnel can take longer than any fixed delay to load, and a local-origin player cannot see the edge.
  on(MSG.CLIENT_STATUS, (payload, from) => {
    if (!payload || payload.publicOrigin !== true || !payload.sceneReady || remoteReady.has(from)) return;
    remoteReady.add(from);
    delegateTo(game.users.get(from));
  });
  Hooks.on("userConnected", (user, active) => { if (!active) remoteReady.delete(user.id); });
}

/**
 * GM: detect a caching CDN in front of this world and store `{cdn, status, cloudflare, checkedAt, origin, url, by?}`
 * in the `cdnStatus` setting. Never throws.
 * `force` (the dashboard button): on a local origin, ask a connected player to probe again now and never store
 * "local"; the stored result stays as it is when no player is online or the probe fails (the GM is notified).
 */
export async function detectCdn({ force = false } = {}) {
  try {
    initCdnResponder();
    if (!game.user.isGM) return getSetting("cdnStatus");
    if (isLocalOrigin() && force) {
      const player = firstPlayer();
      if (!player) ui.notifications?.warn(game.i18n.localize("OPTIMALFOUNDRY.Cdn.NoPlayer"));
      else if (!(await delegateTo(player, true))) ui.notifications?.warn(game.i18n.localize("OPTIMALFOUNDRY.Cdn.ProbeFailed"));
      hookDelegation();
      return getSetting("cdnStatus");
    }
    if (isLocalOrigin()) {
      // A GM on localhost cannot see the edge. Keep a recent result probed by a remote player, else mark local.
      const prev = getSetting("cdnStatus") ?? {};
      let remoteFresh = false;
      try {
        remoteFresh = !!prev.origin && !isLocalOrigin(new URL(prev.origin).hostname)
          && Date.now() - (prev.checkedAt ?? 0) < REMOTE_RESULT_TTL_MS;
      } catch { /* malformed origin: re-mark as local */ }
      if (!remoteFresh) await store({ cdn: false, status: "local", origin: window.location.origin, checkedAt: Date.now() });
      hookDelegation();
      return getSetting("cdnStatus");
    }
    await store(await runProbe(), force);
  } catch (err) {
    warn("CDN detection failed; assuming no CDN", err);
  }
  return getSetting("cdnStatus");
}
