# <app> in Chrome: the AI drives the person's own signed-in Chrome, on every install type

- Date (UTC): 2026-11-28 05:26
- Branch: `feat/trina-in-chrome`
- Status: in progress
- Where: new top-level `chrome-extension/` (an app of its own, like `desktop/`, `menubar/`, `relay/`), the core server
  (`server/src/chrome/`, `server/src/realtime/`), the web app (Settings › Browser, one sign-in page). Why: the browser
  tools are core (chat, permissions, AI connections) and a browser extension is another client of the same server.
- Version impact: **minor**. A new client, new endpoints, a new migration and a new place the browser tools run; nothing
  that worked before changes.

## Goal

Today the AI's browser runs only inside the desktop app (its in-app pane). People on the web, and every hosted team
whose AI runs on a server, have no browser at all: the AI says "the desktop app can do that". The owner: build our own
"Claude in Chrome". A person installs the extension in their Chrome (also Edge and Brave), connects it to their team
once, and the AI's browser tools then run in that Chrome, with the sites they are signed in to. Claude Code / Claude in
Chrome is the floor for the tools and the safety model; nothing of Anthropic's code or branding is used.

What changes for the person:
- Settings › Browser gets one section, "Your Chrome": Connect (opens the extension's page or shows a one-time code), the
  list of connected Chromes (name, last used, online), Disconnect. In the desktop app, one choice: where the AI's
  browser runs (this app, or my Chrome).
- In a chat, the AI uses the same browser tools; the site card shows in the chat as now ("May the AI use naver.com in
  your Chrome?", Allow once / Always allow this site / Deny). In Chrome the AI works in its own tab group "<app>", the
  extension's icon shows that it is working, and Chrome's own "started debugging this browser" bar is visible. Stop:
  the chat's Stop, the extension's Stop button, or closing Chrome's debugging bar.

## Scope

In:
1. **Extension** (`chrome-extension/`, Manifest V3, plain TypeScript bundled with `bun build`, no framework):
   service worker (connection, calls, tabs), popup (connect, status, Stop, disconnect), one page for the code. The CDP
   work is done with `chrome.debugger`, the same protocol the desktop pane drives (`desktop/src/main/pane/pane.ts`),
   and it reuses the pane's page script (`desktop/src/main/pane/page-script.js`: tree, find, text, refs, set value,
   password checks) and key parsing (`desktop/src/common/input.ts`) as they are.
2. **Pairing and connection** (no native host, so hosted teams work):
   - The person opens the popup on a page of their team (or types the team address). The extension asks Chrome for
     access to that one origin only (`optional_host_permissions`), then opens `<team>/connect-chrome?state=<32 random
     bytes>` in a tab. The team page (signed in in that Chrome, else it signs in first) says "Let <app>'s AI use this
     Chrome as @name?" with Connect / Cancel. Connect makes a one-time code (`POST /api/chrome/pair`, 32 bytes, 5
     minutes, only its sha256 kept, bound to the state) and moves the tab to `<team>/connect-chrome/done#code=…&state=…`
     (fragment: never sent to a server). The extension's worker reads that tab's address, checks the state, closes the
     tab and redeems the code.
   - Or a code from Settings › Browser › "Use a code" (8 characters from an unambiguous alphabet, 10 minutes, one use,
     at most 5 tries per code and the usual rate limit per address). The popup then shows whose account and team it
     joins and asks once more ("Only continue if this is your own account"), because a code someone else sent would
     hand them this Chrome.
   - Redeem: `POST /api/chrome/redeem {code, state?, label, version}` (no session; the code is the credential) answers
     a link token (32 random bytes, base64url; only its sha256 in `chrome_links`), the link id, the person's name and the
     team's name. The extension keeps it in `chrome.storage.local` (never `sync`), with the team origin.
   - Live connection: a WebSocket `wss://<team>/api/chrome/ws` with subprotocols `mycel.chrome.v1` and
     `mycel.chrome.t.<token>`; never a cookie, so the Origin (`chrome-extension://…`) is not needed for it. It carries
     only `browser.call` / `browser.cancel` to the extension and `browser.ack` / `browser.result` / `ping` back. It is
     not a window of the realtime hub: it gets no chat, file or presence event, does not make the person "online", and
     does not count as an open window for notifications.
   - Revocation: Disconnect in Settings (any device of the person), Disconnect in the popup, the person signing out
     everywhere / changing the password / being disabled or deleted (the hub's user-ended event), a link unused for 30
     days. A revoked link's socket closes at once (close code `4401`) and the extension forgets its token.
3. **Server**: migration `464_b_chrome_links.sql` (`chrome_links`, `chrome_pair_codes`, `user_browser_target`),
   `server/src/chrome/` (store, routes, socket registry), the browser relay sending a call to a Chrome link instead of a
   desktop window (`CallRelay` gets a small transport interface; the hub stays as it is), routing in the turn, the site
   card for Chrome, prompt words, i18n.
4. **Which Chrome a turn may drive**: only a Chrome linked by the person whose turn it is, never another member's. A
   turn from the web or the desktop app (not a phone, not a scheduled run, not a guest, not a restricted chat) uses the
   person's Chrome when one is online and (in the desktop app) they picked "My Chrome". With several online, the one
   connected most recently. In a shared chat the browser's notice once per place (`confirmSharedBrowser`) and the change
   card (`confirmSharedBrowserChange`) apply exactly as for the desktop browser: another person's message never drives
   my Chrome without my card.
5. **Tab model**: the AI works in a tab group "<app>" in the Chrome window the person used last. It reads and acts only
   on tabs in that group: tabs it opened, and tabs the person drags into the group (sharing a tab). Tab ids for the AI
   are `c<chrome tab id>`. Closing the group, or dragging a tab out, takes it away from the AI. `tabs_context` lists the
   group's tabs only.
6. **Tools**: the same set and inputs as the desktop browser (`shared/src/browser-tools.ts`): navigate, preview_start,
   read_page, find, get_page_text, computer (click, type, key, scroll, screenshot, zoom, drag, hover, wait), form_input,
   javascript_tool, read_console_messages, read_network_requests, resize_window, tabs_context / create / select /
   close, browser_batch, file_upload. The AI sees one browser; the prompt says where it runs.
   - file_upload: the same server side (tickets, checks, `prepareBrowserUpload`); the extension fetches each ticket from
     `GET /api/chrome/uploads/:ticket` with its link token (the person's own ticket, once; same 404 on any failure) and
     puts the files into the page's file field (`DataTransfer` in the page through CDP; a drop when there is no field).
     At most 20 files and 25 MB in one call in Chrome (the bytes cross into the page as base64).
7. **Sites (Rule A: Always allow is final)**: one Always per person, as decided in
   [20261125-one-site-always-desktop-browser](../../decisions/20261125-one-site-always-desktop-browser.md). The server sends
   with every call what the person already allowed (`sites`, `office`, and `anySite` for "Allow all websites"). The
   extension has no card of its own: before a call reads or acts on a site that is not allowed it answers
   `site_needed: <host>`; the server raises the existing `browser_site` card in the chat with Chrome's words, keeps an
   Always as the person's site for good (`user_allowed_sites`), and sends the call again (once per call). Navigate and
   preview_start ask before the page is opened. The address gate (`tools/url-gate.ts`) applies as for the desktop.
   - Hard blocks in the extension whatever anyone allowed: the team's own address (the AI must never press its own
     cards in the person's signed-in team page), `chrome://`, extension and Web Store pages, `file:`, `data:`,
     `javascript:`, this computer (`localhost`, loopback), and office addresses (private IPs, `.local`, one-word names)
     unless the server's office card allowed them.
8. **Safety, as the desktop browser** (the same prompt rules, the same server guards): never type passwords or payment
   details (the page script's password and card-field checks refuse them), ask before buying, sending or deleting
   (prompt; the AI's `ask_user`), the key guard (`chat/browser-keys.ts`: a key screen gets no read, screenshot or script,
   the AI hands over), page content is data never instructions, what a page brings in counts as the person's own read
   (`via: 'browser'`), the address gate for addresses in scripts. A script's tab: requests to sites the person has not
   allowed are held back (CDP `Fetch`), as the desktop's net guard does.
9. **Visible and stoppable**: the extension icon's badge shows "ON" while connected and a dot while the AI acts; the
   group's title says "<app> · working"; Chrome's debugging bar shows on the tabs it drives. Stop in the popup ends the
   running call and every call of that turn (`Stopped by the user in Chrome. Do not retry; ask the user.`); closing
   Chrome's debugging bar does the same; the chat's Stop sends `browser.cancel`.
10. **Web**: Settings › Browser "Your Chrome" section (the list, Connect, Use a code, Disconnect, and the desktop's
    choice); the page `/connect-chrome` and `/connect-chrome/done`; i18n in the six languages (`en.ts` source).
11. **Docs**: decision `docs/decisions/20261128-trina-in-chrome.md`, `docs/CONNECTIONS.md` row, `docs/ASKS.md` entries
    (`chrome.site`, `chrome.pair.confirm`, `ui.chrome.disconnect`), `changes/trina-in-chrome.md`,
    `chrome-extension/README.md` with the Web Store listing text (privacy, each permission's reason).
12. **Packaging**: `bun chrome-extension/build.ts` builds `chrome-extension/dist/`; `--zip` makes
    `chrome-extension/release/<app>-chrome-<version>.zip` for the Web Store. Branding (name, icons) comes from
    `editions/trina/branding/` at build time, as for the other apps.

Out (later):
- Publishing in the Chrome Web Store (a developer account costs $5: the owner's OK) and Edge Add-ons; the store link in
  Settings is filled in then (until then Settings links to the docs page with the unpacked install steps).
- A phone driving the person's Chrome, scheduled runs using Chrome (nobody watches them), Chrome for guests.
- The long-poll fallback for networks that block WebSockets (the extension says it cannot connect).
- A side panel chat inside Chrome (the chat stays in the app).
- Firefox and Safari.

## Steps

1. This plan and the decision file (first commit). Independent review of the plan (security, UX, product); apply cuts.
2. Server: migration, `server/src/chrome/store.ts` (codes, links, tokens, revoke, sweep), `routes/chrome.ts`, the
   socket registry `server/src/chrome/links.ts`, the relay transport, turn routing and the Chrome site card, prompt
   words, i18n keys, user-ended revocation.
3. Extension: manifest, worker (connection with backoff and keep-alive, pairing, calls through the shared contract,
   tabs in the group, CDP tools, site checks, net guard, uploads), popup, build and zip.
4. Web: Settings › Browser section, the connect pages, i18n in six languages.
5. Tests: unit (store, routes, relay routing, site card loop, revocation, cross-person and cross-team refusal, the
   extension's pure parts: site matching, blocks, tab ids), security tests (stolen code, replay, another member's
   token, a revoked token, the team origin blocked), and an e2e that loads the unpacked extension in Chromium with
   Playwright against a test server and a local test page: pair, an AI turn (scripted engine) that navigates, reads,
   clicks and types, the site card, Stop, Disconnect.
6. Checks: `bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, the area's unit
   tests. Independent security review of the final diff; fixes.
7. Real QA on qa.trina.app with a fresh Chromium profile and the QA team: pair, a multi-step task on a real site, the
   cards, Stop, Disconnect. Screenshots.
8. One PR into dev, queued with `bun run queue`.

## Decisions

- New: [docs/decisions/20261128-trina-in-chrome.md](../../decisions/20261128-trina-in-chrome.md).
- Builds on: [one site Always per person](../../decisions/20261125-one-site-always-desktop-browser.md),
  [browser key guard](../../decisions/20261124-browser-key-guard.md),
  [file upload](../../decisions/20261126-browser-file-upload.md),
  [shared chat own tools](../../decisions/20261126-shared-chat-own-tools.md) (the notice and change card),
  [connect handoff](../../decisions/20261121-connect-browser-handoff.md) (why a code in a link fragment, and why a
  code someone else made is a phishing risk).

## Risks

- **Migration** 464 (highest `4xx` on dev is 463). Check again before the PR.
- **Security**: a stolen link token drives the person's Chrome (kept only in `chrome.storage.local`, revocable, only
  calls of that person's own turns reach it, the site rules still hold); a code made by someone else (the popup names
  the account and asks); another member's turn (never routed); the team page driven by the AI (hard block); page →
  AI injection (as the desktop browser; the AI never gets more rights from a page than its own turn has).
- **Permissions in the manifest**: `debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, and optional host access for
  the one team origin. `debugger` is the strong one (it is how the AI clicks and reads in any tab it drives); the
  listing says why. No content scripts, no `<all_urls>` host access, no remote code.
- **MV3 service worker** lifetime: the worker sends an app-level ping every 20 s (WebSocket traffic keeps it alive in
  Chrome 116+) and an alarm reconnects it after Chrome stopped it.
- **Six app languages** (en, ko, ja, zh, es, id): every new string in all of them.
- The desktop app's browser is unchanged (its turn still goes to its own pane unless the person picked Chrome).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, `tests/unit/chrome-*.test.ts`,
`tests/security/chrome-link.test.ts`, the existing browser tests (`b-browser-*`, `ask-registry`, the tool-list tests),
`tests/e2e/chrome-extension.spec.ts` (Chromium with the unpacked extension).

## Result

Filled in at the end.
