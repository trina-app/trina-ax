# Apps on your own computer as connectors

- Date: 2026-11-18
- Status: accepted (built for 0.5.17 (not released yet on 2026-11-19), macOS first; Windows and Linux later; plan [20261118-1731-local-app-connectors](../AGENTS/plan/20261118-1731-local-app-connectors.md))
- Supersedes: none
- Branch: feat/local-app-connectors (the owner approved the approach on 2026-11-18 and said go on 2026-11-19)

- **Ask:** the owner wants tools that run on a person's own computer, such as Aside and ego lite (browsers driven
  through MCP or a CLI), to be usable as Trina connectors. They asked for one general way for all such tools, not a
  plugin per tool. Playwright MCP, Chrome DevTools MCP and agent-browser must fit the same way.
- **The owner's call on 2026-11-19:** no PC runner, and the rules are kept lean: "no stricter than Aside itself".

## What exists today (checked in code on 2026-11-19, `origin/dev`)

- **Connectors reach a service over the internet only.** A connection is one of two kinds, `mcp` or `http`
  (`shared/src/api/integrations.ts` `IntegrationKind`). The MCP client speaks Streamable HTTP
  (`server/src/integrations/connections/mcp.ts`), and every request goes through `net.ts`: https only, public addresses
  only. `McpClient` already takes another transport (`send`): the Google apps use it to reach the library on the
  server itself (`google-apps/transport.ts`).
- **The in-app browser's relay.** The AI's browser tools already run in the desktop app: the server sends
  `browser.call` over the WebSocket of the one window that sent the message, the window answers with `browser.ack`
  and `browser.result`, calls are sent again after a reconnect, and a long-poll fallback exists for blocked
  WebSockets (`server/src/realtime/browser-relay.ts`, `server/src/routes/browser.ts`, `shared/src/desktop-bridge.ts`,
  `web/src/lib/browserRelay.ts`).
- **The PC runner is dropped.** The owner stopped it on 2026-11-12. This work does not need it and does not revive it.

## The approach

1. **One new kind: `local`, "An app on your computer".** It is always a person's own connection. The server keeps
   only the command's shape: the program, its arguments, the names of its settings (environment variables, without
   their values), and for a CLI the tools it is wrapped as. In the database it is a column `local_app` on an ordinary
   personal MCP connection, the way a Google app is (the `kind` column's CHECK lists only `mcp` and `http`, and a table
   is never rebuilt); the API calls it kind `local`.
2. **It rides the browser relay.** The relay's common part becomes `server/src/realtime/call-relay.ts`; the browser
   relay and a new sibling, the local relay, are built on it. The local relay sends `local.call` (one JSON-RPC message)
   to the window that sent the message, and gets `local.ack` and `local.result` back, with `local.cancel` when the turn
   stops. It has its own long-poll fallback (`GET /api/local-apps/calls`, `POST /api/local-apps/results`).
3. **The server speaks MCP to the desktop app.** `McpClient` gets a `send` that goes through the local relay instead
   of the network. The desktop app answers as an MCP server, through one of two adapters:
   - **(a) stdio MCP passthrough.** The desktop app starts the program (for example `aside mcp`) and passes JSON-RPC
     lines between it and the server. Any MCP server over stdio fits: Playwright MCP, Chrome DevTools MCP and others.
   - **(b) A declared CLI tool.** The person's command declares a program, an argument template and stdin. The AI fills
     typed slots only, and each slot is passed as its own argument or on stdin. ego lite is two such tools:
     `ego-browser nodejs` with the script on stdin, and its guide from `ego-browser skill`, returned as a tool result
     at run time. agent-browser fits the same way.
4. **Only from the desktop window.** Each call goes to the desktop window that sent the message, and nowhere else.
   From a phone, the web or another computer, the AI says in plain words that it can use the app on the person's
   computer only when they write from the Trina desktop app on that computer. Settings says plainly that it only works
   from the desktop app.

## Rules (lean, the owner's call on 2026-11-19)

- **Asking is the same as for other connections.** The normal ask card with "Always allow", the connection's write
  rule and the per-tool switches, exactly like any other connection. Every option of the tool goes through, computer
  use included. No extra window per script, and no new confirm when the tool's list changes.
- **Only these extra rules:**
  1. **Only the person adds the command,** in Settings on their own computer. The AI's connect card
     (`connect_service`), an admin's request to a member (`API.createIntegrationRequest`) and team templates can
     never create or fill one.
  2. **No shell.** The desktop app starts the program from an argument list, never through a shell. The AI's values
     stay separate arguments or stdin.
  3. **Personal only.** Refused for team connections, templates, requests and the skills share. `store.ts mayUse` lets
     only its owner use it, in that owner's own turn, sent from their own connected desktop window. In a shared or
     project chat that holds too (owner 2026-11-20): the owner's turn from their desktop gets it, behind the shared
     chat's card to the asker before its answer is shown to the others; another member's turn never does. A
     scheduled run or a sub-agent never gets it.
  4. **A one-time confirm on the computer,** in the desktop app's own window, never on the team page: "Connect this
     program? `<command>`". It asks again only when the command itself changes.
  5. **Setting values stay on the computer,** sealed with Electron's safeStorage. The desktop app hides them in results
     before anything leaves the computer; the server's `hide.ts` and `redact.ts` run afterwards as for any connection.
  6. **Never as root,** and a Stop control. The program is stopped on Stop and when the app quits.
  7. **An admin switch,** "Apps on your computer" in Team settings, turns the feature off for the team. Off: the kind
     is not offered and existing ones are not used in chats.

## What the person sees

1. Settings › Connectors › Add › **An app on your computer** (shown only in the desktop app). Pick Aside or ego lite,
   or type a command. Trina asks for any setting the tool needs and keeps the values on this computer.
2. The desktop app asks once in its own window: "Connect this program?" with the exact command. Connect / Cancel.
3. The connection's page shows "Works only from the Trina desktop app on this computer", whether it runs now, and Stop.
4. In a chat from the desktop app, the AI uses it like any other connection; a change asks on the normal card.
5. From a phone or the web, the AI says it can use the app only when the person writes from the desktop app on that
   computer.

## Steps

1. The relay's common part and the local relay; the server kind with every refusal; the admin switch (this plan's
   first pull request).
2. The desktop app's program manager, the confirm window, adapter (a), tried with real Aside.
3. Adapter (b) and the web Settings screens.
4. **Later:** Windows and Linux (the desktop app starts programs the same way, but the confirm, the known tools'
   commands and the tests are macOS first). Linux: [20261119-linux-desktop-app.md](20261119-linux-desktop-app.md)
   ("Apps on your computer": the AppImage's environment left out, `/snap/bin`, the keyring check).

## Aside and ego lite as their own connectors (2026-11-19)

- **The owner:** "이정도면 그냥 어사이드 에고 라이트를 슬랙처럼 공식 커넥터로 만들자 아이콘 넣고", then "컴퓨터 앱 연결은 커스텀 커넥터로
  넣으면 될듯". So Settings › Connectors › Discover has an **Aside** card and an **ego lite** card (their logos, one line, an
  install hint; `web/src/lib/localApps.ts`), and the generic "An app on your computer" card is gone. Their + (or Connect on
  their page) adds the preset command at once; the desktop app's one-time confirm follows as before. On the web or the
  phone the card says "Works in the desktop app" in grey.
- **Any other program** is a choice in **Add custom connector**: "Where does it run? On the internet / On this computer".
  A member, who adds no server by its address, gets the button in the desktop app with only "On this computer".
- **Aside's account (the owner hit it on 2026-11-19).** `aside mcp` picks one of Aside's accounts when it starts. When no
  open Aside Browser profile uses it, `browser_profiles` lists none and its tools say "none of its profiles use account
  u1 … rerun with --account u2". For the listed Aside command only (exactly `aside mcp`, never a typed command), the
  desktop app then starts the same program again with `--account <uN>` (from Aside's message, else the first account with
  profiles in `aside account list --json`, signed-in first) and runs the call once more. The program and the confirmed
  command do not change, so nothing is asked again. With no such account the AI tells the person: "Aside Browser isn't
  signed in. Open Aside and sign in, then ask again." No terminal steps (the owner: "이게 뭔데?").
- The rules above stay: the person adds it, the one-time confirm, personal only, no shell.

## When the app is closed, or the confirm waits (2026-11-20)

- **ego lite closed.** `ego-browser` starts ego lite itself through LaunchServices when it finds none (its binary has
  "Failed to start ego lite" and `--startup-ego-browser-service`, the flag the running app carries), but from the
  packaged 0.5.20 it stopped at once with exit 5, "Failed to connect to ego_cli bootstrap" and an "agent sandbox" note.
  For the listed ego lite only (never a typed command), the desktop app then opens it once in the background (`open -g
  -b com.citrolabs.ego.lite --args --startup-ego-browser-service`, no shell; never when it already runs, so nobody's
  windows are touched), waits up to 15 s, and runs the call once more (nothing ran the first time). Otherwise the AI gets
  plain words for the person: "ego lite isn't open. Open ego lite, then ask again.", "ego lite isn't installed on this
  computer. Install it from lite.ego.app, then ask again." or "ego lite is open but isn't answering. Quit ego lite, open
  it again, then ask again." (the app's language). Windows: the words only (since 2026-11-24 opened from its Start Menu
  shortcut: [20261124-windows-local-apps](20261124-windows-local-apps.md)).
- **Aside closed.** Aside starts its own app; when it cannot ("Aside isn't running on this machine"), the AI gets "Aside
  isn't open. Open Aside, then ask again."
- **The confirm left open.** A check from Settings waits 90 s. If "Connect this program?" is still open then, the desktop
  app answers `unconfirmed` just before the deadline and the connector says "Waiting for you to confirm in the desktop
  app. Press Connect there." (not "The service didn't answer in time"). The window stays open; a Connect pressed later is
  kept and the page checks the connector again by itself (`DesktopBridge.localApps.onConfirmed`). A turn's first call
  waits up to 5 minutes for the confirm (was 3).

## Every Aside profile, in every Aside account (2026-11-20)

- **The owner hit it:** Aside has 13 profiles on their Mac and Claude Code moves between all of them, but in Trina the AI
  said Aside has one profile. Aside's profiles belong to its accounts (`aside account list`), and one `aside mcp` reaches
  only the profiles of the account it started with: `browser_profiles` lists those, and a `profile_id` of another
  account is refused ("Browser profile … is not available for account u0", Aside CLI 1.26). The Aside CLI reaches every
  profile with `--account uN`.
- **For the listed Aside command only** (exactly `aside mcp`), the desktop app now:
  - answers `browser_profiles` with the main process's profiles plus every other account's, from `aside host profiles
    --account uN --json` (an older Aside without it: the profile ids `aside account list --json` binds to that
    account, with no label), each with its `account`. tools/list describes `browser_profiles` as listing every account.
  - runs `repl` or `exec` with a `profile_id` of another account (and an `exec` `session_id` started there, and a later
    `repl` without `profile_id`) in an `aside mcp --account uN` of its own, started on first use and kept beside the
    main one. Stop and quitting end all of them.
- Nothing else changes: Aside's own tools, the one-time confirm for the same command, the normal ask card and Always
  allow. With one account, Aside's own list goes through as it is and no other program starts.
- **Review on #149:** a plain `aside mcp` keeps the account it took at its first call, so the main process's account is
  the current one the first time it is read, kept on the process (`pinned`), not re-read: an `aside account use` later
  does not mislabel its profiles or route its calls elsewhere. A main process started again with a new command, or
  moved to an account, stops the `--account` ones beside it that are no longer needed. A `profile_id` no account has
  is looked for once a minute at most.

## Aside's reads (2026-11-21)

- **The owner hit it:** the AI listed Aside's browser profiles with `{}` and Trina showed the write card: "The AI wants
  to send this to Aside: Browser profiles … What it sends: `{}`", with "Always allow every change in Aside". The owner:
  "저거 보내는게 맞아?". Nothing is sent and nothing changes.
- **Why it asked:** a connection tool is a read only when the service marks it (`readOnlyHint`, mcp.ts). Aside
  1.26.1115 marks none of its four tools (no annotations in `tools/list`), so all four counted as changes.
- **Rule:** the listed Aside connector (exactly `aside mcp`) gets Trina's own read list, as a Google app keeps Trina's
  own catalog and ego lite's `read_guide` is marked in its preset (`LOCAL_APP_PRESETS` `reads`, `presetReads`):
  `browser_profiles` (profile ids, labels, connected or not) and `memory_search` (the person's own Aside notes). They
  run with no card, like any other connection's reads ("asking is the same as for other connections", "no stricter
  than Aside itself"). Claude Code, the floor, asks once for a tool and never again for it; Trina asked on every list,
  in words about sending and changing. `repl` (JavaScript in the logged-in browser) and `exec` (Aside's browser agent)
  open pages and act: they keep the card.
- **Not guessed from names:** a command the person typed (even `aside mcp --account u2`) and every other program get no
  list, only the program's own mark; a new or renamed Aside tool is a change. Names alone are not trusted (the
  shared-chat review, [20261118-shared-readonly-tools.md](20261118-shared-readonly-tools.md)).
- **Applied when the saved list is read** (`store.ts savedTools`), so a connection added before this change gets it at
  once. A local connection is never in a shared chat, a room or a schedule, so the shared-chat read rules do not apply.

## Open questions

- **Keeping the known tools list up to date.** Who checks a tool's command shape, and how a new version reaches desktop
  apps without a Trina release.
- **Tools that open a fresh browser.** Some tools open their own profile; others drive the person's everyday browser.
  The confirm says what runs; we may want plainer words for the difference.

- **Version impact:** minor (a new kind of connection, a new team setting and a new desktop bridge part).
