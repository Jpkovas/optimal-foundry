# Changelog

## 0.2.0 (2026-11-09)

### Before you update

- **Copy one file, once.** The local cache now starts from a small bridge file: copy `optimal-foundry-sw.js` from the module's folder (`Data/modules/optimal-foundry/`) to the Data folder itself. If you had copied `sw.js` there under that name for 0.1.0, replace it: the module tells the GM when the file is missing or old, with a *Check again* button. Later updates never need a new copy.
- **Players are asked once.** Each player gets a small card the first time they enter: share files with the other players or not, and how much to download ahead. Until a player answers, their browser shares nothing.
- Two per-browser options changed and start from their defaults again: *Download upcoming scenes on this device* became *How much to download ahead* (everything, only this session, nothing), and the fastest sending to other players is now in Mbps (4 by default; it was 2 MB/s, which is 16 Mbps).

### Local cache

- The Data-folder file is a one-line bridge to the module's own worker, so a module update reaches every browser without copying anything again.
- The welcome screen, the floating panel and the dashboard show a **One step left** notice while the bridge is missing or old, with the usual place of the Data folder on Windows, macOS and Linux. Players only read that the game master has not turned on the local cache yet.
- The piece that stays in each browser removes itself after the module is disabled or uninstalled (three loads of the game page without the module), instead of intercepting media forever.
- Downloads made ahead of time run at low priority and stop, in the page and in the local cache, as soon as the game needs the connection.

### Sharing between players

- Nothing is exchanged with other players before a player says yes, and sharing starts off on data-saver and mobile connections.
- Not used behind a CDN: the CDN already delivers each file after its first download, so sharing would only spend the players' upload.
- A file is only held back for a player who can really pass it on. Before, with no local cache or with players who had opted out, a new scene's map could reach one extra player every two minutes.
- The game never waits for a slow player: a file the scene needs is finished from the server when another player's connection is too slow.
- Only a browser on the server's own computer stays out. Players on the local network or on a VPN take part and count against the host's upload like anyone else.
- The GM sees how many players share and why nobody does (no HTTPS, no local cache, not chosen yet, off in the settings, behind a CDN), from what the players report; on the server's computer it used to read "off" all the time.

### Network

- The bandwidth for downloading ahead adapts: when the players' browsers start getting slow answers from the host, it is halved, and it climbs back when the connection is free again. The Network tab says when that is happening.
- What is needed next goes first: the "later" tier never takes more than half of the pace, nor the turn of a file that is needed sooner.
- Behind a CDN, the first download of each file (the one that fills the CDN) is paced too.
- The Network tab and the floating panel show, for each player, whether their browser is on HTTPS, has the local cache active and can share.
- A video or a sound that is still buffering counts as activity, a player whose browser says "loading" forever no longer pauses everyone else, and a stalled retry of a texture no longer holds the loading bar.
- The CDN notice only appears when a CDN is found or lost, and the 100 MB upload warning only when Cloudflare is really in front of the server.

### Files

- Conversion runs outside the game's page (in a worker): converting a large map no longer freezes the canvas.
- Heavy files (every video, sounds above 20 MB, images above 30 MB) wait until no player is connected; *Convert now* in the dashboard and in the floating panel starts them anyway.
- Images above 100 megapixels (50 on devices with little memory) are skipped before they can take the browser down.
- Converted sounds keep their exact length, and a looping sound is converted only when the copy would loop without a click (in practice MP3 loops stay as they are).
- A file whose converted copy could not be uploaded through Cloudflare (over 100 MB) is skipped before the long conversion, not after.
- Optimized copies of module, system and Foundry files now go to `worlds/<world>/optimal-foundry/`, inside the world's folder, so a backup or a copy of the world carries them. Copies made by 0.1.0 stay where they are and keep working.
- Token art picked by a name pattern (`goblin-*.png`) is optimized: the files behind the pattern are converted (and listed for review with the actor), and when every one of them is, the actor's pattern moves to the copies (`goblin-*.webp`). Undo and the repair of missing copies put the old pattern back. In *Review first*, an original that was converted and later replaced by another file under the same name is offered for review again.
- If optimized copies go missing (a restored world, a full disk), the scan points the documents back at the originals and converts those files again.
- Re-pointing documents is sent in groups (a hundred items sharing an icon are one update), Adventure documents are left alone, and a run stops by itself when uploads keep failing.
- **Cleanup** checks more before it empties an original: every compendium (the world's, the system's and the active modules'), the descriptions of the world, the system and the modules, and token art picked by a name pattern. A compendium that cannot be read refuses the whole cleanup. The confirmation now says, in the dialog itself, that other worlds on the server are not checked and that emptying cannot be undone.

### Interface

- The light theme is readable: table headers, status colours and cards follow the application theme (the floating panel stays dark).
- One unit for sizes (KB, MB, GB of 1024, like the settings: a 4096 MB cache reads "4 GB") and one for speeds (Mbps everywhere).
- **Everyone is ready**: the floating panel turns green and one notification names the scene when every connected player already has what it needs.
- On a page without HTTPS the Media tab, the welcome screen, My connection and the upload notices give the one real reason (the page needs HTTPS or localhost) instead of red marks and "use Chrome".
- Plain words: "Sharing" instead of P2P and peers, "local cache" instead of Service Worker, failure reasons in sentences.
- Row actions and the floating panel's tools are real buttons (keyboard and touch reach them), and every card of the welcome screen says in one line what it does.
- Lists no longer change under your hand: a refresh waits while you choose or type, the scene picker keeps its choice, an open welcome screen is not reset, and the *Welcome* button in Settings asks before dropping unsaved changes.

### Project

- Tests run on every push and before a release is packaged; new checks keep the two languages in step, every text the code names present, and the release zip complete.
- The release zip includes the bridge file and no longer ships type declarations. `LICENSE` names the bundled Mediabunny version (1.65.2, unmodified) and where its source is.
- `npm run smoke` drives a real, disposable world in a headless browser (opt-in).

## 0.1.0

First release.
