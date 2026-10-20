# desktop — Team AX desktop app (component E)

Electron shell around the team's web page, plus the in-app **browser pane** the AI drives over CDP
(design tab 5 "맥·윈도우 앱", "데스크톱 앱 규칙", "앱 안 브라우저 도구"). Ported from Saram `desktop/` (d315378).

```
desktop/
  build.ts                 Bun bundler: dist/main.cjs, preload-app.cjs, preload-ui.cjs, ui/*, page-script.js
  src/common/              pure, unit-tested in tests/unit/e-*.test.ts
    address.ts             team address input -> origin (bare name -> <name>.treesoop.com, http only for *.localhost)
    netaddr.ts             public vs office-network (private) addresses, IPv4/IPv6 incl. mapped/NAT64/6to4/Teredo
    site-permissions.ts    "allowed sites": once (this turn) / always (saved per team) / deny; separate office scope
    browser-result.ts      pane result -> BrowserResult on the wire (<= 20 items, size caps)
    teams.ts               teams.json, partitions per team, fingerprints
    trust.ts               who may use the bridge (top frame of the app view, team origin only)
    i18n.ts                ko / en / id strings of the desktop's own screens
  src/main/
    main.ts                lifecycle, mycel-ui:// protocol, IPC (sender checks), menu
    app-window.ts          window layout, teams, team page view, direct-connection switching
    security.ts            webPreferences, navigation / frame guards, permissions, WebRTC, RTCPeerConnection removal
    direct.ts              /api/connect-info, pinned LAN probe, certificate pinning, session cookie mirroring
    pane/pane.ts           BrowserPane: tabs (WebContentsView), CDP tools, prompts, password refusal, cancel
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

The permission prompts, the "AI is using the browser" bar (with a stop button and an accent frame around the
page) and the always-shown notes (script runs, network bodies, blocked office requests, refused password fields)
live in the desktop's own UI, not in the team page: a page served through the relay can send browser commands
but cannot answer the person's prompts.

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
bun run dist:mac       # unsigned arm64 .dmg in release/ (signing / notarization needs the owner's Apple certificate)
bun run dist:win       # unsigned Windows NSIS installer (x64); builds on macOS without wine (no exe resource editing)
```

Unit tests of the pure modules run with the rest of the repo (`bun run test:unit`, files `tests/unit/e-*.test.ts`).

Dev against the local team server: `bun run dev:server` at the repo root, then
`MYCEL_DESKTOP_TEAM=http://localhost:19100 bun run app` (dev servers on `*.localhost` may use plain http).

## Environment (development / tests)

| Variable | Effect |
|---|---|
| `MYCEL_DESKTOP_USER_DATA` | user data folder (teams.json, partitions, allowed sites) |
| `MYCEL_DESKTOP_TEAM` | team address to add and open at start (unpackaged builds only) |
| `MYCEL_DESKTOP_TEST_PUBLIC_HOSTS` | names mapped to 127.0.0.1 and treated as public sites (unpackaged builds only; e2e) |
| `MYCEL_DESKTOP_TEST_PRIVATE_HOSTS` | office-style names (e.g. `nas.lan`) mapped to 127.0.0.1 (unpackaged builds only; e2e) |
