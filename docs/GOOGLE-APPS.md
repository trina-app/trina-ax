# Gmail, Google Calendar, Google Docs and Google Sheets

Four built-in connectors next to Google Drive ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)). A person opens **Settings ›
Connectors**, picks Gmail (or Calendar, Docs, Sheets), presses **Connect**, signs in at Google, and the AI can use that
app in their chats. Each app is its own card with its own Google sign-in. Google Drive stays Trina's own connector.

The tools come from the open-source Google Workspace MCP server (github.com/taylorwilsdon/google_workspace_mcp, MIT,
pinned in `scripts/system/packages.json`), which each Trina server runs on its own machine: how it is installed and
supervised is in [GOOGLE-APPS-RUNTIME.md](GOOGLE-APPS-RUNTIME.md). It keeps nothing: Trina keeps each person's Google
sign-in (sealed) and hands the library that person's access token on each call. Linux servers only in this version; on
the Mac app the cards say "Not available on this computer yet".

Code: `server/src/integrations/google-apps/` (service, config, catalog, tokens, transport, attachments), routes
`server/src/routes/google-apps.ts`, contract `shared/src/api/google-apps.ts`, migrations `341_c_google_apps.sql` and `349_c_google_app_team.sql` (shared with
the team).

## Setting it up (admins)

Admin › Connected apps has one card per app. Each needs a Google OAuth web client and the right Google APIs switched on.

### In Google Cloud

1. Open (or make) a Google Cloud project for your team, e.g. "acme-trina".
2. **Switch on the APIs** the card lists (`GET /api/admin/google-apps` `apis`, with links):

   | Card | Google APIs |
   |---|---|
   | Gmail | Gmail API |
   | Google Calendar | Google Calendar API |
   | Google Docs | Google Docs API, Google Drive API |
   | Google Sheets | Google Sheets API, Google Drive API |

3. **OAuth consent screen** (Google Auth Platform › Branding / Audience):
   - **Internal** if your team is one Google Workspace organization: everyone in it can sign in, and Google does not
     review the app. This is the simplest choice for a company.
   - **External** otherwise (personal Gmail accounts, several organizations). While the app is in **Testing**, only
     the people listed as **test users** can sign in (at most 100), and Google asks them to sign in again every 7 days.
     Gmail's permissions are "restricted": publishing an External app that uses them needs Google's verification.
4. **Data access (scopes)**: add the scopes of the apps you use. Trina asks for exactly these, per app:
   - every app: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (the library checks whose token it is)
   - Gmail: `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.modify`, `gmail.labels`, `gmail.settings.basic`
   - Calendar: `calendar`, `calendar.readonly`, `calendar.events`
   - Docs: `documents`, `documents.readonly`, `drive.readonly`, `drive.file`
   - Sheets: `spreadsheets`, `spreadsheets.readonly`, `drive.readonly`, `drive.file`

   A sign-in where the person unticks one of them is refused (`reason: "scope_denied"`; the page says "Some
   permissions were not ticked. Connect again and keep every box ticked."), because the tools that need it would fail
   later. A narrower scope counts as given when Google granted its broader one instead (`calendar` for
   `calendar.readonly` and `calendar.events`, `documents` for `documents.readonly`, `spreadsheets` for
   `spreadsheets.readonly`, `gmail.modify` for `gmail.readonly`, `drive` for `drive.readonly` and `drive.file`), and
   `email` / `profile` count for `userinfo.email` / `userinfo.profile` (`scopesCover` in service.ts; the hosting
   service's broker has the same list).
5. **Clients › Create client › Web application**, with this **Authorized redirect URI** (the card shows it):
   `https://<your team address>/api/integrations/google-apps/callback` (one address for all four apps).

### In Trina

Admin › Connected apps › the app › **Set up**:

- **Use the same Google app as Drive** (offered, and on, when Google Drive has one): the card signs in with Drive's
  client and follows it when Drive's changes (people then reconnect). Add the redirect URI above to that client in
  Google Cloud, and switch on the card's APIs in the same project.
- **Its own Google app**: the JSON file Google Cloud downloads for the client (its redirect URIs must list the address
  above), or the client ID and secret.

The client is written to a private file of the server (`<secrets>/integrations/google-apps/<app>.json`, mode 0600, a
new file renamed into place, read back with the same checks as Drive's). The page never shows it again: no answer,
log line or audit entry carries the client ID or secret (audit `google_app.client_set` with `{ app, sameAsDrive,
replaced }`).

The page cannot change a card when:

- the server is hosted: it signs in through the hosting service's Google app (below);
- the operator set it: `MYCEL_GOOGLE_GMAIL_CLIENT_FILE`, `MYCEL_GOOGLE_CALENDAR_CLIENT_FILE`,
  `MYCEL_GOOGLE_DOCS_CLIENT_FILE`, `MYCEL_GOOGLE_SHEETS_CLIENT_FILE`, or a client file in that folder this page did not
  write ("Set in the server's own setup");
- the server has no public address (`tunnel.host`): Google has nowhere to send people back;
- this computer cannot run the library (the Mac app).

**Everyone may connect their own Gmail** (and the same per app) once it is set up. There is no team switch any more
(docs/DECISIONS.md "No members' switch for connectors", 2026-11-12): `PUT /api/admin/google-apps/:app/members` stays for
older apps and changes nothing, and a stored `integrations.googleApps.<app>.members` "false" is ignored.

## What members see

- The app's page says in one line what the AI can do and shows every tool as a chip. **Connect** goes straight to
  Google (the desktop app opens it in the system browser); back in Trina the person confirms the Google account shown.
- Connected: **Connected** and ⋯ (**Settings**: Ask before each change, or Always allow; Reconnect; Disconnect).
- Not set up on the team yet: **Ask admin to add it** in place of Connect. The owner and the admins get one notice per
  app in Activity that opens its setup; once members can connect it, each member who asked hears that it is ready
  ([INTEGRATIONS.md](INTEGRATIONS.md) "A member asks for an app"). The same for Google Drive.
- Reading is free. Anything that changes or sends (a mail, an event, a document edit) shows the confirm card with
  everything it sends, and **Always allow** on it: the person's own choice for that app, which Settings turns back.
  After the person's chat read their team chat rooms, and in a room, every change asks again (other people's words could
  have asked for it). So does every change in a chat that read something from outside, a mail included
  ([DECISIONS.md](DECISIONS.md) "Connector write cards: outside content asks"). Scheduled tasks keep the rules of any personal connection: only to recipients the task's card
  pinned, otherwise nothing is sent.
- In a team chat room, @트리나 may use the asker's own Google apps (only the asker's). What it found goes through the
  room's private answer: only the asker sees it until they share it.
- Docs and Sheets read tools say to use `drive_read` for a plain "what does this file say" question, and to use them
  to read a document's structure (paragraphs, cells, ranges) before editing.
- Gmail attachments are read like a Drive file (PDF text, Hangul, Word, Excel, PowerPoint, pictures through the
  existing readers), never handed to the AI as base64. A copy goes into the team files only when the person asks: a
  PDF or a picture with `save_url` (kept for the chat like a connection's file), anything else from its text with the
  file tools, into the person's own folder unless they name another one. An attachment over about 18 MB is not read
  (its base64 would not fit in one 25 MB answer): the AI is told so in plain words, from the size the message listed
  (`file_size`, then not fetched at all) or from the answer itself.

## Shared with the team

An owner or admin can also connect **one Google account per app for the team** (a shared mailbox, a team calendar):
Admin › Connectors › Gmail (or Calendar, Docs, Sheets) › Team settings › **Shared Google account** › **Connect for the
team**. The dialog signs in at Google, confirms the account, then asks who may use it (everyone, groups or people: the
same picker as a team connection). Per member stays the default: nothing is shared until an admin connects one and
saves its people.

- **Who may use it** is the shared connection's rule, exactly as for any team connection (`store.ts mayUse`): being an
  admin is not a rule. The people it includes get its tools as `team_<app>__…` in their chats, side chats beside a
  room and scheduled runs; nobody else does, through any path. A new one starts with nobody; closing the dialog before
  Save removes it again.
- **Only owners and admins** can connect, sign in again, change its people or remove it (`/api/admin/google-apps/:app/
  team…`: the route checks the role and the service checks it again). A member sees, on the app's page in Settings ›
  Connectors, "Shared by an admin: <account>" when it includes them, and can still connect their own account.
- **A member's own connection is never touched.** It is a different row (scope `personal`); a member who has both gets
  both, and the AI's list names the shared account and says to use the person's own unless they ask for the team's.
- **Changes ask.** The shared connection's rule is "ask" and no screen changes it: the AI asks each member before it
  sends or changes something, unless that member chose Always allow on its card. That choice is their own (`integration_user_allow`), ends when they leave its rule, and ends when an admin signs in a different
  Google account. A scheduled run cannot send through it (nobody to ask).
- **Its answers** may reach the people its rule includes (a team connection's read scope), not one person's.
- **Removing it** deletes its tokens, rule and members' Always allow at once. Google revokes a whole grant, so it is
  asked only when the admin who signed it in has no other Google sign-in here **and no sign-in of anyone here uses the
  same Google account** (matched by the address confirmed at sign-in: a person's own app, another shared app, a Drive
  connection or a Drive share). The same check guards a person's own Disconnect (apps or Drive) and stopping a Drive
  share, so removing one never ends another person's connection.
- **A new one never replaces another admin's.** The dialog completes with `create: true` (409 `team_exists` when
  another admin connected one meanwhile), and closing it removes only the connection it made (`?id=`). 팀장 넘기기 lists
  it (`team_sign_ins`, `team_connection`) like other team sign-ins.
- Data: a team row of `integrations` with `google_app` (at most one per app, migration 349's index), its sign-in a
  `google_app_flows` row with `scope = 'team'` (only the team completion takes it).

Google Drive has had its own form of this since #95: "Drives shared with the team", read-only and limited to chosen
folders ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md) "Sharing a Drive with the team").

## Hosted servers

A hosted team without its own client, and a self-installed server the hosting service registered (the broker URL set,
no Google Drive client of its own; [GOOGLE-DRIVE.md](GOOGLE-DRIVE.md) "Hosted teams (and registered servers)"), signs
in through the hosting service's Google app: the Drive broker
(`shared/src/cloud-protocol/drive-broker.ts`) with the `app` field and that app's fixed scopes
(`GOOGLE_APP_BROKER_SCOPES`), the browser coming back to `/api/integrations/google-apps/callback`. Refresh and revoke go
through the hosting service too (`app` in refresh). Until Google has reviewed the hosting service's app, only its test
users can sign in; a hosting service that does not offer an app yet (an older one answers `invalid_request`) makes that
card say "Not available yet" (`reason: "service_limited"`) for ten minutes before it is tried again.

On a self-installed server the hosting service serves, the cards look as on a hosted team: "Set up by the hosting
service" (`blocked: "hosted"`, no redirect address shown). While it does not serve it (not registered yet, or removed),
each card can be set up on the page as on any self-installed server. A card that has a client of its own (written on
this page, or the operator's `MYCEL_GOOGLE_<APP>_CLIENT_FILE`) keeps signing in with it and never calls the hosting
service.

## Disconnecting

Disconnect removes that app's sign-in in Trina at once. Trina asks Google (or the hosting service) to revoke only when
it was the person's last Google sign-in here: these four, their Google Drive and a team Drive share they signed in for
that still works (`drive_team_shares.owner_user_id`, tokens kept). Google revokes a whole grant, so
revoking one app's token could end the others made with the same Google app; Google Drive's own Disconnect follows the
same rule. The answer says `revoked`, `unavailable` or `not_needed`.

## How it is built

- **A person's connection** is a personal row of `integrations` with `google_app` set, one per person and app
  (unique index). Every rule of a member's own MCP connection applies unchanged: sealed tokens and refresh, the write
  card (`connections/tools.ts` gate), per-tool switches (`disabled_tools`), scheduled-run rules, the audit, secrets
  hidden in answers. It is hidden from the generic list and the generic manage APIs (`/api/integrations/:id` answers
  "not found"). Its `url` is `https://google-apps.invalid/<app>`, never used: `.invalid` never resolves, so even an older
  build that lists it as an ordinary connection sends no token anywhere.
- **The transport** (`transport.ts`): the connection's MCP calls go only to the address the library listens on now
  (`http://127.0.0.1:<port>/mcp`, exactly that), with `Authorization: Bearer <the person's access token>`, over
  `node:http` (no proxy from the environment). Nothing a person types can reach it; the generic rules for connection
  addresses (https, public addresses only) are unchanged. A refused token (401) is refreshed once and the call sent
  again. The library down: the AI is told "Gmail is not reachable right now, try again in a minute". So is a 401 again
  after a refresh that worked: the library answers 401 whenever its own userinfo check with Google fails (a timeout,
  Google busy, its checks all in use), so it is for now and the connection stays connected; only a refresh Google
  refuses asks the person to reconnect.
- **The refresh** (`tokens.ts`) uses the card's client as set up now, never one stored with the tokens: a new client (or
  "same as Drive" after Drive's changed) ends the old sign-in.
- **The tools** (`catalog.ts`): the library serves all four apps from one process; a connection keeps only its own
  app's tools, by name (the library's complete tier minus its Drive tools, `start_google_auth` and the two comment
  tools that need full Drive access). Read or change by the library's own mark and ours (a change if either says so);
  `get_gmail_attachment_content` counts as a read. A `send_gmail_message` or `draft_gmail_message` call whose
  attachments use a `url` or a `path` is refused before anything is sent (the library would fetch the address or read a
  file on the server).
- **Rooms**: the integrations provider gets `room: true` and offers only the asker's own Google apps there; their
  answers add the connection to the read scope as `integration`, so `rooms/ai.ts` decide() keeps the answer private.

## Security notes

- Tokens and client secrets never leave the server except to Google, the hosting service and the library on
  127.0.0.1; no API answer, card, tool result, audit entry or log line carries one (tests:
  `tests/unit/c-google-apps-*.test.ts`).
- The library accepts any Google token, so it listens on 127.0.0.1 only, on a port Trina picked; nothing else can name
  that address.
- The sign-in is bound to the person and the session that started it (PKCE S256, a hashed state); Google's answer needs
  the same signed-in person in the browser, and the person confirms the account before it is connected.
