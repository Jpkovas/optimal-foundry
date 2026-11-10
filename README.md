# Optimal Foundry

A Foundry VTT module (v14 or newer, tested on 14.370) that makes your world lighter and faster to load for everyone. Everything runs in the browser: there is no extra server and nothing to install besides the module itself.

## What it does

- **Optimizes every upload.** Before the file reaches the server, the browser converts:
  - images to **WebP** (SVG is never touched; WebP and AVIF stay as they are);
  - videos to **WebM VP9** (with transparency when the original has it);
  - audio to **Ogg Opus**.
  Only the optimized version is stored. If the uploader's browser cannot convert, the original is uploaded and the GM converts it later, in the background.
- **Optimizes the media the world already has, your way.** The GM's client converts the media the world uses and points scenes, actors, journals, playlists and so on to the new copies. Three modes: **Automatic** (converts everything gradually, without asking), **Review first** (the default: lists what would be converted and only touches what you approve, in the dashboard's Media tab) and **Don't optimize**. The optimization **never touches the originals**, and any swap can be undone from the dashboard. Only the Cleanup (optional, in the dashboard) empties originals, and it cannot be undone. Heavy files (every video, sounds above 20 MB, images above 30 MB) wait until no player is connected, so a long conversion never slows a session. Token art picked by a name pattern (a wildcard such as `goblin-*.png`) is optimized too: the files the pattern matches are converted like any other, and once all of them are, the actor's token art pattern moves to the copies (`goblin-*.webp`), with the old pattern remembered so Undo can put it back.
- **Keeps the resolution by default.** Only the format and the quality change. Downsizing is optional.
- **Coordinates the network.** The GM shares the bandwidth between players, limits simultaneous downloads (useful on free tunnels), slows preloading down on its own when the connection gets busy, and makes players who join at the same time load the scene one at a time.
- **Preloads on its own during idle time.** When nobody is downloading anything, players fetch ahead what they will likely need, from most to least likely: the scenes the players and the GM are viewing, the rest of the active scene and its playlist, whatever is playing, the neighbouring scenes in the navigation bar and in the folder, teleport destinations, then the rest of the navigation bar, the player characters' sheets and, finally, every other scene, playlist and journal the players can see. You don't have to mark anything; marking a scene (right-click in the Scenes tab) only moves it to the front. Each player chooses how much their own browser downloads ahead.
- **Takes advantage of a CDN** (such as Cloudflare) when there is one: it detects it on its own and allows more bandwidth.
- **Shares files between players.** A player who already has an optimized file can send it straight to the others, saving the host's upload. Every file is checked by hash before it is used. Each player chooses whether to take part, because players who share see each other's IP address. Behind a CDN sharing is not used: the CDN already spares the host.
- **Local cache** in each browser, with nothing to install: optimized files are kept and never downloaded again. Other media (which can change) is kept too, but checked against the server before use, at most every 30 seconds. It turns itself on in every browser on HTTPS or `localhost`, on any hosting. It covers the images and videos of the scenes, sounds and whatever is downloaded ahead; pictures shown in sheets, journals and chat are left to the browser's own cache.

## Installation

1. Install and enable the **libWrapper** module (required).
2. In Foundry, under *Add-on Modules → Install Module*, search for **Optimal Foundry** or paste the manifest URL:
   `https://github.com/Jpkovas/optimal-foundry/releases/latest/download/module.json`
3. Enable the module in your world.
4. Log in as the GM: the welcome screen appears so you can choose how the module works. The full dashboard is under *Game Settings → Configure Settings → Optimal Foundry → Open dashboard*.

Player browsers: an up-to-date Chrome, Edge or Firefox.

**HTTPS or localhost.** Browsers only allow file conversion, the local cache and sharing between players on an `https://` address or on `localhost`. On a plain `http://` address (for example `http://192.168.0.10:30000`) those three stay off in that browser, and the module says so in the welcome screen, the Media tab and My connection. There is nothing else to set up: on a secure page the local cache starts by itself in every browser, as long as the world setting *Keep files in the browser* is on (it is by default) and the browser supports Cache Storage. What still works there: preloading through the browser's own cache (files up to 32 MB), the network control (bandwidth budget, download limits, joining one at a time) and CDN detection. Uploads from such a browser go up as they are and are converted later by a GM session that runs on HTTPS or on `localhost`.

The interface is available in English and Brazilian Portuguese.

## Welcome screen

The first time a GM enters the world with the module enabled, a screen appears to choose how it works: the file quality (the same presets as in the settings), what to do with the files the world already has (review first, automatic or leave them), whether new uploads are optimized before they go up, automatic preloading, sharing between players, the host's upload speed and the floating panel. Every card says in one line what it does. Above the choices, the screen says so when the page is not on HTTPS. **Until someone completes this screen, no existing file is converted**; preloading already runs with its defaults, and sharing starts for each player once they choose it. *Not now* closes the screen, which comes back the next time you log in. You can reopen it with the *Welcome* button in the module's settings (if you have unsaved changes there, it asks to save them first).

## The first time a player enters

A player who opens the world for the first time in a browser gets a small card with two choices, once:

- **Share files with the other players?** Yes or no, with the reminder that players who share see each other's IP address. Until the player answers, their browser opens no connection to other players.
- **How much to download ahead?** Everything (the whole world, little by little), only what this session needs, or nothing.

The lighter options are already selected when the browser's data saver is on or the connection is mobile. The card only asks about what the world uses (no sharing question behind a CDN or with sharing turned off). Both answers can be changed later in **My connection**.

## Floating panel (GM only)

A small box over the map that shows, every 2 seconds:

- what is happening with the files (which file is being converted and how much is left, how many are waiting for your approval, how many heavy files wait for the players to leave, with a *Convert now* link, paused, all up to date);
- each connected player, with a bar for how much they already have of what comes next (the scenes someone is viewing, the active scene, its neighbours and whatever is playing) and whether they are joining the scene or downloading right now; hover for details, including whether that player's browser is on HTTPS, has the local cache active and can share;
- **Everyone is ready**: when every connected player already holds everything the next scene needs, the panel turns the count green and names the scene, and one notification says so, once per scene;
- the preload queue (now, likely, later) and the sharing between players (how many browsers share and how many connections are open, or why nobody shares).

Drag it by its title bar to put it wherever you like; the position is remembered in this browser. The arrow collapses everything into a single line: the files icon with the progress or how many files are waiting, one colored dot per player (green ready, blue downloading, orange joining or still downloading what comes next, an outline when there is no information) and how many browsers share. The icon next to the arrow opens the full dashboard and the X hides the panel. It comes back with the gauge button in the **Tokens** controls, on the left. Players never see it.

## The dashboard

Only the GM can open it. It refreshes every 2 seconds, and never while you are choosing in a list or typing.

- **Media:** in *Review first* mode, first the list of what is **waiting for your approval**, with where each file is used and a button to view the image or video; check files and choose *Optimize checked*, *Optimize all* or *Leave as it is* (those no longer show up; *Retry* in the file list brings them back). Then a table of **everything the world uses**, split by origin (world folder, modules, system, Foundry's icons and sounds, other folders) and by what happened to each file (optimized, already light, queued, waiting for you, skipped, failed), plus what is not read and why (external links, SVG, module compendiums) and how many references were pointed back at an original because its optimized copy was gone. Then how much has been optimized and saved, what the browser can convert (or the one reason it cannot: the page needs HTTPS or localhost), the progress of optimizing existing media (scan, start, pause, undo all), the heavy files that wait for the players to leave (with *Convert now*) and the list of every file, with a filter and the reason each one was skipped or failed. Each optimized file can go back to the original individually; failed or skipped files can be retried, one by one or the whole filtered list, and restored files can be optimized again without converting them a second time.
- **Network:** the profile in use, limits (speeds in Mbps), whether preloading is slowed down right now because the connection is busy, the CDN detection result (and who measured it) and a table per player: downloads in progress, speed, scene ready, how much of what comes next they already have, preloading, their position in the join queue and their **browser**: HTTPS, local cache, sharing, with the reason in words when one is missing. Players with no recent status are greyed out.
- **Sharing:** how many players share and how much they passed to each other, or why nobody shares (the page is not on HTTPS, the local cache is not active, the players have not chosen yet, it is off in the settings, or the world is behind a CDN); the local cache of this browser (on or off, how much it keeps and whether the browser protects it from its own cleanup); this browser's own direct connections and the last one that failed.
- **Preloading:** the automatic prediction, with what is queued, when (now, likely, this session, later) and why; the scenes you want to move to the front (optional); and the folders and playlists that are always or never preloaded.
- **Cleanup:** empties originals that have already been replaced (see below).

Start and Pause are remembered: after pausing, optimizing existing media does not resume on its own after a reload (approving files in the review, or *Convert now*, also resumes it). It also waits while a player is joining or loading a scene.

In the **Scenes** tab, right-clicking a scene shows *Mark as next scene* / *Unmark*. Marked scenes get a small blue icon.

## Cleaning up originals

Once existing media is converted, the originals stay on disk. Foundry does not let modules delete files, but it does let them overwrite images, videos and sounds. So the dashboard's **Cleanup** tab **empties** the originals: each one stays in its folder under the same name, but becomes 0 bytes and stops taking up space. Only files that can already be emptied are listed:

- only files **inside this world's folder** (`worlds/<world>/`); files in shared Data folders are never included, because other worlds may use them;
- already converted and no longer mentioned by anything this world loads: scenes, sheets, journals, playlists, macros, chat messages, settings, **every compendium** (the world's, the system's and the active modules'), and the descriptions of the world, the system and the modules. Any mention of the file, even in text, is enough to keep it, and so is token art picked by a name pattern (a wildcard such as `goblin-*.png`) that matches the file;
- with the optimized version present and at the recorded size.

Click **Analyze**, check the files (or use **Empty all**) and confirm. Everything happens in the browser, with no terminal, on any server, in the GM session that coordinates the optimization. While the cleanup runs, *Undo* is blocked. Before emptying each file, the module checks again that nothing uses it anymore, that it has not changed since the conversion and that the optimized version downloads in full, with the recorded size and SHA-256. Anything that fails a check stays as it is and shows up under *Kept*, with the reason; if a compendium cannot be read, the whole cleanup is refused with a message naming it.

**What the check cannot see.** Other worlds on the same server, the compendiums of modules that are turned off, and macros that put a file name together while they run. If any of those uses files from this world's folder, do not empty those files. The confirmation repeats that other worlds are not checked.

**This cannot be undone:** the original's content is gone. Scenes, sheets and playlists keep using the optimized versions, and *Undo* no longer applies to those files. If a document points to an emptied original again (pasted from a backup, for example), the module swaps the reference for the optimized version, as it does with any file already converted.

## My connection (for everyone)

Every player (and the GM) can open **My connection** from the wifi icon in the player list (next to latency and FPS) or under *Configure Settings → Optimal Foundry*. The window shows what applies to **this device**: the local cache and how much of it is in use (or, when it is not active, one sentence saying why: the world setting is off, the page is not on HTTPS or the browser does not support it), whether this browser shares files (and why not), preloading progress and the CDN. There you can change this device's four options (see Settings) and **clear this device's cache** (files are downloaded again when needed).

A player who has not answered the first-run card yet finds it here, behind a **Choose** button.

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

In **My connection**, each person adjusts only their own device: share files with the other players, how much to download ahead (everything, only this session, nothing), the fastest sending to other players (in Mbps, 4 by default: keep it well below your upload speed) and the space for stored files.

Sizes are shown in KB, MB and GB of 1024 (the same unit as the size settings: a 4096 MB cache reads "4 GB"), and every speed in megabits per second (Mbps), like a speed test.

## How preloading shares the bandwidth

- The GM builds a single queue with four tiers: **now** (marked scenes, the scene the GM is preparing and the scenes players are viewing), **likely** (the rest of the active scene and its playlist, whatever is playing, the neighbours in the navigation bar and in the folder, teleport destinations and anything in *Always preload*), **this session** (the rest of the navigation bar, the playlists of the scenes above and the player characters' images) and **later** (everything else in the world, including hidden scenes and playlists, which the GM can activate at any time). The queue rebuilds itself when the active scene changes, when someone switches scenes (checked every 3 seconds) or when something is edited.
- The queue covers everything, but the pace is controlled: *Share of upload for downloading ahead* is the ceiling, sharing between players and the space in each player's browser decide how far it goes. A browser that is almost full, or whose player chose *Only this session*, stops before the *later* tier; with *Nothing* it preloads nothing. The *later* tier never takes more than half of the pace, and never the turn of a file that is needed sooner.
- **The pace adapts.** The upload speed typed in the settings is often optimistic, or shared with a screen share. The GM's session watches how long the players' browsers take to get an answer from it; when most of them slow down together, the host's connection is filling up, so the pace is halved, and it climbs back little by little once answers are quick again. The Network tab says when that is happening.
- When a player is idle, they ask the GM for a batch of up to 8 files. The GM deducts the batch from the upload budget before answering; large files go out on their own. There is no request per file.
- Nobody gets a batch while another player is joining or loading a scene. When a player opens a scene, their preloading stops at once, in the page and in the local cache (except downloads already past the halfway mark).
- With sharing and no CDN, each large file goes from the server to a single player who can share; the others get it from that player. Players who cannot share (no local cache, plain HTTP, turned off) are never made to wait for it.
- Behind a CDN, the first player to ask for a file fills the CDN from the host (that is the only part that costs upload); everyone else then gets it from the CDN at once.
- A browser on the server's own computer (`localhost`, usually the GM) does not preload: it would save nothing. A browser on the local network or on a VPN counts like any other player, because its downloads may still cross the host's connection.

## Optimized file names

Each optimized copy is named `<name>.of-<8 characters of the hash>.<extension>`, for example `tavern.of-3fa9c21b.webp`. It sits in the same folder as the original. Originals inside `modules/` or `systems/` (or among Foundry's own icons and sounds) get their copy under `worlds/<world>/optimal-foundry/<original folder>/`: inside the world's folder, so a backup or a copy of the world carries its optimized files along.

If optimized copies ever go missing (a world restored without them, a full disk), the next scan notices, points the references back at the originals and converts those files again.

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

Once the module detects the CDN, the automatic profile switches to *Behind a CDN*: more bandwidth for preloading, no joining one at a time, and no sharing between players (the CDN already delivers each file after its first download).

### 3. Foundry and module files (optional, recommended)

The local cache does not store Foundry's code files. A cache rule on Cloudflare takes that load off the host's upload, especially when everyone joins at the same time.

- When: `(http.host eq "rpg.yourdomain.com" and (starts_with(http.request.uri.path, "/scripts/") or starts_with(http.request.uri.path, "/css/") or starts_with(http.request.uri.path, "/lang/") or starts_with(http.request.uri.path, "/fonts/") or starts_with(http.request.uri.path, "/modules/") or starts_with(http.request.uri.path, "/systems/")) and http.request.uri.path.extension in {"js" "mjs" "css" "json" "hbs" "html" "woff" "woff2" "ttf" "otf"}`
- Cache: *Eligible for cache*. Edge TTL: *Ignore cache-control header*, 1 day. Browser TTL: *Respect origin* (the browser keeps checking, but Cloudflare answers).
- Foundry does not version these addresses. **After updating Foundry, a system or a module, run *Caching → Configuration → Purge Everything*** (or wait a day).

### Cloudflare's terms

On the Free, Pro and Business plans, Cloudflare's CDN terms require paid services (Stream, R2 and so on) to serve video or a disproportionate share of large files, and Cloudflare may limit the account if that happens. A small gaming group is unlikely to draw attention, but the risk exists. If you would rather not take it, remove `webm` and `mp4` from the rules above.

## Recipe without a domain (no CDN)

Works with a quick tunnel, a direct IP with HTTPS or a local network with HTTPS. Nothing beyond Installation is needed: the local cache starts by itself on any `https://` address and on `localhost`.

Without a CDN, the automatic profile stays on *Tunnel without CDN*: the GM holds back the bandwidth and the sharing between players relieves the host's upload.

**Coming from version 0.1.0 or 0.2.0?** Nothing to do. The file `optimal-foundry-sw.js` that you may have copied to the Data folder is no longer used and can be deleted, and so can the `Service-Worker-Allowed` response-header rule if you added one on a CDN. The module removes the old background piece from each browser the first time it loads, and the files players already have stay where they are.

## Removing the module

- **Disabling it in a world** is enough to stop everything: the module no longer touches any download.
- **The files it kept stay in each browser** until the player clears them: nothing is left running to remove them once the module is off. To clear them first, have each person use *Clear this device's cache* in My connection before the module is disabled. Afterwards, anyone can clear the site data of your Foundry address in their browser (in Chrome: the icon left of the address → *Site settings* → *Delete data*).
- The world keeps working without the module: documents point at the optimized copies, which are ordinary files. To go back to the originals first, use *Undo all* in the dashboard before disabling (originals emptied by the Cleanup cannot come back).

## Testing with several players on one computer

Each address (`http://localhost:30000`, `http://127.0.0.1:30000`, `http://[::1]:30000`, the public domain) has its own cookies and cache, so you can open one player on each in the same Chrome. Browsers on the server's own computer are deliberately kept out of the sharing, so enable it for the test in the console of each local tab:

```js
localStorage["optimal-foundry.debug.allowLocalP2P"] = "1"; // then reload; remove with localStorage.removeItem(...)
```

Each test player also has to answer the first-run card with *Yes, share*. If browsers on the same computer never connect, start Chrome with `--disable-features=WebRtcHideLocalIpsWithMdns`. The dashboard's Sharing tab shows the last connection that failed, with the routes the browsers tried in its tooltip.

`npm test` runs the unit tests with Node alone. `npm run smoke` (after `npm install`) drives a real, disposable Foundry world in headless Chromium; see the top of `test/live/smoke.mjs` for what it needs.

## Limitations

- **The module does not delete files.** Foundry gives modules no way to delete files: the Cleanup can only empty originals (0 bytes, same name), so their names still show up in the folders. Undo only re-points documents; the optimized copies stay as well. An undone file is marked as restored and is not optimized again on its own; use *Optimize again* in the dashboard to change that.
- **Uploads through Cloudflare** are limited to 100 MB per file on the Free and Pro plans. When the module has seen Cloudflare in front of the server, it warns about files that are still larger after conversion (upload those through the host's `localhost`) and does not start a background conversion whose result could not be uploaded.
- **Animated GIFs** that are uploaded stay as they are (there is no way to know where they will be used). In existing media, they become video only when they appear exclusively in tiles and tokens.
- **Very large images.** Images larger than 16383 px on a side are skipped when the resolution is kept (a WebP limit), and so are images above 100 megapixels (50 on devices with 4 GB of memory or less): decoding them could take the browser down.
- **Looping sounds** (ambient sounds, playlist tracks set to repeat) are converted only when the converted copy plays for exactly as long as the original; otherwise they are left as they are, because the loop would click each time it restarts. In practice loops in WAV or FLAC convert, and MP3 loops (a format that pads the audio) stay.
- **Heavy files wait for an empty table.** Videos, sounds above 20 MB and images above 30 MB are converted only while no player is connected, unless you click *Convert now*.
- **Safari is not supported** for converting (it does not produce real WebP). Players on Safari can still play, but their uploads are converted by the GM.
- **HTTP without HTTPS:** conversion, the local cache and the sharing between players turn themselves off in that browser (see Installation).
- **Sharing between players** uses only STUN by default. On very locked-down networks the direct connection may fail; in that case the file comes from the server as usual, and the game never waits for a slow player: a file the scene needs is finished from the server as soon as a player's connection is too slow. A TURN server can be added under *Connection servers (STUN/TURN)*. Players who share see each other's IP address; each player is asked once, and those who say no share nothing. A browser on the server's own computer (usually the GM) does not take part, because what it sent would use the server's own connection. Behind a CDN nobody shares.
- **One session coordinates.** Optimizing existing media, the preload queue, the sharing between players and the join queue run in only one session of the active GM: if they open two tabs, or the app and the browser, only the oldest one coordinates and the other stays passive. If the coordinating session closes, the other takes over at once (or within 75 seconds if it freezes). All of this only works with the GM connected; it is best to keep the GM connected through `localhost`, away from the tunnel's limits.
- **File replaced under the same name.** If an original still used by some document is replaced on the server by another file with the same name, the optimization notices from the file's signature (ETag) and converts it again, instead of pointing to the old copy.

## Publishing a new version (for maintainers)

1. Bump `version` in `module.json` (and `download`, which points to the `v<version>` tag), add the version's entry to `CHANGELOG.md`, commit and push. Every push and pull request runs the tests (`.github/workflows/ci.yml`).
2. On GitHub, create a release with the tag `v<version>` (for example `v0.3.0`).
3. The `.github/workflows/release.yml` workflow checks that the tag matches `module.json`, runs the tests, builds `module.zip` with only the files Foundry uses and attaches `module.json` and `module.zip` to the release. The `releases/latest/download/module.json` link then points to the new version, and existing installs get the update through Foundry.
4. If the `FOUNDRY_RELEASE_TOKEN` secret is set in the repository (*Settings → Secrets and variables → Actions*), with the token from the package page on foundryvtt.com, the workflow also registers the version in Foundry's official package library.

## License

MIT. Includes Mediabunny 1.65.2 (MPL-2.0, unmodified) in `vendor/`; see `LICENSE`.
