# DSH Desktop (Electron) runtime capabilities — floating window / tray investigation

Read-only investigation. Version: **DeepSeek Harness 0.2.0-rc.2**, Electron **44.0.0**, Windows x64.
Evidence paths are inside `resources/app.asar` unless noted. Extracted working copies used for line numbers:
`.cache/asar-lib/**` (== `/lib/**` in the asar) and `.cache/asar/**` (== `/node_modules/@deepseek-ai/**`).

---

## Q1 — Electron main process entry, and where its code lives

**Answer.** The packaged **root** `/package.json` is the Electron shell manifest; its `main` is `lib/main.js`,
and that file lives **inside `app.asar`**. `/dsh/package.json` is *not* the Electron entry — it is the bundled
Node runtime's dependency manifest and has no `main` field.

Evidence — `/package.json`:
```json
2:  "name": "@deepseek-ai/dsh-desktop",
3:  "description": "Electron desktop shell for a bundled dsh runtime and external plugins",
8:  "main": "lib/main.js",
16: "dshDesktopAppId": "com.deepseek.dsh",
```

Evidence — `/dsh/package.json:2-4` (runtime payload, no `main`):
```json
"name": "@deepseek-ai/dsh-desktop-runtime",
"private": true,
"version": "0.2.0-rc.2",
```

Asar root entries: `dsh, node_modules, lib, package.json, renderer`.
`/lib/main.js` = **490,173 bytes / 12,331 lines** (bundled, non-minified, full JSDoc retained).
Preloads also live in the asar: `/lib/preload-app.cjs`, `preload-welcome.cjs`, `preload-mandatory.cjs`,
`preload-platform-account.cjs`, `preload-update-dialog.cjs`.

`resources/app.asar.unpacked/` contains **only native/unpackable modules** under `dsh/node_modules/**`
(node-pty, sherpa-onnx-win-x64, koffi, fontkit, @swc, @img, …). **No main-process or preload code is unpacked.**

`resources/tray.ico` (15,698 bytes) is a **real file outside the asar** — see Q5.

**Verdict.** Entry = `/package.json:8` → `/lib/main.js`, 100% inside `app.asar`; the unpacked directory holds
no shell code, so any main-process change requires repacking `app.asar`.

---

## Q2 — Does the main process create the `BrowserWindow`? Every option, per site

**Answer.** Yes — four `BrowserWindow` construction sites. **`alwaysOnTop` is never used anywhere.**
`frame`/`skipTaskbar` appear only on the frameless modal update overlay.

Exhaustive grep over `/lib/main.js` (12,331 lines):
`alwaysOnTop|setAlwaysOnTop|setOverlayIcon|setThumbarButtons|setBadgeCount|setProgressBar` → **No matches found**.
The same grep over the whole extracted `@deepseek-ai/*` cache (236 MB) for
`setAlwaysOnTop|alwaysOnTop|setOverlayIcon|new BrowserWindow|skipTaskbar` → **No matches found**.

### A. Primary application window — `createWindow()` `/lib/main.js:11074-11108`
```js
11074: function createWindow(preload, show = false, primary = false) {
11075: 	const window = new BrowserWindow({
11076: 		width: 1280,
11077: 		height: 820,
11078: 		minWidth: 520,
11079: 		minHeight: 600,
11080: 		show,
11081: 		...process.platform === "win32" && primary ? {
11082: 			titleBarStyle: "hidden",
11083: 			titleBarOverlay: { height: 40, color: chromeFallbackFill(), symbolColor: ... }
11088: 		} : {},
11089: 		...process.platform === "darwin" ? {
11090: 			titleBarStyle: "hiddenInset",
11091: 			trafficLightPosition: { x: 16, y: 18 },
11095: 			vibrancy: "sidebar", visualEffectState: "active", backgroundColor: "#00000000"
11098: 		} : {},
11099: 		webPreferences: {
11100: 			preload,
11101: 			nodeIntegration: false,
11102: 			contextIsolation: true,
11103: 			sandbox: true,
11104: 			webSecurity: true,
11105: 			webviewTag: primary,
11106: 			devTools: true
11107: 		}
11108: 	});
```
Only call site — `/lib/main.js:12023`: `const window = createWindow(appPreload, false, true);`
Post-construction mutations: `setMinimumSize` (`:11667`), `setTitleBarOverlay` (`:12008`).
**No `alwaysOnTop`, no `frame`, no `skipTaskbar`.** `window.open` is hard-denied at `:11109-11112`:
```js
11109: 	window.webContents.setWindowOpenHandler(({ url }) => {
11110: 		if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
11111: 		return { action: "deny" };
11112: 	});
```

### B. Welcome window — `welcomeWindowOptions()` `/lib/main.js:7775-7813`, created at `:7824`
`width 600, height 700, useContentSize, center, resizable:false, maximizable:false, fullscreenable:false,
show:false, title, backgroundColor`; win32 → `titleBarStyle:"hidden"` + `titleBarOverlay{...}` +
`backgroundMaterial:"acrylic"` (`:7796-7804`); darwin → `titleBarStyle:"hidden"` + `vibrancy:"menu"`;
`webPreferences{preload: preload-welcome.cjs, additionalArguments, nodeIntegration:false,
contextIsolation:true, sandbox:true, webSecurity:true}`.

### C. Platform/policy login window — `/lib/main.js:9342-9358`
`width 720, height 760, parent (optional), title, autoHideMenuBar:true`, and
`webPreferences{session, nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true,
webviewTag:false, devTools:true, spellcheck:false}`.

### D. Frameless modal update overlay — `/lib/main.js:10680-10700`
```js
10680: 		const window = new BrowserWindow({
10681: 			parent,
10682: 			modal: nativeModal || process.platform !== "darwin",
10683: 			show: false,
10684: 			frame: false,
10685: 			transparent: true,
10686: 			...parent.getContentBounds(),
10687: 			resizable: false,
10688: 			minimizable: false,
10689: 			maximizable: false,
10690: 			skipTaskbar: true,
10691: 			hasShadow: false,
10692: 			title,
10693: 			webPreferences: { preload, contextIsolation: true, sandbox: true,
10697: 				nodeIntegration: false, webSecurity: true }
10700: 		});
```
This is the only frameless / taskbar-skipping window — and it is `modal` + parent-bound, so it is not a
usable "floating HUD" primitive as-is.

Taskbar attention: only `parent.flashFrame(true)` for the mandatory-update reminder (`:8902`, cleared `:8898`).

**Verdict.** The shell never requests always-on-top; the only taskbar-less/frameless recipe in the codebase
is the parent-modal update overlay, so an always-on-top HUD window does not exist and cannot be requested.

---

## Q3 — Preload script and its exposed surface

**Answer.** Yes: `/lib/preload-app.cjs` (41 KB) for the app window, bound at `/lib/main.js:11271`:
```js
11271: 	const appPreload = fileURLToPath(new URL("./preload-app.cjs", import.meta.url));
```
It runs with `contextIsolation: true, sandbox: true, nodeIntegration: false`, so raw `electron` / `ipcRenderer`
are **not** reachable from the page. `contextBridge.exposeInMainWorld` keys:

| world global | line | gating |
|---|---|---|
| `dshDesktop` | `876` | `dsh-app:` + host `app` + **main frame** |
| `dshOnboarding` | `845` | `dsh-app://app` |
| `__DSH_DIRECTORY_PICKER__` | `861` | `dsh-app://app` |
| `__DSH_HOST_PATHS__` | `862` | `dsh-app://app` |
| `dshDesktopBoot` | `863` | `dsh-app://app` |
| `dshPlatform` | `867` | `dsh-app://app` |
| `__DSH_LOCALE__` | `877` | `dsh-app://app` |

The gate and the full product API — `/lib/preload-app.cjs:789-843, 876`:
```js
789: function createProductApi() {
790: 	return {
791: 		protocolVersion: 1,
792: 		browser: createDesktopBrowserBridge(),
793: 		deviceInfo: () => electron.ipcRenderer.invoke(DESKTOP_IPC.deviceInfo),
794: 		keyboard: { closeWindow: ..., subscribe: ... },
815: 		shortcuts: { get, edit, recording, subscribe },
829: 		updates: { status, open, subscribe }
842: 	};
843: }
876: electron.contextBridge.exposeInMainWorld("dshDesktop", location.protocol === `dsh-app:` && location.hostname === "app" && process.isMainFrame ? createProductApi() : { protocolVersion: 1 });
```
`createDesktopBrowserBridge()` (`:757-785`) exposes only
`acquire(workspace)`, `release(lease)`, `onOpenRequested(lease, listener)`.

IPC channel names — `DESKTOP_IPC` `/lib/main.js:6193-6219` (25 channels, all `dsh-desktop:*`):
`shortcuts-input, shortcuts-close-window, shortcuts-get, shortcuts-edit, shortcuts-changed,
shortcuts-recording, boot, enter-workspace, onboarding-active, onboarding-api-key, boot-failed,
browser-acquire, browser-release, browser-open-requested, directory-pick, device-info, locale-bootstrap,
locale-changed, updates-status, updates-open, updates-presentation, native-theme-set, window-fullscreen,
windows-appearance, windows-menu`.
`PLATFORM_IPC` `/lib/main.js:5919-5925`: `dsh-platform:bootstrap | locale-changed | open | bounds | close`.

Every handler re-validates the caller: `assertProductSender` `/lib/main.js:11295-11298` requires
`assertDesktopSender(event, ["app"])` (`:6227-6232`, `dsh-app:` scheme + host `app`) **and**
`event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame`.

Renderer page realm: `protocol.registerSchemesAsPrivileged` (`:11019-11029`) makes `dsh-app:` standard/secure;
`protocol.handle("dsh-app", ...)` (`:11542-11551`) serves `/`, `/index.html`, `/assets/*` from the bundled
`dsh-web-frontend/dist` and **forwards everything else to the local DSH host** (so client-plugin bundles are
same-origin). Client modules are injected as same-origin **classic scripts**
(`dsh-client-modules/lib/client.js:452 const el = document.createElement("script")`), so plugin client code
executes in the **app page's main frame and shares `window`** — i.e. `window.dshDesktop` *is* reachable by a
client plugin.

**Verdict.** A rich but closed surface: plugin renderer code can reach `window.dshDesktop`, yet that object
exposes no window creation, no always-on-top, and no taskbar/tray control.

---

## Q4 — Existing IPC/HTTP mechanism to open a window, set always-on-top, or badge the taskbar

**Answer: none.** Every route was checked:

1. **All 25 `DESKTOP_IPC` + 5 `PLATFORM_IPC` channels** (Q3) — none constructs a `BrowserWindow`.
   `PLATFORM_IPC.open` `/lib/main.js:11617-11621` creates an embedded **`WebContentsView`**, not a window,
   and is hard-limited to two pages:
   ```js
   11617: 	ipcMain.handle(PLATFORM_IPC.open, (event, page, bounds) => {
   11618: 		const owner = assertMainApplication(event);
   11619: 		if (page !== "usage" && page !== "top-up") throw new Error("Invalid Platform page");
   11620: 		return platformView.open(owner, page, platformBounds(bounds));
   ```
2. **`window.open` is denied everywhere** — main window `:11109-11112`; sidebar webview guests
   `:9726-9736` (`guest.setWindowOpenHandler(... return { action: "deny" })`); login window `:9388`.
   The only escape hatch is `shell.openExternal(url)` → the **system default browser**, not an Electron window.
3. **`<webview>` is lease-gated**: `will-attach-webview` (`:9682-9707`) rejects anything whose `src` is not
   `about:blank#<lease>` issued by `browserGuests.acquire`, and it deletes every preference except
   `disablePopups` (`:9690`) so popups can never be re-enabled.
4. **Host ↔ main IPC is a closed whitelist.** The DSH host is spawned with an IPC fd
   (`/lib/main.js:3685-3690 stdio: ["ignore","pipe","pipe","ipc"]`) and every message is validated by
   `isDesktopHostEvent` `/lib/main.js:3544-3581`, which accepts only `shutdown-complete`, `ready`,
   `platform-session`, `fatal`, `update-tasks`, `quit-inspection`; anything else is fatal:
   ```js
   3698: 		child.on("message", (message) => {
   3699: 			if (!isDesktopHostEvent(message)) {
   3700: 				this.fail(new Error("dsh desktop host sent an invalid IPC event"));
   3701: 				child.kill("SIGTERM");
   ```
   So a host-side plugin calling `process.send({type:"open-window"})` would **kill the runtime**.
5. **No HTTP window-control route.** `protocol.handle` (`:11542-11551`) is pure request forwarding/asset serving.
6. **Badge/overlay/progress APIs are entirely absent** (`setOverlayIcon`, `setThumbarButtons`,
   `setBadgeCount`, `setProgressBar` → 0 hits in the whole main process).

The only "float" concept in the product is **inside the renderer**, not an OS window —
`dsh-cordis-client-runner/lib/client.js:4816-4820`:
```js
4816: 				key: "shell.overlay",
4817: 				kind: "list",
4819: 				summary: "Frame-wide floating layer, above every column and outside their scroll containers.",
4820: 				doc: "… Deliberately generic and unowned by any feature: a badge, a toast stack or a\nstatus pill all belong here … The layer itself is click-through — entries opt back into\npointer events — so an occupant never blocks the app underneath.\n\nThis is the additive seat for a frame-wide surface of your own: a fresh\n`id` is added beside the shipped entries instead of replacing them.",
```
with a copy-paste registration example at `:4869`:
```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  { name: 'shell.overlay', id: 'my-entry', order: 100, label: 'My entry' },
  () => React.createElement('div', null, 'hello'),
))
```

**Verdict.** No IPC, webview, host-message, or HTTP path can create a window, set always-on-top, or set a
taskbar overlay/badge; the only plugin-reachable "floating" surface is the in-page `shell.overlay` slot.

---

## Q5 — Tray icon and notification paths

**Tray: YES — but app-owned and not extensible.** `DesktopTray` `/lib/main.js:10831-10875`:
```js
10832: /** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */
10840: 		const tray = new Tray(nativeImage.createFromPath(options.iconPath));
10842: 		tray.on("click", () => { options.open(); });
10852: 		tray.setToolTip(messages.aboutProduct);
10853: 		tray.setContextMenu(Menu.buildFromTemplate([
10855: 				label: messages.openApplication, click: ...open
10862: 				label: messages.quitApplication, click: ...quit
10867: 		]));
```
Instantiated only on win32 at `/lib/main.js:11937-11951`:
```js
11937: 	const trayIconPath = development ? join(app.getAppPath(), "resources", "tray-windows.ico") : join(process.resourcesPath, "tray.ico");
11938: 	if (process.platform === "win32") try {
11939: 		tray = new DesktopTray({ iconPath: trayIconPath, locale: currentDesktopLocale,
11942: 			open: () => { focusPrimaryWindow(); }, quit: () => { app.quit(); } });
```
Exactly one tray icon, two menu items, no plugin API, no per-plugin icons, no balloon/overlay.

**Native notification: exists in main, but only for mandatory updates.** `/lib/main.js:8907-8924`:
```js
8908: 			if (!Notification.isSupported()) return;
8909: 			const notification = new Notification({
8910: 				title: this.locale.messages.mandatoryReady,
8911: 				body: this.locale.messages.mandatoryNotification,
8912: 				silent: true
8913: 			});
8919: 			notification.once("click", () => { ... returnToConfirmation(); });
8924: 			notification.show();
```
Hard-coded to update copy; not surfaced to plugins. No plugin-visible native-notification service exists
(grep for a notification service across `@deepseek-ai/*` finds only in-app React `Toast` primitives).

**Dialogs** are app-owned: `dialog.showOpenDialog` (`:6251`, exposed as `__DSH_DIRECTORY_PICKER__.pick`),
`dialog.showMessageBox` (`:11963`, quit confirmation), plus the custom frameless update overlay window.

**Plugin-reachable OS notification (renderer path).** The app's permission handler grants every non-media
permission — `/lib/main.js:6279-6282`:
```js
6279: 	session.setPermissionRequestHandler((contents, permission, callback, details) => {
6280: 		if (permission !== "media") {
6281: 			callback(true);
6282: 			return;
6283: 		}
```
so a client plugin's web `new Notification(...)` requests the `notifications` permission and is granted.
Caveat: `/lib/main.js` never calls `app.setAppUserModelId` (grep: no matches), so Windows toast identity
depends on the installer-created shortcut — worth one empirical check before relying on it.

**Verdict.** Tray exists but is a single app-owned icon a plugin cannot extend or decorate; the only
main-process notification is update-specific, while the renderer `Notification` API *is* available to plugins.

---

## Bottom line for a plugin in `C:\Users\User\.dsh\profiles\desktop`

A plugin is a normal local npm package: the profile declares it in `package.json`
(`dsh.profile.bundles`) / a `cordis.patch.yml` entry, and a package may carry a **client face** via its
manifest — e.g. `dsh-client-ui-chat/package.json:28-45`:
```json
"dsh": { "client": { "inject": [...], "platform": "web" } },
"exports": { "./client": { "default": "./lib/client.js" } }
```
That client bundle is served same-origin and executed in the app page's main frame.

| Capability | Feasible from a plugin without patching the app? |
|---|---|
| Always-on-top **Electron `BrowserWindow`** | **No** — no construction path, no `alwaysOnTop` anywhere, `window.open` denied |
| `setAlwaysOnTop` on the existing window | **No** — no IPC channel, no exposed API |
| Taskbar overlay/badge, thumbar buttons, progress bar | **No** — APIs absent from the shell entirely |
| Add/extend **tray** icon or menu | **No** — single app-owned `DesktopTray` |
| OS notification (toast) | **Yes** — renderer `new Notification()` (permission granted at `:6280-6282`) |
| Floating UI **inside** the app window | **Yes** — `shell.overlay` slot (`dsh-cordis-client-runner/lib/client.js:4816`), click-through until it opts into pointer events |
| A real always-on-top window owned by a **separate** process | **Yes, out-of-band** — a host-side plugin can `child_process.spawn` a helper (PowerShell/WinForms `TopMost=$true`, `ShowInTaskbar=$false`, or a small WebView2/Electron host). Not the DSH window; the plugin owns its lifecycle. |

### If patching the installed app is acceptable — minimal patch point

1. `/lib/main.js:6193` — add a channel to `DESKTOP_IPC`, e.g. `floatingWindow: "dsh-desktop:floating-window"`.
2. `/lib/main.js` next to the other handlers (`~:11652-11676`) — add
   `ipcMain.handle(DESKTOP_IPC.floatingWindow, (event, options) => { assertProductSender(event); ... })`
   returning a `new BrowserWindow({ alwaysOnTop: true, frame: false, skipTaskbar: true, show: true, ... })`.
   Reuse the existing frameless overlay recipe at `:10680-10700` and add `alwaysOnTop: true`
   (`setAlwaysOnTop(true, "screen-saver")` if it must outrank full-screen apps). A dedicated preload
   (or `preload-app.cjs` reused) is required for the new window's `webPreferences`.
3. `/lib/preload-app.cjs:789-843` — add a wrapper inside `createProductApi()`, e.g.
   `floatingWindow: { open: (o) => electron.ipcRenderer.invoke(DESKTOP_IPC.floatingWindow, o) }`
   (the preload keeps its own copy of the channel table, so mirror the new constant).
4. Repack `resources/app.asar` (root entries: `dsh, node_modules, lib, package.json, renderer`).

**Packaging/integrity risk (verified).** The asar header has **no** `integrity` key, and the exe fuse wire reads
`01 09 "101100011"` (version 1, 9 fuses) — Electron defaults for indices 0-8, i.e. index 4
`EnableEmbeddedAsarIntegrityValidation` = `'0'` (disabled). Corroborated by behaviour: the app runs fine with a
header that carries no `integrity` object, whereas Electron's documented behaviour under that fuse is to
"forcefully terminate" when the hash is absent. The exe nevertheless carries a populated
`INTEGRITY / ELECTRONASAR / #1033` PE resource:
```json
[{"file":"resources\\app.asar","alg":"SHA256","value":"db0a409dcbef4bced616c828a916c4543e0cfedf1fa1f947a994ddf9cb0f3679"}, …]
```
That value **matches** the SHA256 of the current 3,392,048-byte asar header exactly, confirming the install is
pristine — and it will stop matching after a repack. Because enforcement is off this should be harmless, but
**launch-test after repacking**; making the hash match again would mean editing the exe's resources
(`resedit`) and invalidating its Authenticode signature. `EnableNodeCliInspectArguments` is also at its
default (enabled), so `--inspect` on the main process is available if dev-time probing is ever needed.

---

### Probe scripts written during this investigation (read-only, workspace-local)
- `.tools/pe-fuse.mjs` — dumps the Electron fuse wire and PE resource *type* names.
- `.tools/pe-rsrc-dump.mjs` — walks the PE `.rsrc` tree and prints resource payloads (found `INTEGRITY/ELECTRONASAR`).
