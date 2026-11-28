# <app> in Chrome: the AI drives the person's own signed-in Chrome, on every install type

- Date (UTC): 2026-11-28 05:26
- Branch: `feat/trina-in-chrome`
- Status: done
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
   - The person opens their team in Chrome and clicks the extension's icon; the popup offers "Connect to <origin>" for
     the page in front (or a field for the address). The extension asks Chrome for access to that one origin only
     (`optional_host_permissions`), makes a secret verifier (32 random bytes) and opens
     `<team>/connect-chrome?challenge=<sha256(verifier)>` in a tab. The team page (signed in in that Chrome, else it signs in
     first) shows the team's address and the account in large type: "Let <app>'s AI use this Chrome as @name?" Connect /
     Cancel. Connect makes a one-time code (`POST /api/chrome/pair`, 32 bytes, 5 minutes, only its sha256 kept, bound to
     the challenge) and moves the tab to `<team>/connect-chrome/done#code=…` (fragment: never sent to a server). The
     extension reads that tab's address (it has access to the team origin), closes the tab and redeems the code **with
     the verifier** (PKCE): a copied address or code is useless anywhere else.
   - No typed code (review: phishable both ways). One team per extension install; a person links many profiles (13).
   - Redeem: `POST /api/chrome/redeem {code, verifier, label, version}` (no session) answers a link token (32 random
     bytes; only its sha256 in `chrome_links`), the person's name, the team's name and every address of the team (its
     public address, office and relay names). The extension keeps them in `chrome.storage.local` (never `sync`).
   - Live connection: a WebSocket `wss://<team>/api/chrome/ws` (subprotocol `mycel.chrome.v1`); the token goes in the
     first frame (`{type:'auth', token}`, closed after 5 s without it), never in a header or the address. It carries
     only `browser.call` / `browser.cancel` to the extension and `browser.ack` / `browser.result` / `ping` back. It is
     not a window of the realtime hub: no chat, file or presence event, the person does not look online, it does not
     hold back notifications. A result is taken only from the connection the call went to.
   - "Online" means the extension's connection is open (Chrome running and the worker awake: it pings every 20 s, and
     an alarm reconnects it within a minute after Chrome put it to sleep).
   - Revocation: Disconnect in Settings or in the popup, a new link, the person's sessions all ending (sign out
     everywhere, password change, disabled, deleted), and 30 days unused. A revoked link's socket closes at once (close
     code `4401`) and the extension forgets its token.
3. **Server**: migration `464_b_chrome_links.sql` (`chrome_links`, `chrome_link_sites`, `chrome_pair_codes`, `user_browser_target`),
   `server/src/chrome/` (store, routes, socket registry), the browser relay sending a call to a Chrome link instead of a
   desktop window (`CallRelay` gets a small transport interface; the hub stays as it is), routing in the turn, the site
   card for Chrome, prompt words, i18n.
4. **Which Chrome a turn may drive**: only profiles linked by the person whose turn it is, never another member's. A
   turn from the web, the desktop app or the person's own scheduled run (not a phone, not a guest, not a restricted
   chat) uses the person's profiles when one is online and (in the desktop app) they turned on "Use my Chrome" (one switch, Settings ›
   Browser; the owner asked for the choice). Each step's label says "in your Chrome". In a shared chat the browser's notice once per place (`confirmSharedBrowser`) and the change
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
     At most 20 files and 25 MB in one call in Chrome (the bytes cross into the page as base64). preview_start opens a
     new tab in the group and navigates it.
7. **Sites (Rule A: Always allow is final)**: one Always per person, as decided in
   [20261125-one-site-always-desktop-browser](../../decisions/20261125-one-site-always-desktop-browser.md). The server sends
   with every call what the person already allowed (`sites`, `office`, and `anySite` for "Allow all websites"). The
   extension has no card of its own: before a call reads or acts on a site that is not allowed it answers
   `site_needed: <host>`; the server raises the existing `browser_site` card in the chat with Chrome's words, keeps an
   Always as the person's site for good (`user_allowed_sites`), and sends the call again (once per call). Navigate and
   preview_start ask before the page is opened. The address gate (`tools/url-gate.ts`) applies as for the desktop.
   - Hard blocks in the extension that no value from the server can lift (this browser holds the person's real
     cookies): every address of the team (the AI must never press its own cards in the person's signed-in team page;
     requests from a driven tab to them are cancelled too, CDP `Fetch`), account-security and password pages
     (Google, Microsoft, Apple, GitHub settings and sign-in consent screens, password managers), `chrome://`, extension
     and Web Store pages, non-web schemes, this computer (`localhost`, loopback), and office addresses (private IPs,
     `.local`, one-word names, or a page whose server answered from a private address: CDP `remoteIPAddress`) unless
     the server's office card allowed them. Each gives the AI a plain hand-over line.
   - The extension runs a fixed list of CDP methods (a unit test fails on any other); it never reads cookies or
     storage, and network reads carry no headers (addresses with auth values redacted), as the desktop's.
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
10. **Web**: Settings › Browser "Your Chrome" section (the linked Chrome with online state, how to connect, Disconnect,
    and in the desktop app the "Use my Chrome" switch); the page `/connect-chrome` and `/connect-chrome/done`; i18n in the six languages (`en.ts` source).
11. **Docs**: decision `docs/decisions/20261128-trina-in-chrome.md`, `docs/CONNECTIONS.md` row, `docs/ASKS.md` entries
    (`chrome.site`, `chrome.pair.connect`), `changes/trina-in-chrome.md`,
    `chrome-extension/README.md` with the Web Store listing text (privacy, each permission's reason).
12. **Packaging**: `bun chrome-extension/build.ts` builds `chrome-extension/dist/`; `--zip` makes
    `chrome-extension/release/<app>-chrome-<version>.zip` for the Web Store. Branding (name, icons) comes from
    `editions/trina/branding/` at build time, as for the other apps.

Out (later):
- Publishing in the Chrome Web Store (a developer account costs $5: the owner's OK) and Edge Add-ons; the store link in
  Settings is filled in then (until then Settings links to the docs page with the unpacked install steps).
- A phone driving the person's Chrome, Chrome for guests.
- The long-poll fallback for networks that block WebSockets (the extension says it cannot connect).
- A side panel chat inside Chrome (the chat stays in the app).
- Firefox and Safari.

### Beyond Claude in Chrome (the owner, 2026-11-28, after the first review)

13. **Many identities.** Each browser profile (Chrome, Edge, Brave: one extension install each) links on its own, with
    the name the person gives it at Connect ("업무 메일", "Personal"). A person links up to 20; revoking one never
    touches another. Each profile has its own site list: its Always answers, and sites the person adds; one switch
    "Only these sites" limits the profile to that list (anything else is refused there, never asked). Settings shows
    one list "Your browsers", one row per profile. A short line recommends one profile per identity; nothing forces it.
    - **The AI picks the profile per tool call, with no human step** (the owner; Claude in Chrome needs its `/chrome` menu
      to switch browsers): every browser tool takes an optional `profile` (the profile's name or id), and the Browser
      rules list the person's profiles (name, id, open or not, the sites allowed there; no sites in a shared chat). One
      run can read in profile A and write mail in profile B back to back. Without `profile` a call goes to the profile the
      run used last, else to the one profile whose sites hold the address (two profiles holding it is no pin), else to
      the only open one; else the AI is told to pass `profile` and to ask the user once when the task does not say which
      account. A named or pinned profile that is not open is refused, never swapped for another.
    - Tabs, site permissions and runs are per profile: a tab id of profile A means nothing in B, and an Always in A never
      opens anything in B.
    - The accounts signed in inside a profile are not read (that needs Chrome's `identity.email` permission); the name
      says it, and the AI learns the rest from the pages.
14. **Many runs at once.** Chats, scheduled tasks and sub-agents can use browsers at the same time. Each run (a chat or a
    scheduled run, `BrowserCall.run`) gets its own **background window** in the profile, its tabs in a group named after
    it; the extension never focuses or raises a window and never touches the person's own tabs. A run sees and drives
    only its own tabs (another run's tab id is "no such tab"); a tab the person drags into a run's group joins that run.
    At most 4 runs at once per profile; a fifth is told at once that the profile is busy. The popup lists the running
    runs, each with its own Stop; closing a run's window stops that run only.
15. **Approvals that don't block automation (Rule A).** An Always on the Chrome site card is kept for that profile and
    site (`chrome_link_sites`), and holds in every chat and in the person's scheduled runs. The person's other web
    Always answers (`user_allowed_sites`) and "Allow all websites" do not open anything in a profile (blast radius: a
    profile holds a real account). A scheduled run uses only what its profiles already allow: no site card (a site
    nobody allowed is refused with one line saying how to allow it), no `javascript_tool`. "Only these sites" limits a
    profile to its list: anything else is refused there, never asked. What the scheduled task's own instruction asks
    for counts as the person's OK for the buying, sending or deleting it names; anything else it does not do. No new
    card kind.

### Plan review, round 2 (2026-11-28)

Applied: one place for a profile's Always (its own list only; the person-wide list and Allow all do not count there), a
pinned or named profile that is offline is refused (no fallback), two profiles holding a site is no pin, `run` set by
the server on every Chrome call, the 21st link refused (`links_full`, nothing removed), a re-link of the same install
replaces its own row (`previous`), a busy profile answers at once, tabs a run's tab opens join that run, no site lists
in a shared chat, titles cut to 30 characters, scheduled runs with no site card and no script. Not taken: fixing the
profile at a run's first call and a card before switching (the owner wants the AI to switch per call with no human
step; the profile's own site rules are the guard, and a page cannot widen them); cutting "Only these sites" and
scheduled runs (the owner asked for both). To check in QA: background windows and their screenshots on macOS and
Windows (fallback: one AI window per profile with a group per run).

### Reference extensions (read 2026-11-28; ideas, not wording or assets)

| | Claude in Chrome | BrowserAgent | Dassi | Ours |
|---|---|---|---|---|
| Pairing | signed in to claude.ai; Claude Code through a native host and a bridge, same account and org | none (local models) | Google sign-in; own API key | signed-in team page + PKCE code; no native host, so hosted teams work |
| Where the chat is | side panel | side panel | side panel | the team app's chat (web or desktop); the popup only shows state and Stop |
| Agent working | its tabs in a colored group | not verified | screenshots to check | a background window per run, its group named after the chat, badge, Chrome's debugging bar |
| Stop | not documented ("stop the task") | not verified | not verified | per run in the popup, the chat's Stop, closing the window or the debugging bar |
| Approvals | auto (default) or manual; per-site for the session; asks on money and downloads; admin lists | optional host access | "approval gates" (not verified) | per profile and site, Always is final (Rule A); hard blocks for account security, team pages; no auto-approve of new sites |
| Profiles | reported to lose the connection with several profiles; one browser per session, `/chrome` to switch | not verified | not verified | many profiles, each named; the AI picks one per call |
| Many tasks | one session per group | not verified | multiple tabs | many runs at once, each in its own window, never focus |
| Scheduling | daily/weekly, Chrome must be open; signing out deletes them | none | "scheduled skills" | the team's scheduled tasks use a profile's own Always answers; refused with how-to otherwise |
| Permissions | 17 incl. debugger, tabs, nativeMessaging, `<all_urls>` | sidePanel, activeTab, scripting, tabs, optional hosts | not verified | debugger, tabGroups, storage, alarms, activeTab, optional host for the team only |
| Complaints seen | auto-click worries, lost connection with several profiles, worker going idle, org mismatch | too few ratings | pricing unclear | answered by: manual first-site cards, named profiles, ping + alarm reconnect, the popup names team and account |

Take: tab groups as the visible mark of what the AI owns; a hand-over at sign-in pages and CAPTCHAs; a clear
"connected to which team, as whom, in which profile" line and reconnect as a normal state; optional host access instead
of `<all_urls>`. Skip: a side-panel chat (the chat is the team app, so one place for history and cards), auto-approve of
new sites (Rule A keeps one Always per site instead), local models and own API keys (the team's AI connection is the
one), the `tabs` and `<all_urls>` permissions.

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
- **Review of the plan (2026-11-28)**: applied PKCE, the cut of the typed code, one Chrome per person, the token in
  the first frame, the extension's own blocks, the CDP list, the private-address check, no `tabs`. Not taken: a
  confirm card for buying, sending or deleting on allowed sites (the desktop browser has none either; Rule A and lean
  UI; the prompt rule and the payment-field refusal stay), cutting file_upload and the desktop choice (both asked for).
  Deferred: an e-mail when a Chrome is linked; the Web Store listing (owner's $5 OK).
- **Security**: a stolen link token drives the person's Chrome (kept only in `chrome.storage.local`, revocable, only
  calls of that person's own turns reach it, the site rules still hold); a code made by someone else (the popup names
  the account and asks); another member's turn (never routed); the team page driven by the AI (hard block); page →
  AI injection (as the desktop browser; the AI never gets more rights from a page than its own turn has).
- **Permissions in the manifest**: `debugger`, `tabGroups`, `storage`, `alarms`, `activeTab`, and optional host access
  for the one team origin (no `tabs`: addresses come from CDP on the tabs it drives). `debugger` is the strong one (it is how the AI clicks and reads in any tab it drives); the
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

Built as planned with the owner's additions (13–15) and both plan reviews applied.
- Extension `chrome-extension/` (MV3; permissions debugger, tabGroups, storage, alarms, activeTab, optional host access
  for the team only), `bun chrome-extension/build.ts --zip` makes the Web Store zip; the listing kit (en, ko, privacy
  answers, icons) is in `chrome-extension/store/`.
- Server: migration 464, `server/src/chrome/`, `routes/chrome.ts`, the relay's window transport, per-call profiles
  (`profile` on every browser tool), per-profile site Always, runs in their own windows, scheduled runs without cards
  or scripts.
- Web: Settings › Browser › Your browsers, `/connect-chrome`, the profile-named site card.
- Security review of the diff: 2 HIGH, 4 MEDIUM, 7 LOW; fixed all but L2 (office grants are per person, as on the
  desktop: accepted) and what the extension cannot see (listed in `chrome-extension/README.md` "Limits").
- Tests: `tests/unit/chrome-link.test.ts`, `tests/unit/chrome-ext-*.test.ts`, `web/test/unit/chrome-link.test.tsx`,
  `web/test/e2e/chrome-link.spec.ts`, `tests/e2e/chrome-extension.test.ts` (the unpacked extension in two Chromium
  profiles of one person against the real server: per-call profile switching, the site card, Stop, Disconnect).
- Local QA with the real AI (two profiles): pairing through the real pages, a task across both profiles on real sites,
  a real form filled, Stop per run, Disconnect of one profile.
- Differs from the plan: a site the person typed in their own message opens without the Chrome card for the rest of
  that answer in that profile (as the desktop browser does); clicks that would lead a driven page to a site nobody
  allowed are held back and the AI is told to navigate (the card then asks).
