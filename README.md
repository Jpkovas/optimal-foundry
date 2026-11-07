# Optimal Foundry

A Foundry VTT module (v14 or newer, tested on 14.370) that makes your world lighter and faster to load for everyone. Everything runs in the browser: there is no extra server and nothing to install.

## What it does

- **Optimizes every upload.** Before the file reaches the server, the browser converts:
  - images to **WebP** (SVG is never touched; WebP and AVIF stay as they are);
  - videos to **WebM VP9** (with transparency when the original has it);
  - audio to **Ogg Opus**.
  Only the optimized version is stored. If the uploader's browser cannot convert, the original is uploaded and the GM converts it later, in the background.
- **Optimizes the media the world already has, your way.** The GM's client converts the media the world uses and points scenes, actors, journals, playlists and so on to the new copies. Three modes: **Automatic** (converts everything gradually, without asking), **Review first** (the default: lists what would be converted and only touches what you approve, in the dashboard's Media tab) and **Don't optimize**. The optimization **never touches the originals**, and any swap can be undone from the dashboard. Only the Cleanup (optional, in the dashboard) empties originals, and it cannot be undone.
- **Keeps the resolution by default.** Only the format and the quality change. Downsizing is optional.
- **Coordinates the network.** The GM shares the bandwidth between players, limits simultaneous downloads (useful on free tunnels) and makes players who join at the same time load the scene one at a time.
- **Preloads on its own during idle time.** When nobody is downloading anything, players fetch ahead what they will likely need, from most to least likely: the scenes the players and the GM are viewing, the rest of the active scene and its playlist, whatever is playing, the neighbouring scenes in the navigation bar and in the folder, teleport destinations, then the rest of the navigation bar, the player characters' sheets and, finally, every other scene, playlist and journal the players can see. You don't have to mark anything; marking a scene (right-click in the Scenes tab) only moves it to the front.
- **Takes advantage of a CDN** (such as Cloudflare) when there is one: it detects it on its own and allows more bandwidth.
- **Shares files between players (P2P).** A player who already has an optimized file can send it straight to the others, saving the host's upload. Every file is checked by hash before it is used.
- **Local cache** with a Service Worker: optimized files are kept in the browser and never downloaded again. Other media (which can change) is kept too, but checked against the server before use, at most every 30 seconds.

## Installation

1. Install and enable the **libWrapper** module (required).
2. In Foundry, under *Add-on Modules → Install Module*, search for **Optimal Foundry** or paste the manifest URL:
   `https://github.com/Jpkovas/optimal-foundry/releases/latest/download/module.json`
3. Enable the module in your world.
4. Log in as the GM: the welcome screen appears so you can choose how the module works. The full dashboard is under *Game Settings → Configure Settings → Optimal Foundry → Open dashboard*.

Player browsers: an up-to-date Chrome, Edge or Firefox. The local cache and P2P require **HTTPS** (or access through `localhost`); on `http://IP:30000` they stay off, and everything else works normally.

The interface is available in English and Brazilian Portuguese.

## Welcome screen

The first time a GM enters the world with the module enabled, a screen appears to choose how it works: the file quality (the same presets as in the settings), what to do with the files the world already has (review first, automatic or leave them), whether new uploads are optimized before they go up, automatic preloading, P2P, the host's upload speed and the floating panel. **Until someone completes this screen, no existing file is converted**; preloading and P2P already run with their defaults. *Not now* closes the screen, which comes back the next time you log in. You can reopen it with the *Welcome* button in the module's settings.

## Floating panel (GM only)

A small box over the map that shows, every 2 seconds:

- what is happening with the files (which file is being converted and how much is left, how many are waiting for your approval, paused, all up to date);
- each connected player, with a bar for how much they already have of what comes next (the scenes someone is viewing, the active scene, its neighbours and whatever is playing) and whether they are joining the scene or downloading right now; hover for details;
- the preload queue (now, likely, later) and P2P.

Drag it by its title bar to put it wherever you like; the position is remembered in this browser. The arrow collapses everything into a single line: the files icon with the progress or how many files are waiting for approval, one colored dot per player (green ready, blue downloading, orange joining or still downloading what comes next, an outline when there is no information) and the P2P connections. The icon next to the arrow opens the full dashboard and the X hides the panel. It comes back with the gauge button in the **Tokens** controls, on the left. Players never see it.

## The dashboard

Only the GM can open it. It refreshes every 2 seconds.

- **Media:** in *Review first* mode, first the list of what is **waiting for your approval**, with where each file is used and a button to view the image or video; check files and choose *Optimize checked*, *Optimize all* or *Leave as it is* (those no longer show up; *Retry* in the file list brings them back). Then a table of **everything the world uses**, split by origin (world folder, modules, system, Foundry's icons and sounds, other folders) and by what happened to each file (optimized, already light, queued, waiting for you, skipped, failed), plus what is not read and why (external links, SVG, module compendiums). Then how much has been optimized and saved, what the browser can convert, the progress of optimizing existing media (scan, start, pause, undo all) and the list of every file, with a filter and the reason each one was skipped or failed. Each optimized file can go back to the original individually; failed or skipped files can be retried, one by one or the whole filtered list, and restored files can be optimized again without converting them a second time.
- **Network:** the profile in use, limits, the CDN detection result (and who measured it) and a table per player: downloads in progress, speed, scene ready, how much of what comes next they already have, preloading, P2P and their position in the join queue. Players with no recent status are greyed out.
- **P2P:** Service Worker state (version, outdated-copy warning, persistent storage) and cache state, connected peers, how much was sent and received and the last connection failure.
- **Preloading:** the automatic prediction, with what is queued, when (now, likely, this session, later) and why; the scenes you want to move to the front (optional); and the folders and playlists that are always or never preloaded.
- **Cleanup:** empties originals that have already been replaced (see below).

Start and Pause are remembered: after pausing, optimizing existing media does not resume on its own after a reload (approving files in the review also resumes it). It also waits while a player is joining or loading a scene.

In the **Scenes** tab, right-clicking a scene shows *Mark as next scene* / *Unmark*. Marked scenes get a small blue icon.

## Cleaning up originals

Once existing media is converted, the originals stay on disk. Foundry does not let modules delete files, but it does let them overwrite images, videos and sounds. So the dashboard's **Cleanup** tab **empties** the originals: each one stays in its folder under the same name, but becomes 0 bytes and stops taking up space. Only files that can already be emptied are listed:

- only files **inside this world's folder** (`worlds/<world>/`); files in shared Data folders are never included, because other worlds may use them;
- already converted and no longer mentioned anywhere in the world: scenes, sheets, journals, playlists, macros, chat messages, settings and world compendiums (any mention of the file, even in text, is enough to keep it);
- with the optimized version present and at the recorded size.

Click **Analyze**, check the files (or use **Empty all**) and confirm. Everything happens in the browser, with no terminal, on any server, in the GM session that coordinates the optimization. While the cleanup runs, *Undo* is blocked. Before emptying each file, the module checks again that nothing uses it anymore, that it has not changed since the conversion and that the optimized version downloads in full, with the recorded size and SHA-256. Anything that fails a check stays as it is and shows up under *Kept*, with the reason.

**Other worlds are not checked.** If another world uses files from this world's folder, do not empty those files.

**This cannot be undone:** the original's content is gone. Scenes, sheets and playlists keep using the optimized versions, and *Undo* no longer applies to those files. If a document points to an emptied original again (pasted from a backup, for example), the module swaps the reference for the optimized version, as it does with any file already converted.

## My connection (for everyone)

Every player (and the GM) can open **My connection** from the wifi icon in the player list (next to latency and FPS) or under *Configure Settings → Optimal Foundry*. The window shows what applies to **this device**: how much of the local cache is in use, whether P2P is on (peers, sent and received), preloading progress, the CDN and the Service Worker. There you can change this device's four options (see Settings) and **clear this device's cache** (files are downloaded again when needed).

## Settings

Under *Configure Settings → Optimal Foundry*, the GM sees three buttons: **Settings**, **Dashboard** and **My connection**. Players only see **My connection**: everything the module does with the world's files and network is decided by the GM and applies to everyone, including players' uploads.

The **Settings** window starts with the presets. Clicking a preset only fills in the form; nothing changes until you click **Save**:

| Preset | For whom |
|---|---|
| **Recommended** | Almost everyone: quality nearly identical to the original, much smaller files, image dimensions unchanged. |
| **Maximum saving** | Slow internet or many players: slightly lower quality, images capped at 4096 px, videos at 720p and without sound. |
| **Maximum quality** | Good internet and high demands on detail: light compression. |
| **Leave files alone** | Anyone who does not want any file converted: uses only preloading and sharing between players. |

Each option's explanation appears when you hover the question mark next to its name. Below come **Essentials**, with eight options explained in plain language (optimize files, what gets uploaded, what to do with the files the world already has, keep dimensions, how players reach you, your internet upload speed, download upcoming scenes ahead of time and sharing between players), and **Advanced**, collapsed by default, with the technical settings grouped into Files, Network and loading, and Sharing and cache. **Default values** resets everything to the recommended values.

Two notes:
- *How players reach you* set to **Automatic** detects on its own whether there is a CDN. The fine network settings only apply in **Custom** and are greyed out in the other profiles.
- Changing *Optimize files*, *Players share files with each other* or *Keep files in the browser* asks everyone to reload Foundry.

In **My connection**, each person adjusts only their own device: download upcoming scenes on this device, share files with the other players, fastest sending to other players and space for stored files.

## How preloading shares the bandwidth

- The GM builds a single queue with four tiers: **now** (marked scenes, the scene the GM is preparing and the scenes players are viewing), **likely** (the rest of the active scene and its playlist, whatever is playing, the neighbours in the navigation bar and in the folder, teleport destinations and anything in *Always preload*), **this session** (the rest of the navigation bar, the playlists of the scenes above and the player characters' images) and **later** (everything else in the world, including hidden scenes and playlists, which the GM can activate at any time). The queue rebuilds itself when the active scene changes, when someone switches scenes (checked every 3 seconds) or when something is edited.
- The queue covers everything, but the pace is controlled: *Share of upload for downloading ahead*, P2P between players and the space in each player's browser decide how far it goes. A browser that is almost full stops downloading the *later* tier.
- When a player is idle, they ask the GM for a batch of up to 8 files. The GM deducts the batch from the upload budget (*Share of upload for downloading ahead*) before answering; large files go out on their own. There is no request per file.
- Nobody gets a batch while another player is joining or loading a scene. When a player opens a scene, their preloading stops at once (except downloads already past the halfway mark).
- With P2P and no CDN, each large file goes from the server to a single player; the others get it from that player.
- Browsers that access the server through `localhost` (usually the GM on the server machine) do not preload: it would save nothing.

## Optimized file names

Each optimized copy is named `<name>.of-<8 characters of the hash>.<extension>`, for example `tavern.of-3fa9c21b.webp`. It sits in the same folder as the original. Originals inside `modules/` or `systems/` get their copy under `optimal-foundry/<original folder>/`, at the Data root.

Since the name changes whenever the content changes, these files can stay cached for a year with no risk of showing a stale version. That is what the CDN rules below rely on.

## Recipe for owners of a domain on Cloudflare

Example with the address `rpg.yourdomain.com`; replace it with yours.

### 1. Named tunnel

```sh
cloudflared tunnel login                      # once, creates ~/.cloudflared/cert.pem
cloudflared tunnel create foundry             # creates the tunnel and ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns foundry rpg.yourdomain.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /path/to/.cloudflared/<UUID>.json
ingress:
  - hostname: rpg.yourdomain.com
    service: http://localhost:30000
    originRequest:
      connectTimeout: 10s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
  - service: http_status:404
```

Run it with `cloudflared tunnel run foundry` or install it as a service (`cloudflared service install`).

In Foundry's `options.json`: `"hostname": "rpg.yourdomain.com"`, `"proxySSL": true`, `"proxyPort": 443` and `"upnp": false`.

### 2. Cache rules (Caching → Cache Rules)

Foundry sends `Cache-Control: no-cache` on everything, so Cloudflare only stores files when a rule tells it to.

**Rule 1: optimized files (immutable).**
- When: `(http.host eq "rpg.yourdomain.com" and http.request.uri.path contains ".of-" and http.request.uri.path.extension in {"webp" "webm" "ogg"})`
- Cache: *Eligible for cache*. Edge TTL: *Ignore cache-control header*, 1 year. Browser TTL: *Override origin*, 1 year.

**Rule 2: other world media (can change).**
- When: `(http.host eq "rpg.yourdomain.com" and not (http.request.uri.path contains ".of-") and http.request.uri.path.extension in {"png" "jpg" "jpeg" "webp" "gif" "svg" "mp3" "ogg" "wav" "m4a" "webm" "mp4"})`
- Cache: *Eligible for cache*. Edge TTL: 2 hours. Browser TTL: *Respect origin*.
- Note: Foundry silently overwrites a media file uploaded under the same name. With this rule, the old version may show for up to 2 hours. If that bothers you, use a shorter TTL or skip this rule.

Check both in Cloudflare's rule tester before playing.

### 3. Service Worker header (Rules → Transform Rules → Modify Response Header)

- When: `http.request.uri.path eq "/modules/optimal-foundry/sw.js"`
- Action: *Set static*, header `Service-Worker-Allowed`, value `/`.

Without this header, the browser does not let the module's Service Worker handle the whole site. If Foundry uses a route prefix (`routePrefix`), use that prefix in the path and in the value (for example `/rpg/modules/optimal-foundry/sw.js` and `/rpg/`).

### 4. Foundry and module files (optional, recommended)

The Service Worker does not store Foundry's code files. A cache rule on Cloudflare takes that load off the host's upload, especially when everyone joins at the same time.

- When: `(http.host eq "rpg.yourdomain.com" and (starts_with(http.request.uri.path, "/scripts/") or starts_with(http.request.uri.path, "/css/") or starts_with(http.request.uri.path, "/lang/") or starts_with(http.request.uri.path, "/fonts/") or starts_with(http.request.uri.path, "/modules/") or starts_with(http.request.uri.path, "/systems/")) and http.request.uri.path.extension in {"js" "mjs" "css" "json" "hbs" "html" "woff" "woff2" "ttf" "otf"} and not ends_with(http.request.uri.path, "/sw.js"))`
- Cache: *Eligible for cache*. Edge TTL: *Ignore cache-control header*, 1 day. Browser TTL: *Respect origin* (the browser keeps checking, but Cloudflare answers).
- Foundry does not version these addresses. **After updating Foundry, a system or a module, run *Caching → Configuration → Purge Everything*** (or wait a day). `sw.js` is left out so that a new version of the module arrives quickly.

### Cloudflare's terms

On the Free, Pro and Business plans, Cloudflare's CDN terms require paid services (Stream, R2 and so on) to serve video or a disproportionate share of large files, and Cloudflare may limit the account if that happens. A small gaming group is unlikely to draw attention, but the risk exists. If you would rather not take it, remove `webm` and `mp4` from the rules above.

## Recipe without a domain (no CDN, no header)

Works with a quick tunnel, a direct IP with HTTPS or a local network with HTTPS.

1. Copy the file `Data/modules/optimal-foundry/sw.js` to the Data root under the name **`optimal-foundry-sw.js`** (it ends up at `Data/optimal-foundry-sw.js`).
2. Reload the world.

Foundry serves that file at `/optimal-foundry-sw.js`, a path that can handle the whole site without a special header. The module tries that address first; if it does not exist, it tries the module's file; if neither works, it carries on without the local cache (the rest of the module keeps working). When you update the module, copy `sw.js` again.

Without a CDN, the automatic profile stays on *Tunnel without CDN*: the GM holds back the bandwidth and P2P relieves the host's upload.

After updating the module, if the dashboard shows the Service Worker as **outdated**, the copy in `Data/optimal-foundry-sw.js` is stale: copy `sw.js` again.

## Testing with several players on one computer

Each address (`http://localhost:30000`, `http://127.0.0.1:30000`, `http://[::1]:30000`, the public domain) has its own cookies, cache and Service Worker, so you can open one player on each in the same Chrome. Since local addresses are deliberately kept out of P2P, enable P2P for the test in the console of each local tab:

```js
localStorage["optimal-foundry.debug.allowLocalP2P"] = "1"; // then reload; remove with localStorage.removeItem(...)
```

If peers on the same computer never connect, start Chrome with `--disable-features=WebRtcHideLocalIpsWithMdns`. The dashboard's P2P tab shows the last failure with the ICE candidate types.

## Limitations

- **The module does not delete files.** Foundry gives modules no way to delete files: the Cleanup can only empty originals (0 bytes, same name), so their names still show up in the folders. Undo only re-points documents; the optimized copies stay as well. An undone file is marked as restored and is not optimized again on its own; use *Optimize again* in the dashboard to change that.
- **Uploads through a Cloudflare tunnel** are limited to 100 MB per file on the Free and Pro plans. Files that are still larger after conversion must be uploaded through the host's `localhost`.
- **Animated GIFs** that are uploaded stay as they are (there is no way to know where they will be used). In existing media, they become video only when they appear exclusively in tiles and tokens.
- **Images larger than 16383 px** on a side are skipped when the resolution is kept (a WebP limit).
- **Safari is not supported** for converting (it does not produce real WebP). Players on Safari can still play, but their uploads are converted by the GM.
- **HTTP without HTTPS:** the local cache and P2P turn themselves off.
- **P2P** uses only STUN by default. On very locked-down networks the direct connection may fail; in that case the file comes from the server as usual. A TURN server can be added under *Connection servers (STUN/TURN)*. The direct connection lets the other players in the world see your browser's IP address; turning P2P off avoids that. Browsers that reach the server through `localhost` or the local network (usually the GM on the server machine) do not take part in P2P, because their upload would share the server's link.
- **One session coordinates.** Optimizing existing media, the preload queue, the P2P tracker and the join queue run in only one session of the active GM: if they open two tabs, or the app and the browser, only the oldest one coordinates and the other stays passive. If the coordinating session closes, the other takes over at once (or within 75 seconds if it freezes). All of this only works with the GM connected; it is best to keep the GM connected through `localhost`, away from the tunnel's limits.
- **File replaced under the same name.** If an original still used by some document is replaced on the server by another file with the same name, the optimization notices from the file's signature (ETag) and converts it again, instead of pointing to the old copy.

## Publishing a new version (for maintainers)

1. Bump `version` in `module.json` (and `download`, which points to the `v<version>` tag), commit and push.
2. On GitHub, create a release with the tag `v<version>` (for example `v0.2.0`).
3. The `.github/workflows/release.yml` workflow checks that the tag matches `module.json`, builds `module.zip` with only the files Foundry uses and attaches `module.json` and `module.zip` to the release. The `releases/latest/download/module.json` link then points to the new version, and existing installs get the update through Foundry.
4. If the `FOUNDRY_RELEASE_TOKEN` secret is set in the repository (*Settings → Secrets and variables → Actions*), with the token from the package page on foundryvtt.com, the workflow also registers the version in Foundry's official package library.

## License

MIT. Includes Mediabunny (MPL-2.0) in `vendor/`.
