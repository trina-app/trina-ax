# desktop — Trina AX desktop app (component E)

Electron shell around the team's web page, plus the in-app **browser pane** the AI drives over CDP
(design tab 5 "맥·윈도우 앱", "데스크톱 앱 규칙", "앱 안 브라우저 도구"). Ported from Saram `desktop/` (d315378).

```
desktop/
  build.ts                 Bun bundler: dist/main.cjs, preload-app.cjs, preload-ui.cjs, ui/*, page-script.js
  src/common/              pure, unit-tested in tests/unit/e-*.test.ts
    address.ts             team address input -> origin (bare name -> <name>.trina.app, http only for *.localhost)
    netaddr.ts             public vs office-network (private) addresses, IPv4/IPv6 incl. mapped/NAT64/6to4/Teredo
    site-permissions.ts    "allowed sites": once (this turn) / always (saved per team) / deny; separate office scope;
                           site access "ask" (default) / "all" (every public website, office addresses still ask)
    pane-activity.ts       what goes to the activity log and the one line over the page
    pane-width.ts          the browser's width beside the team page: limits, remembered share, the edge's keys
    browser-result.ts      pane result -> BrowserResult on the wire (<= 20 items, size caps)
    teams.ts               teams.json, partitions per team, fingerprints
    trust.ts               who may use the bridge (top frame of the app view, team origin only)
    file-chooser.ts        the store build's own open dialog for the team page's file input (multiple, folder, accept)
    i18n.ts                ko / en / id / ja / es / zh strings of the desktop's own screens
    find-bar.ts            Cmd/Ctrl+F: which view the find bar searches, where it sits, its keys and count
  src/main/
    main.ts                lifecycle, mycel-ui:// protocol, IPC (sender checks), menu
    app-window.ts          window layout (the browser's edge: drag, keys, window.json), teams, team page view,
                           direct-connection switching, file chooser (store build)
    security.ts            webPreferences, navigation / frame guards, permissions, WebRTC, RTCPeerConnection removal
    find-bar.ts            the find bar's own view over the searched view (findInPage, found-in-page)
    direct.ts              /api/connect-info, pinned LAN probe, certificate pinning, session cookie mirroring
    pane/pane.ts           BrowserPane: tabs (WebContentsView), CDP tools, prompts, password and card-field refusal, cancel
    pane/net-guard.ts      office-network guard on the pane session (prompts, blocks, DNS rebinding stop)
    pane/classify.ts       host classification with DNS (cached)
    pane/page-script.js    refs / read_page / find / form helpers injected into pages
  src/preload/app.ts       window.mycelDesktop for the team page (shared/src/desktop-bridge.ts)
  src/preload/ui.ts        window.mycelUi for the desktop's own screens
  src/ui/                  welcome / team list, pane toolbar (plain TS + CSS, CSP 'self')
  e2e/                     Playwright-Electron tests, fake team servers, fixture site
```

## How a browser tool call flows

1. The engine calls a browser tool; the server (component B) sends `browser.call` over the WebSocket of the
   window that sent the turn (`ws.ts`, `browser.ts`).
2. The team page hands it to the desktop app with `createBrowserRelay` (`shared/src/desktop-bridge.ts`):
   `browser.ack`, then `window.mycelDesktop.browser.run(call)`, then `browser.result`. A replayed call (after a
   reconnect) is never run twice — the relay and the pane both dedupe by `callId`.
3. The pane checks the input (`shared/src/browser-tools.ts`), asks the person in **its own toolbar** before a site
   is used (once / always / deny) and always before office-network addresses, runs the tool over CDP, and returns
   a `BrowserResult` (screenshots the AI wants to show carry `shareToChat`).

The permission prompts (one at a time), the AI-control row ("Trina is using the browser": a pulsing dot, the AI's
latest action, a Stop button and a thin accent line over the page; docs/DECISIONS.md "AI가 브라우저를 쓰는 동안"), the activity log (☰ in the toolbar: script runs, network bodies,
requests held back or refused) with at most one dismissible line over the page for what needs the person now (a
page load stopped at an office or this-computer address, a refused password or card field), and the settings panel (⚙:
site access "ask for each new site" / "allow all websites", the sites allowed always) live in the desktop's own UI,
not in the team page: a page served through the relay can send browser commands but cannot answer the person's
prompts. The team page's Settings > Browser shows the same setting through a narrow bridge
(`mycelDesktop.browserSettings`): it can read it and make it stricter (ask, remove a site, clear the list); "allow
all websites" is only a request, which the main process confirms with its own dialog before changing anything. The
team can switch that choice off (Admin > Team settings, `Me.team.browserAllowAll`): the main process reads the policy
from the team server itself, refuses "all" and turns a saved "all" back to "ask". Where the team also lets
"Allow all websites" cover the AI's web reads (`Me.team.webAllowAll`), the person's value lives on the team server
(`Me.user.webAllowAll`); the main process follows it only when it goes from on to off (back to "ask"), never when it
goes on: this browser widens only after the person's click in the app's own dialog, which also shows the risk sentence
(`WEB_ALLOW_ALL_RISK`).

The pane never opens the team's own addresses (relay and office), this computer (localhost, 127.0.0.0/8, ::1) or
non-web schemes, whatever anyone answers; its User-Agent ends with `MycelBrowser/1` (`IN_APP_BROWSER_UA_MARK`)
so the team server can refuse it as a second line.

Packaged builds set Electron fuses (no `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `--inspect`, cookies encrypted on
disk, code only from `app.asar`); the packaged-app test therefore starts the app as a plain process.

## Commands

```sh
bun run build          # dist/ (fetches the Electron binary on first use; bun skips Electron's postinstall)
bun run app            # build and start; opens the welcome screen (MYCEL_DESKTOP_TEAM=<address> adds and opens a team)
bun run typecheck
bun run test:e2e       # build + Playwright-Electron suite against e2e/fake-team-server.ts (ports 19151–19157)
bun run dist:mac       # unsigned universal .dmg in release/ (signing / notarization needs the owner's Apple certificate)
bun run dist:win       # unsigned Windows NSIS installer (x64); builds on macOS without wine (no exe resource editing)
```

Unit tests of the pure modules run with the rest of the repo (`bun run test:unit`, files `tests/unit/e-*.test.ts`).

Dev against the local team server: `bun run dev:server` at the repo root, then
`MYCEL_DESKTOP_TEAM=http://localhost:19100 bun run app` (dev servers on `*.localhost` may use plain http).

## Environment (development / tests)

| Variable | Effect |
|---|---|
| `MYCEL_DESKTOP_USER_DATA` | user data folder (teams.json, partitions, allowed sites); without it a dev run uses `Team AX (dev)`, never the installed app's folder |
| `MYCEL_DESKTOP_TEAM` | team address to add and open at start (unpackaged builds only) |
| `MYCEL_DESKTOP_TEST_PUBLIC_HOSTS` | names mapped to 127.0.0.1 and treated as public sites (unpackaged builds only; e2e) |
| `MYCEL_DESKTOP_TEST_PRIVATE_HOSTS` | office-style names (e.g. `nas.lan`) mapped to 127.0.0.1 (unpackaged builds only; e2e) |

## Find on the page

Cmd+F (Ctrl+F), Edit › Find…, opens the find bar (`src/main/find-bar.ts`, `src/ui/findbar.ts`) over the top-right corner
of the view the keyboard is in: the team page, or the in-app browser's tab (its toolbar counts as its tab), else the
team page or the app's own screen. It is a separate small view, so the text typed into it is never part of the page it
searches. The menu's accelerator only gets a key the page did not take: Chromium gives a key to the page first and
hands it to the window's menu only when the page did not call preventDefault (macOS: performKeyEquivalent from the
unhandled-key path; Windows and Linux: the unhandled keyboard event handler). A site with its own Cmd/Ctrl+F (a document
editor in the in-app browser) keeps it. The team web app takes Cmd/Ctrl+F only where it opens its own search
(web/src/lib/searchKeys.ts, docs/decisions/20261120-search-shortcuts-slack.md): in a room, a DM, a group chat or a
thread, and on pages with no text of their own to find; in an AI chat, the file viewer and with a file or artifact
panel open it leaves the key alone, so the find bar opens there as before, and Edit › Find… always opens it. The web
app never takes Cmd/Ctrl+G (Find Next). The bar closes when its view leaves the window
(the team list, the browser closed, another tab). Tests: `tests/unit/e-find-bar.test.ts`, `e2e/find-bar.spec.ts`.
