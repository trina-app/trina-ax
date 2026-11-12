# One Google connection: every Google tool through the Workspace MCP library

- Date (UTC): 2026-11-11 09:57
- Branch: `feat/google-one-library`
- Status: in progress (step 5 merged first, see Result)
- Where: `server/src/integrations/google-apps/`, `server/src/integrations/google-drive/`, `shared/src/`, `web/src/components/integrations/`, `desktop/`, `scripts/system/packages.json`. Why: Google connections are core server features (see docs/REPOSITORY-RULES.md)
- Version impact: minor. New tools (Drive create/edit/share for a person's own Drive) and one Google card replace three
  ways of reaching Google; nothing a team uses is removed (team shares stay), and old apps keep working against the
  new server.

## Goal

Today a Google account reaches Trina three ways: Trina's own Drive code (`google-drive/`, Drive REST API), the
open-source Google Workspace MCP library for Gmail, Calendar, Docs and Sheets (`google-apps/`, one card and one
sign-in per app), and Google's hosted MCP servers through "Your own app". A person signs in to Google up to five
times, and the same job is done by three pieces of code.

After this change:

- **One Google card, one sign-in.** A person presses Connect once and the AI can use their Drive, Gmail, Calendar,
  Docs and Sheets.
- **One source of Google tools:** the library (`workspace-mcp`, pinned in `scripts/system/packages.json`), Drive
  included. We do not fork or patch it. Every rule Trina needs is applied by Trina in front of it (below).
- **Team shares stay**, read-only, with the same folder limits and the same "who may use it" rule as today.
- **The Mac app runs the library too**, so no platform loses Google.
- "Your own app" for Google's hosted MCP servers stays as it is: it is the generic MCP connection, not a Google
  feature, and some admins may want it.

Plain-words check: the card says "Google" and "Connect"; it lists what the AI can do in each app in everyday words
("find and read your files", "send mail after you confirm"). No "MCP", "scope", "token" or "library" in the UI.

## How it works

```
AI tool call ──▶ Trina gate (TypeScript, tested)            ──▶ library on 127.0.0.1 ──▶ Google
                 · whose Google sign-in (person or team share)     (stateless, keeps nothing)
                 · may this person use it (rule, members' switch)
                 · read or change? change = confirm card / Always allow
                 · team share: read tools only, folder limits before and after
                 · refuse dangerous arguments (fileUrl, local paths)
                 · files: our own readers (Hangul, scans, photos)
```

The library already runs this way for Gmail and Calendar (`transport.ts`: loopback only, the person's token per
call, no proxy). This change widens what goes through that path; it adds no second path.

### The library's Drive tools (v2.4.1, `gdrive/drive_tools.py`)

| Tool | Own Drive | Team share |
|---|---|---|
| `search_drive_files`, `list_drive_items` | yes | yes, query built by Trina, results filtered |
| `get_drive_file_content` | not offered: `get_drive_file_download_url` + our readers instead | same |
| `get_drive_file_download_url` (stateless: bytes come back inline) | yes, through our readers | yes, file checked inside first |
| `create_drive_file`, `create_drive_folder`, `update_drive_file`, `copy_drive_file`, `import_to_google_*` | yes, confirm card | no |
| `manage_drive_access`, `set_drive_file_permissions`, `get_drive_shareable_link` | yes, confirm card (shows who gets which access) | no |
| `get_drive_file_permissions`, `check_drive_file_public_access` | yes | no |

`create_drive_file` with `fileUrl` is refused before the call (the library would fetch that address from the server),
like the Gmail attachment `url`/`path` rule today.

### Team shares through the library (the hard part)

The library accepts any token and knows nothing of Trina members or folders, so Trina decides everything:

1. The gate picks the token: `source: "team:<name>"` uses the share's sealed token (as today), only for a person the
   share's rule includes today, checked before and after the call (share version fences calls under way).
2. Only read tools are offered for a team share. The share keeps signing in with `drive.readonly`: even a bug in the
   gate cannot change the admin's files.
3. **Before the call:** a file or folder ID argument must be inside the share (`read.ts` `FolderScope`, `Ancestry`,
   moved, not rewritten). Search never passes the AI's text as a Drive query: Trina builds
   `fullText contains '<escaped>'` itself (the library passes a structured query through unchanged).
4. **After the call:** the library answers in plain text. Trina reads the IDs from it with a parser for the pinned
   version and drops every item outside the share. A line it cannot read means the whole answer is refused (fail
   closed). A fixture captured from the real v2.4.1 output is in the tests, so a library update that changes the
   format fails CI before it ships.
5. A file outside answers exactly like a file that does not exist; results name their `source` and `otherSources`,
   as today.

### Reading files

The library's own text reader is not offered. Reads use `get_drive_file_download_url`, which in stateless mode returns
the file as an embedded resource; Trina hands the bytes to the existing readers (`files/extract.ts`: PDF text layer,
HWP/HWPX, Office, spreadsheets with every tab, photos as image blocks), with today's size limits, the untrusted-data
wrapper and the read-scope / taint rules. Gmail attachments already work this way (`attachments.ts`).

### One sign-in

- A person's Google connection becomes one row (`integrations`, `google_app = 'google'`) with the union of the scopes:
  identity, Gmail (as today), Calendar, Docs, Sheets and `drive` (full Drive, for the person's own Drive edits and
  sharing). A sign-in where a box is unticked is refused, as today.
- Existing Drive connections (`drive_connections`) and per-app rows stop being used: the card asks each person to
  connect once (agreed). Disconnect/revoke rules stay ("revoke only for the last Google sign-in").
- Team shares keep their own sign-in (`drive_team_shares`, `drive.readonly`), the admin flow, the notices and the
  "admin left" handling unchanged.
- Admin settings collapse to one Google client (Admin › Connected apps › Google), with "Members can connect their own
  Google" and a per-app switch (Drive, Gmail, Calendar, Docs, Sheets) so a team can leave an app off.

### Hosted teams

Each hosted team has its own address under the team domain, and Google accepts only exact return addresses. The
broker (`shared/src/cloud-protocol/drive-broker.ts`) already solves that: Google returns to the hosting service's one
registered address, which hands the browser on to the team's own callback. A new team needs nothing at Google.

This change adds a broker app `google` with the combined scope list (`GOOGLE_APP_BROKER_SCOPES`). The hosting
service's side (separate repo) must accept it before hosted teams see the new card; until then the server keeps the
per-app cards there (`service_limited`, as now). Google reviews the hosting service's app once for the combined
scopes (Gmail and full Drive are restricted: verification and a yearly security assessment); until then only its
test users can sign in. Self-hosted teams use their own client and are not affected.

### Self-installed servers through the broker

Today only hosted teams sign in through the broker: the team server checks `isHosted` (`broker.ts` `driveBrokerFor`),
and the hosting service trusts only the relay key of a team it made itself and returns the browser only to that
team's `<slug>` address. A self-installed server must make its own Google client, register its own return address
and go through Google's review itself. That is too much for an ordinary office, and it is why our own dev server
(a self-installed server under the trina.app domain) cannot use the broker.

The change: a self-installed server may use the broker **when the hosting service has registered it**.

- **Team server (this repo):** `driveBrokerFor` no longer requires `deployment: "hosted"`. Setting
  `MYCEL_GOOGLE_DRIVE_BROKER_URL` is already an explicit operator choice, and a Google client of the server's own
  still wins (nothing changes for a server that has one). The server signs with its relay team key as a hosted one
  does (the key exists even when the relay is off). `admin.js google-broker-key` prints the public key and the
  server's public address, for the operator to register. The admin page says "Google sign-in comes from Trina"; a
  server the hosting service does not serve (not registered, or removed) keeps the card at "Not available yet", as now.
- **Hosting service (separate repo, contract here):** a list of registered servers, each with its public key and its
  **exact** https address, added and removed only by an operator (ops API / CLI, audited). The broker serves a call
  signed by a hosted team's key or by a registered server's key; the browser goes back only to the address recorded
  for that key, never to one from the request. Limits per server as per team. Removing a server stops its
  sign-ins at once (status says no; refresh refuses).
- **Contract:** no new wire field. Only who is served changes; `drive-broker.ts` documents it.

For the people on a registered server it looks exactly like a hosted team: the same Google app, the same start
page on the account host, the same "Google sign-in comes from Trina" on the admin page.

Hosting-service side, in detail (its own plan and PR in its repo, built against this contract):

- A table of registered servers: id, display name, exact origin (`https://<host>`, no path), the server's relay
  public key (SPKI, unique), `enabled`, who added it and when. Added, disabled and removed only by an operator
  (ops CLI and ops API), each change audited. No console page for customers in this step.
- The broker's key lookup: a hosted team's primary tenant key **or** an enabled registered server's key. One key can
  never be both (checked at registration).
- Where the browser goes: a hosted team's `<slug>` address as now, or the registered server's recorded origin. Never
  an address from a request.
- Sealed refresh tokens bind to the registered server's id (`drive-broker.refresh_token|server:<id>`), so a hosted
  team's token never opens for it, nor the other way round.
- The same limits, nonce rule, log rule and start page (it shows the server's display name and host).
- Disabling or removing a server: `status` answers no, `start`, `redeem` and `refresh` refuse at once.

Rejected:

- **Record the server as a hosted team in the hosting service's database.** A hosted team must have a machine the
  hosting service runs; it would back it up, monitor it, roll out releases to it and bill it, against a machine it
  does not manage.
- **Move the dev server onto the hosting service as a real hosted team.** Hosted teams take release updates from the
  hosting service, so it would stop installing every `dev` build and stop being the dev server.

Our dev server is the first registered server: its own Google client is removed (a copy kept), the broker URL is set,
and its people connect Google again through the broker. Its address at Google does not change, because Google only
ever sees the hosting service's one return address.

### Mac app

The Mac app gets the library in the same pinned way as Linux: a standalone Python build for macOS (arm64, x86_64)
plus the same wheels, each with its sha256 in `scripts/system/packages.json`, installed into the app's support folder
on first use (not inside the signed app bundle). Every binary is checked against the list before it runs. The Mac App
Store build runs it inside the app sandbox; signing and sandbox rules are checked on a real build before this step
merges.

## Scope

In:
- Self-installed servers may sign in through the hosting service's Google app once registered; our dev server is the first.
- Drive tools from the library behind the Trina gate (own Drive read/write/share, team shares read-only).
- One Google card and one sign-in; one admin client with per-app switches; the broker app `google`.
- The library on the Mac app (desktop and Mac App Store).
- Removing Trina's own Drive API calls (`client.ts`, the request part of `read.ts`) once the above is on everywhere.
- Docs: GOOGLE-DRIVE.md, GOOGLE-APPS.md, GOOGLE-APPS-RUNTIME.md, INTEGRATIONS.md; `changes/google-one-connection.md`.

Out:
- Writing into team shares (read-only by decision).
- The hosting service's broker change (separate repo; this plan only defines the contract).
- Google's app verification (an owner task with Google).
- Forking or patching the library. If we hit something only the library can fix, it goes upstream as a PR.

## Steps (one small PR each, into `dev`)

1. **Plan** (this file).
2. **Gate in front of the library for Drive:** turn on the Drive tools in `catalog.ts`; per-tool policy table (read /
   change / never on a share); refuse `fileUrl`; reads through `get_drive_file_download_url` + `files/extract.ts`.
   Behind the old card at first: only the Gmail/Docs/Sheets connections' Drive tools, so nothing changes for
   users yet.
3. **Team shares through the gate:** move `FolderScope`/`Ancestry` from `read.ts` to the gate; the v2.4.1 output
   parser with captured fixtures; source selection (`mine` / `team:<name>`); run the whole `c-drive-shares` suite
   against the new path.
4. **One sign-in:** `google_app = 'google'`, combined scopes, migration (next free number in `server/migrations/` on
   `dev` at the time; today the highest `3xx` is 341), one card in Connected apps, admin page with per-app switches,
   broker app `google` in `shared/src/cloud-protocol/drive-broker.ts` (contract only, MIT folder).
5. **Self-installed servers through the broker:** `driveBrokerFor` without the hosted check, `admin.js
   google-broker-key`, admin page wording, docs. The hosting service's registered-server list ships in its own repo
   in the same week. Then the dev server switches over (after the owner's OK: it changes a live server and asks its
   people to connect again). Its package sync is `blocked` today (`python3-venv` missing, the library needs it), so
   `install-linux.sh repair --from <kit>` runs first, at a quiet time (it ends answers in progress).
6. **Mac app:** pinned Python + wheels for macOS in `packages.json`, install on first use, run from
   `library.ts` (`platform` check opens for darwin), Mac App Store sandbox build checked.
7. **Remove the old Drive path:** `drive_search` / `drive_list` / `drive_read` become names the gate serves (old
   chats and scheduled tasks keep working), `client.ts` and the Drive REST calls go; docs updated.
8. Real-Google check on the dev server, through the broker, with a test Google account, QA sheet rows, then `Status: done`.

## Risks

- **Team-share leak:** the largest risk. Mitigations: read tools only, `drive.readonly` on share tokens, Trina-built
  queries, checks before and after, fail-closed parser, pinned fixtures, the existing share test suite on the new path,
  an independent review of step 3.
- **Library output format changes** on an update: caught by the fixtures; the version stays pinned until they pass.
- **Library down:** the AI is told Google is not reachable; the rest of Trina works (as today for Gmail).
- **Re-sign-in for everyone:** agreed; the card explains it in one line. Team shares need no new sign-in.
- **Google review** for the hosting service's combined scopes; hosted teams stay on test users until then.
- **Mac App Store sandbox** may refuse running a downloaded Python; if so, step 5 bundles it inside the app instead
  (larger download), decided on a real build.
- **Our Google app serving self-installed servers:** only servers an operator registered, each bound to one key and one exact address; removing one stops it at once. Their sign-ins count toward the Google app's test-user limit until Google's review is done.
- **Dev server switch:** its people connect Google again; the old client file is kept so it can switch back.
- **Migration number clash:** check `server/migrations/` on `dev` right before step 4 merges.
- **Five app languages:** every new string in `en.ts` first, then the other four; `bun run check:i18n`.
- **Rooms:** @트리나 in a room still uses only the asker's own Google; answers stay private to the asker.

## Tests

- Every PR: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the Google unit tests
  (`tests/unit/c-drive-*.test.ts`, `tests/unit/c-google-apps-*.test.ts`) and `web/test/unit/integrations.test.ts`.
- New: gate policy per tool (share refuses every change tool, `fileUrl` refused), share filtering with captured
  v2.4.1 output (inside, outside, a file in two folders, a shortcut, an unreadable line), reads through our readers
  (HWP, scanned PDF, photo, Sheets all tabs), one sign-in with a box unticked, members' and per-app switches,
  revoke only for the last sign-in, tokens never in any answer/log/audit.
- Step 4 and 7: the full web e2e (the card and admin page change).
- Step 5: a registered self-installed server signs in through a fake broker; an unregistered one stays "Not available yet"; a server with its own client never calls the broker; the browser goes back only to the recorded address.
- Step 6: a Mac build and a Mac App Store build that run the library and read a Drive file.
- Step 8: real Google on the dev server, through the broker: own Drive read/edit/share, a team share (inside and outside a folder),
  Gmail send with the confirm card, Docs and Sheets edit.

## Result

Filled in at the end.
