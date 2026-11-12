# Gmail, Google Calendar, Google Docs and Google Sheets as built-in connectors, and a Connectors page in the sidebar

- Date (UTC): 2026-11-11 03:46
- Branch: `feat/google-workspace-connectors`
- Status: in progress
- Where: trina-ax core (`server/src/integrations/`, `server/src/tools/`, `scripts/system/`, `shared/src/`, `web/src/`),
  plus `shared/src/cloud-protocol/` (MIT) for hosted servers. Why: connecting outside services for the AI is core (see
  docs/REPOSITORY-RULES.md). The hosting service's side is a separate PR in trina-cloud.
- Version impact: minor. New connectors, a new page, new optional API fields and one add-only migration; nothing
  existing changes shape.

## Goal

Office workers ask the AI about their mail, their calendar and their Google Docs and Sheets. Today Trina reads Google
Drive only. After this change a person opens **Connectors** in the sidebar, picks Gmail (or Calendar, Docs, Sheets),
presses **Connect**, signs in at Google, and the AI can use it in chats, the same way Google Drive works now.

The tools come from the open-source Google Workspace MCP server (github.com/taylorwilsdon/google_workspace_mcp, MIT,
pinned version), run by each Trina server on its own machine. It keeps nothing: Trina keeps each person's Google
sign-in (sealed, like other connections) and hands the library that person's access token on each call.

Plain words check: the user sees "Connectors", "Connect", "Try in chat", "Settings", the app names and what the AI
can do. Never "MCP", "OAuth", "scope", "token", "sidecar".

## Decisions (from the owner, 2026-11-11)

1. Apps: Gmail, Google Calendar, Google Docs, Google Sheets. Google Drive stays Trina's own connector; the library's
   Drive tools are never loaded.
2. One card per app; one Google sign-in per card.
3. Reading is free. Anything that changes or sends shows the confirm card, with **Always allow** on the first card
   (the person's own setting per app, "Settings" on the detail page). Gmail send asks unless the person chose Always
   allow.
4. Docs and Sheets keep their own read tools (cell ranges, structure); their descriptions send plain "what does this
   file say" questions to `drive_read`.
5. A team switch per app ("Members can connect their own Gmail", ...), on by default. Google Drive's members switch
   becomes on by default too, for new teams only.
6. The admin's Google app (client ID and secret) is set per card. When Drive already has one, the setup offers
   "Use the same Google app as Drive" (on), plus the list of Google APIs to switch on.
7. Tool set: the library's complete tier, minus the two comment tools that need full Drive access
   (`manage_document_comment`, `manage_spreadsheet_comment`).
8. Gmail attachments: the AI reads them like a Drive file (PDF, HWP, Office, images, the existing readers); saved into
   Trina's files only when the person asks, into their own folder.
9. Disconnect on one card removes only that card's sign-in in Trina; Trina revokes at Google only when the person's
   last Google sign-in (these four and Drive) goes.
10. Rooms: @트리나 may use the caller's own Google apps in a room. What it found goes through the room's existing
    private answer (only the asker sees it until they share it, `rooms/ai.ts` decide()). That already keeps a
    person's mail out of the room, so no extra card is added (the owner's Q8 card would have said "the room will see
    this", which is not what happens).
11. Hosted servers sign in through the hosting service's Google app (the Drive broker, extended to these apps), with
    the sign-in pages styled like Trina. Until Google reviews that app only its test users can sign in; the others see
    "Not available yet". The review submission is drafted separately (not in this repo).
12. UI: a **Connectors** item in the main sidebar (desktop and phone drawer) opens one page in the style of the
    reference: search, **Connected** (a row of icons), **Popular** (Google Drive, Gmail, Calendar, Docs, Sheets first,
    then the existing MCP list) with a +. A card opens a detail page: logo, name, one line ("By Google · Read and
    manage Gmail"), **Connect** (straight to Google), three example prompts that start a chat, About, what the AI can
    do, Information (developer, category, links), the tools under "Show all tools". Connected: **Try in chat**,
    **Settings**, ⋯ (Reconnect, Disconnect). Settings › Connectors opens the same page (no second layout). Admin ›
    Connectors keeps the team setup (switches, Google app).
13. One PR into `dev` for trina-ax.

## How it fits together

- **The library on the server.** A supervised child process (like the meaning indexer: `Bun.spawn`, short env
  allowlist, restart with back-off, stopped on close), started only while at least one Google app is set up on the
  server. It listens on 127.0.0.1 and a random free port, `MCP_ENABLE_OAUTH21`, `EXTERNAL_OAUTH21_PROVIDER`,
  `WORKSPACE_MCP_STATELESS_MODE`, `WORKSPACE_MCP_DISABLE_LOCAL_FILES` on, `--tools gmail calendar docs sheets
  --tool-tier complete --disabled-tools manage_document_comment manage_spreadsheet_comment`, the validation cache off,
  `WORKSPACE_ATTACHMENT_DIR` an empty private temp folder, no OTEL. Health from `GET /health`. Linux servers only in
  this version; elsewhere (the Mac app) the cards say "Not available on this computer yet".
- **Installing it.** `scripts/system/packages.json` gets a way to describe a Python program: the interpreter from apt
  (`python3`, `python3-venv`) and a hash-pinned requirements file (every wheel with `--hash`, from the project's
  `uv.lock`, `--require-hashes --only-binary :all:`), installed into a venv by the shared installer, the image and
  `install-linux.sh`. The validator and `tests/unit/system-packages.test.ts` learn the new kind.
- **A person's connection.** Connecting a Google app makes a personal connection of a new kind (`google_app`, one per
  person and app) whose address is the built-in library (never typed by anyone, never reachable through a normal
  connection's address rules) and whose sign-in is the own-app sign-in of PR #267: the team's Google app for that
  card, `access_type=offline`, `prompt=consent`, the app's scopes plus `openid email profile` (the library checks
  the token with Google's userinfo). Every existing rule then applies unchanged: the confirm card for writes
  (`tools.ts` gate), scheduled runs, per-tool switches, sealed tokens, refresh, audit. The new parts: its write policy
  may be `allow` for the person's own connection (decision 3), and `send_gmail_message` / `draft_gmail_message`
  calls that attach by web address are refused (the library would fetch the address).
- **Hosted servers.** The broker protocol (`shared/src/cloud-protocol/drive-broker.ts`) carries which app is asked
  for; the hosting service allows only these four apps' fixed scope sets. Server side: trina-cloud PR.

## Scope

In: the four connectors, the supervised library, the package entry, migration 339_c (the Google app per card, the
team switches, the new connection kind), the sidebar Connectors page and detail pages, the admin setup per card, the
Drive default change, rooms (decision 10), attachments, the broker protocol field, five languages, docs
(INTEGRATIONS.md, a GOOGLE-APPS.md next to GOOGLE-DRIVE.md, DECISIONS.md), `changes/google-workspace-connectors.md`.

Out (later): Slides, Forms, Tasks, Chat; the Mac app; one sign-in for all apps; Google's review of the hosting
service's app; Drive write tools.

## Steps

1. Package entry and installer: the Python program kind, the hash-pinned requirements, tests.
2. The supervised library and the built-in transport to it (loopback only, the one port it was started on).
3. Migration 339_c, the `google_app` connection kind, the per-card Google app (with "same as Drive"), team switches
   (on by default; Drive's on by default for new teams), the sign-in (direct and through the broker), disconnect and
   revoke rule, API and contract.
4. Tools: listing, read/change classification from the library's annotations (`get_gmail_attachment_content` counts
   as a read), Always allow, the web-address attachment block, attachments through the existing readers, the Docs and
   Sheets descriptions, rooms.
5. Web: sidebar item, Connectors page, detail pages, connected state, Settings › Connectors redirect, admin setup per
   card, five languages.
6. Docs and changes file. Review, tests, PR into `dev`.

## Risks

- Security: a person's Google token must reach only the library on this machine, only for that person's call, never a
  log, card, tool result or audit entry (canary tests). The library accepts any Google token, so it listens on
  127.0.0.1 only, on a port Trina picked, and nothing else can name that address.
- Gmail is a restricted Google permission: a server's own app is fine for its own Workspace ("Internal") or test
  users; the hosting service's app needs Google's review for everyone else.
- Migration 339_c on top of 338 (highest C on `dev`), add-only; policy triggers recreated for new columns.
- A new child process: memory (~150 MB), restarts, shutdown; the server keeps working when it is down (cards say so).
- Five app languages; phone (390) and desktop (1440), light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` + `tests/unit/docs-site.test.ts`,
every `tests/unit/c-integration*`, `c-drive*`, `system-packages`, `remote-mcp-*` and rooms test file, new tests (a
fake library over loopback, a fake Google, canaries), `bun run test:web`, `bun run build:web`, the full web e2e, and a
real sign-in on the dev server with the Google app already set up there.

## Result

Filled in at the end.
