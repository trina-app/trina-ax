# External-service connections

The AI can use services outside the team server with a person's or the team's own credentials. Phase 1 has two kinds:

- **MCP servers** (Notion, Linear, GitHub, Atlassian …): the address is enough; the server lists its tools. Sign-in
  (OAuth) or a key.
- **HTTP APIs with a key** (an internal tool such as AI PM): address, key and a note on how to use it. The AI gets one
  tool, `api_request`, that can only call addresses under that connection's address. An API that signs in with OAuth
  (NAVER WORKS …) signs in with your own app instead of a key ("Your own app" below).

Google Drive keeps its own integration ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)), shown in Settings › Connectors as a
card whose Connect goes straight to Google (`web/src/components/integrations/DriveConnector.tsx`; the old
`/settings/drive` leads there), and so does asking the AI from Slack ([SLACK.md](SLACK.md)). App connectors are the
apps this server's AI uses with a person's own account (`web/src/lib/connectors.ts` `APP_CONNECTORS`, one card each).
Admin › Connected apps shows whether the server has a Google client and how many members are connected, and an admin
can set the client up there. These connections are the other direction from the "connectors" of
`server/src/connectors/remote-mcp` (outside AI apps such as Claude using this server's files), which are Settings › Trina AX MCP
and Admin › Trina AX MCP.

Gmail, Google Calendar, Google Docs and Google Sheets are built-in connectors too
([GOOGLE-APPS.md](GOOGLE-APPS.md)): a card each, one Google sign-in per app, the tools of the Google Workspace MCP
server this server runs on 127.0.0.1. Each person's connection is a personal row here with `google_app` set: every rule
below (sealed tokens, the write card, scheduled runs, per-tool switches, audit) applies, except that it is hidden from
this list and its own page manages it, it may be set to Always allow by its owner, and its calls go only to that local
server.

## App connectors (the other direction)

A person can connect their own Claude (Claude Code, Claude Desktop, claude.ai) to this server as a remote MCP server
with OAuth (`server/src/connectors/remote-mcp/`, routes in `server/src/routes/remote-mcp.ts`). It is off until the server
has a public origin for it: `server.json` `appConnectors: true` with `tunnel.host` (the Linux installer:
`--public-host HOST --app-connectors`), or the environment variable `MYCEL_REMOTE_MCP_ORIGIN`, which wins when it is
set. Tools: `list`, `glob`, `grep`, `read`, `skills_list`; with the `mcp:write` scope also
`write`, `edit`, `upload_file`, `create_upload_link` and `share_skills`. All of them use the person's current folder
permissions. No write reaches `skills/` (team skills and rules) or `users/<id>/skills/` (the person's own skills): the
team app changes them only after its own confirmation, which an outside model cannot give (any letter case; the link's
`PUT` too). With the `mcp:admin` scope an owner or admin also gets `people_list`, `groups_list`, `group_create`,
`group_update` and `group_delete` (`remote-mcp/groups.ts`). With `mcp:rooms` the person's conversations: `rooms`,
`room_read` and `room_file` (the reader of their own AI chat, `rooms/reader.ts`), and with `mcp:rooms.write` also
`room_send`, a message as the person through `Rooms.send` (`remote-mcp/rooms.ts`; docs/DECISIONS.md "AI 앱에서 대화
읽고 쓰기").

- Consent: the person chooses, whatever the app asked (MCP clients ask for the 401 header's `mcp:read` only). Reading
  and `offline_access` (a refresh token, so the connection stays until disconnected) are always granted, asked or not; **파일 쓰기** (`mcp:write`) is a checkbox for everyone, ticked at the
  start only when the app asked for it; **대화 읽기** (`mcp:rooms`) is ticked at the start, **대화 쓰기**
  (`mcp:rooms.write`) unticked and only with reading (a page without these boxes grants neither); `mcp:admin` comes
  with every new connection of an active owner or admin (no
  box; one line on the page says so), never a member's. The token's `scope` names exactly what was granted, and a
  refresh can only narrow it, so an earlier connection without `mcp:admin` connects again (Settings › Trina AX MCP says so).
- `upload_file`: base64 bytes in the call, at most 20 MiB, in practice files up to about 50 KB.
- `create_upload_link`: a one-time `PUT <origin>/connector-uploads/<token>` URL for a larger file (at most 50 MiB,
  10 minutes, one path). Claude Code runs `curl -T "<local file>" "<url>"`. The permissions are checked when the link
  is made and again when the file arrives.
- `create_download_link` (`mcp:read`): the mirror, a `GET <origin>/connector-downloads/<token>` URL for a team file's
  exact bytes (any type, any size the person may read; 10 minutes, at most 3 GETs). Claude Code runs
  `curl -o "<local file>" "<url>"`, changes the file locally and puts it back with `create_upload_link` (overwrite).
  The read check runs when the link is made and on every GET; a changed file, lost access or an ended connection
  gives 404. `read` with `raw: true` gives a small UTF-8 text file's exact text (one read, about 28,000 characters).
- `share_skills` (내 스킬 가져오기, docs/DECISIONS.md "SK"): Claude Code sends the person's own Claude skills (from
  `~/.claude/skills`, the projects' `.claude/skills` it knows and `~/.claude/commands`), the names of those it left out
  (plugin skills, a skill with a key: names only), CLAUDE.md as text and its remote MCP servers (https addresses only, no
  key). It makes a share proposal of the person (`server/src/skills/share.ts`, the same as `POST /api/skill-shares`) and
  answers `{ proposalId, url, status: "pending" }` with the link `<origin>/skills/share/<id>`; the person gets a notice
  with that link. The server checks every skill again (secrets, scripts, plugin, size, personal paths), an AI turn without
  tools judges them, and nothing reaches the team before the person presses [팀에 공유] in the app (the MCP servers
  become connection templates, below, each member connecting their own key). Owners and admins only: a member is told
  to use "스킬로 제안" in the app. At most 50 skills and 5 proposals a minute; a call may be larger than the usual 1 MiB
  (like `upload_file`).
- Group tools: an owner's or admin's connection only; a member never gets `mcp:admin`, and an app's request for it
  is dropped. Every call checks the role again; a person made member or disabled loses the scope on all
  their grants for good. The changes call the Admin › Groups server functions (same checks, same audit lines plus
  `via: 'connector'`) and answer with who now opens or loses which folders and what else the group gives (team
  connections, templates, team Drive shares, AI connections, budgets, engine choice, dev environment, team room). Names in answers are
  JSON-quoted (a name can hold a line break); the tools and the `initialize` instructions say they are data.

Details: docs/DECISIONS.md "App connectors: upload_file for binary files", "App connectors: one-time upload links" and
"App connectors: group management for owners and admins, scope mcp:admin".

Code: `server/src/integrations/connections/` (`store.ts` rows and secrets, `net.ts` requests, `mcp.ts` the MCP client,
`oauth.ts` sign-in, `service.ts` the operations, `tools.ts` the AI's tools, `hide.ts` hiding secrets a service sends
back), `server/src/routes/integrations.ts`, migration
`server/migrations/313_c_integrations.sql`. Contract: `shared/src/api/integrations.ts`.

## Personal and team connections

| | Personal | Team |
| --- | --- | --- |
| Made by | the member (Settings › Connectors) | an admin (Admin › Connected apps) |
| Used by | that member, in their own chats only | the people its rules name: everyone, groups, people |
| Managed by | the member; nobody else sees it, admins and the owner included | admins |
| Ends | when the member deletes it or their account is deleted | when an admin deletes it |

- Admins manage team connections but are **not** users of them: using one needs a rule that names them.
- Who may use a connection is checked on **every call**, with the person's account, groups and the rules as they are
  then; a disabled or deleted account gets nothing. The card that asks before a change may wait for minutes, so the
  check runs again after it.
- `TeamSettings.personalIntegrations` (default on): off, members cannot add personal connections (403) and the existing
  ones are left out of chats; they stay listed so their owners can delete them. Team connections are not affected.
- Deleting a member deletes their personal connections (keys included) and removes them from team connections' rules.

## Templates: each member connects their own key

A template is a service an admin registers once for the team, without a key; each member it is for connects it with
their own key or sign-in. One shared team key would let everyone's AI act with the key owner's rights, and the service
would log every call under that one person; a template keeps each call under its member's own rights. In Admin › Connected apps,
"Add connection" (and a Discover card's +) asks who connects: **One for the team**, a team connection as above,
the default; or **Each member's own** (a template), which takes the kind, name, address, sign-in method (an
API key with its header, or OAuth), who it is for (everyone, groups, people; admins only when named) and an optional
note, and never a key or a write rule. The address may not have a query or a fragment (`?…`, `#…`): it goes with every
member's key, so a key there would reach every member and the service would log their calls under its owner. The
name reaches every member's AI, so it may not hold hidden or direction-changing characters, a double quote or control
characters (and the note no hidden characters).

- The members it is for see it under Settings › Connectors in **Your connectors**, with a Team label and **Connect**, which opens the same
  dialog as an admin's request: the address, where the key goes (the host in bold), their key or a sign-in next, and
  the write rule (ask or refuse). The app sends back the template's version as the member saw it: a template that changed since is
  refused (409, "This template changed") and shown again as it is now. It becomes their own (personal) connection, made through the same create path as one they add
  themselves (`template_id` set), used only in their chats with their key. They may change only their key or sign-in
  and the write rule; the address, sign-in method, header, name and note are the template's, so a key only ever goes
  to the address the admin registered (even its owner sees the address without a query). They can disconnect (delete
  it) at any time.
- It is usable only while the template covers its member (`store.ts mayUse`, `templateCovers`), whatever
  `personalIntegrations` says (the admin registered the service), and it does not count toward a member's 20.
- The admin sees "Template · N connected" (members with a key or sign-in now). It opens who the template is for, each
  with **Connected** (and since when), **Not connected**, **Key stopped working** (the service refused their key or
  sign-in: the connection's status `needs_auth`) or **Not working** (status `error`): names and states only, from
  `GET /api/admin/integration-templates/:id/members` (admins). Never a key, the address, a tool or anything the
  service returned. The activity log stays minimal (below): it does not say which template a member connected.
- The people a template is for are told once in their inbox (`integration.template`, table
  `integration_template_notices`; migration 334): when it is made for them, when a rule change, a group they join or
  joining the team while it is for everyone brings it to them: told at once on those events (a template made or its rule
  changed, a group's members changed, someone added, invited, joined or enabled again), with the notification tick as a
  backstop every 30 seconds (one set-based query, at most 500 notices per pass).
  Its maker is not told about their own template, someone who connected it already is not told, and
  `integration_template_offers` keeps a second notice from coming after the first is past its 30 days. When a new
  address, sign-in method or header drops a member's key, that member gets "Reconnect <name>"
  (`integration.template_reconnect`, one per change). Both open Settings › Connectors with the template's Connect
  (`?template=<id>`) only while it is still for that person; they carry its id, name and `signIn` (a sign-in template:
  "sign in again with your own account", else "enter your own key again") while it is there, never an address or a
  key. A member whose connection went because the template is no longer for them (the admin narrowed who it is for,
  alone or with a new address, or they left its group) gets one "You no longer have access to <name>" (the same table
  and event type, source `<template>.left.<connection>`, `templateLeft`), with no link and no "connect it again".
- In a chat, the AI is told which templates for this person are not connected yet (or whose key stopped working) and
  offers the connect card for them (`connect_service` with `template`, or found by the address the AI filled in). The
  card says "Connect your own key for <name>" and connects through the template's own path (`templates.ts connect`):
  only while the template is for this person and is the version the card showed (409 otherwise), with the template's
  address, sign-in method and header, also when members' own connections are turned off. Never anyone else's
  connection; not in a scheduled run (nobody is there to finish a card). For a template the member already has (its key
  stopped working), the card only sends the new key: their write rule and tool switches stay, and "Not now" removes
  only a connection that card itself made.
- A scheduled task that needs a template (one of its runs used a connection made from it, noted in
  `schedule_template_needs`; or its instruction names the template, but only when the owner has no working connection
  of their own to the same service, and never for everyday or short names such as "the" or "Notes") does not start while its owner has no key for it or theirs stopped working: the
  run's result is "Needs your own key for <name>" (`lastOutcome` `needs_key`, `lastNeed`; the occurrence is kept in
  `schedule_template_skips`), the owner gets a failure notice that names the template and opens its Connect, and Run
  now says the same (409). It never runs with anyone else's key; once the owner connects it, the next run starts.
- A new address, sign-in method or header on the template deletes every member's connection made from it (keys and
  sign-ins; OAuth tokens are revoked): they connect again. A new name or note is copied to their connections without
  touching their version, so a sign-in, a token refresh or a write waiting for a yes is not thrown away. A rule that no
  longer covers a member deletes that member's connection; a group change is refused at once and swept when the
  templates are next listed (the sweep does not wait for the services to be told, and also drops a connection whose
  address, sign-in method or header is not the template's). Deleting the template deletes them all. Deleting a member
  deletes theirs and revokes their sign-ins; deleting a member or a group also removes them from every template's rule
  (and a group from team connections' rules), so the rule can still be changed.
- At most 50 templates. Audit: `integration_template.create / update / delete` (the admin's changes). A member's
  connection made from one is logged like any member's own connection, `integration.create` and `integration.delete`
  with only its scope, kind and sign-in method (and `why`: `template_moved`, `template_deleted`, `not_covered`, when a
  template change dropped it), never which template, service or member.
- An admin's note on a template is the admin's: the AI reads it as "Note from your team admin".
- The chat's connect card does not count template connections toward a member's 20, and does not call one the
  template no longer covers "already connected".
- Not yet: choosing a default ("one team key" or "template") by sign-in method.

Code: `server/src/integrations/connections/templates.ts`, `schedule-needs.ts`, `server/src/notifications/service.ts`
(offerTemplates), `server/src/chat/connect-service.ts`, migrations `333_c_integration_templates.sql` and
`334_c_integration_template_notices.sql`, `336_c_integration_template_policy.sql` (a template or its rule changing
advances the safe-operations policy generation); web: `web/src/components/integrations/TemplatesView.tsx`. Tests:
`tests/unit/c-integration-templates.test.ts`, `tests/unit/c-template-chat-schedule.test.ts`,
`web/test/e2e/integration-templates.spec.ts`.

## Asking a member to connect

Some services log every call as the person whose key it is, so that key belongs in the member's personal connection.
An admin cannot add a personal connection for someone else. Instead, Admin › Connected apps › "Ask a member to connect"
sends one member a request with the service filled in (kind, name, address, key or sign-in, the key's header, usage
notes for an API). The member gets an inbox entry and a banner, and the admin can copy a link
(`/settings/connectors?request=<id>`; only that member, signed in, can open it). In Settings › Connectors the
member connects it with their own key or signs in, which creates their personal connection through the same path as
one they add themselves, or declines it. The admin sees the state (waiting, connected, declined, withdrawn, expired
after 7 days) and can withdraw a waiting request; the admin never sees the key or the member's connection. A guest is
never asked: the picker leaves guests out, the server refuses one (400 under the person), and a request sent to a guest
before that ends as withdrawn once, when the server starts (QA TC-2948). Code:
`server/src/integrations/connections/requests.ts`, migrations `220_b_integration_request_notices.sql` and
`331_c_integration_requests.sql`. Decisions: [DECISIONS.md](DECISIONS.md) "Asking a member to connect a service as
their own".

## A member asks for an app

The other direction: a member who opens an app the team has not set up (Google Drive, Gmail, Google Calendar, Google
Docs, Google Sheets: the apps an admin sets up once for everyone; since QA TC-133 also every listed service) taps **Ask admin to add it** on its page, like an app
request in Slack. It takes the place of the Connect button that could not work and of the "not set up" line; afterwards
the page says "Request sent" (also when opened again while the request is open), and the app's card says so too.

- Only those five ids, only while the app is not set up (`POST /api/integrations/service-requests {service}`). The
  server refuses any other name (400 `unknown_service`: no free text from a member reaches an admin), an app the member
  can connect already (409 `can_connect`), one an admin turned off for members or this computer cannot run (409
  `not_requestable`; also a setup that is not the admins' to make: a hosted team's, an operator's file), and owners
  and admins (403: they set it up themselves). (Listed MCP services: see below.)
- One open request per member and app; asking again while it is open answers `already` and sends nothing. At most 10
  new requests per member a day (429). Audited `service_request.ask`.
- The owner and the admins get one notice per app in Activity (`service.request`, table `service_request_notices`),
  armed again (unread, on top) by each new ask: "Alice asked to add Gmail", "Erin and 2 others asked to add Gmail". Its
  row opens the app's setup in Admin › Connected apps. The names are read when the inbox is shown. The 30-second check
  keeps these notices with whoever is an owner or admin now: someone who no longer is loses them, someone who became one
  gets those of the apps asked for now.
- Once members can connect the app (an admin set it up; also a setup made
  elsewhere, checked every 30 seconds; not while the hosting service's Google review lets only its test users in), the
  requests close, the admins' notice counts as read and says "Added", and each
  member who asked gets one notice that it is ready (`service.ready`), which opens its page. Inbox only, never an OS
  push. Requests also close after 30 days, or when their member leaves or becomes an owner or admin; then they may ask
  again.
- **Every listed service too** (QA TC-133): Notion, Linear and the rest of `shared/src/service-catalog.ts`, by their
  ids (never an address or a name a member types). Such a service is added for a member once a team connection to its
  official address exists that they may use: their request closes as 'added' with the 'service.ready' notice (checked
  when a team connection is made or changed, and on the 30-second check), and asking again is `can_connect`. A member
  who may add their own connections keeps Connect on the page; the ask for the team's is a line under it. A member's
  own connection to the service does not stop the ask.
- **Taking it back:** "Cancel request" under "Request sent" (`DELETE /api/integrations/service-requests/:service`, one's
  own only; audited `service_request.withdraw`). It still counts toward the 10 a day.
- **Admin › Connected apps, "Asked by members":** one line per app or service with open requests (who asked), **Add** (a
  Google one: its page; a listed service: "Connect for the team") and **Dismiss** (`POST
  /api/admin/service-requests/:service/dismiss`: closes them; each member who asked gets one quiet notice
  (`service.closed`, never an admin's name) that it was closed and that they may ask again, as after the 30 days (QA
  TC-2946, migration 353); audited `service_request.dismiss`). `GET /api/admin/service-requests` lists them. A request taken back or dismissed is closed
  with no reason (`closed_reason` NULL), so no migration. The notice of a listed service opens its page in Admin ›
  Connectors.
- Nothing a member gets names an admin. Code: `server/src/integrations/service-requests.ts`,
  `service-request-notices.ts`, migration `343_c_service_requests.sql`; web `components/integrations/AskAdmin.tsx`.
  Decisions: [DECISIONS.md](DECISIONS.md) "A member asks an admin to add an app".

## Connecting from a chat

A person says in a chat "connect Higgsfield" (or Notion, Linear, GitHub, any MCP server or HTTP API, or their Google
Drive). The AI looks up the service's official address itself, fills in the connection with the `connect_service`
tool, and the chat shows a card. The person does one thing on the card: paste the key, sign in, or press Connect. They
never have to open Settings. The AI calls the tool before it writes anything about connecting and never announces a
connect card: the card shows itself when there is one, and only the result says what happened (a refusal says "No card
was shown"; AI scenario CON-02). Code: `server/src/chat/connect-service.ts` (the tool and the card's endpoint),
`POST /api/turns/:id/connect` (`server/src/routes/chats.ts`), the card in the web app. Contract: `ConnectServiceInput`
(`shared/src/tools.ts`), `ConnectServiceRequest` (`shared/src/api/ws.ts`), `TurnConnectBody` / `TurnConnectResult`
(`shared/src/api/chats.ts`).

- **A known service only at its official address.** For a service in the app's list (`shared/src/service-catalog.ts`,
  the Discover list) the card says "Official {name} address" only for exactly its official address (https, host and
  path). Its name, a look-alike ("Nоtion", "노션") or a name holding it, at any other address (a self-hosted GitLab, a
  made-up address) is an unknown service named by its host, with a warning and the host in bold; it is not refused.
  Any address that is not a listed service's official one (another official address of it, such as Atlassian's v1 or
  Canva's documented one, counts as official) gets one line beside its host in bold, unless the card is an admin's
  template or a reconnect: "This address is not in Trina's list of apps. Check that it matches the address in the
  service's official docs." / "트리나 앱 목록에 없는 주소예요. 이 서비스의 공식 문서에 나온 주소와 같은지 확인해 주세요."
  (`connect.unlisted`). The person can still connect. A listed name at another address gets the more exact line in its
  place: "This is not {name}'s official address. {name}'s official address is {official}. …" (`connect.notOfficial`).
  Owner decision 2026-11-24, docs/decisions/20261124-connect-card-unlisted.md.
  A service the person already uses is not connected twice: a working one gets no card, their own that needs a
  sign-in or key gets a card for that same connection (`reconnect`). A team connection is never named to someone who
  may not use it. docs/DECISIONS.md "The chat's connect card trusts the app's list".
- **The key never reaches the AI.** It is not in the tool's input or result, the steps, the audit lines
  (`tool_events`), the engine's session file, the logs, the realtime events, the admin audit or any error text. The
  card seals it in the browser for the purpose `'integration.secret'` (the same sealing as AI connections) and sends it
  to `POST /api/turns/:id/connect`, which opens it and hands it straight to the connection's store. It never goes
  through `POST /api/turns/:id/answer`, whose answers reach the AI; that endpoint refuses these cards. A field the AI
  fills in that looks like a key (or holds one this person has stored) is refused without a card, and the step's label
  leaves out anything that looks like one. The address gets a stricter check (`addressHasSecret`): a known key prefix,
  a password in it, or a key-named query value (`?api_key=`, `?token=`, `?key=`) that looks like a key; a generated
  instance id in an MCP address is no key.
- **Nothing hidden on the card.** The name, the notes and the AI's line (`why`) are refused without a card, naming the
  field, when they hold a character a person cannot see or that turns the text around (`hiddenText`,
  `integrations/connections/service.ts`): format characters (zero-width ones, bidi marks, overrides and isolates, the
  tag block), other default-ignorable ones (variation selectors, Hangul fillers), private-use characters, lone
  surrogates, noncharacters and C1 controls. The name and notes reach the AI in later chats, so an instruction could
  otherwise hide behind a harmless-looking card. Korean, Japanese, emoji (a zero-width joiner between two emoji, an
  emoji's presentation selector) and line breaks in the notes stay. The same check runs again where the card's values
  are saved. The step's label leaves such characters out and is "Connect service" alone without a name.
- **Nothing is connected until the person presses the card's button.** The tool only opens a card, so an instruction
  planted in a page can make the AI open a card but never finish one. The AI learns only the outcome:
  `{"connected": true, "name", "status", "tools"}` (up to 30 tool names, each cut to 64 characters, without control or
  format characters) or `{"skipped": true}` (Not now, the card's time ran out, the answer was stopped). A connect still
  running when the card closes is waited for, so the AI hears what it made (connected, or added but not working yet).
- **The same path and checks as Settings** (`service.ts create`): personal connections switched off, the limits, https
  only, no private, local or office addresses, the header rules, the short name. A team connection only for an admin,
  with the role read again when the card is finished (the endpoint is for any signed-in person). "Just me" names the
  admin in the connection's rule (admins are not users of team connections otherwise); "Everyone" is everyone.
- **The card says where it connects**: the whole name in the title (on more lines when it is long), the host as the
  line under it, then the whole address and what kind of connection it is (MCP server or HTTP API, and for a key in a
  header the header's name), for every case (also no key and sign-in), with a caution when no word of the name (3+
  letters or digits) is in the host. The key is
  stored for that one connection and sent only to its address, as for any connection; a key over 8,000 characters is
  refused. An HTTP API's `notes` (given to the AI in later chats) are on the card in full, read-only, and saved exactly
  as shown.
- **A wrong key keeps the card open.** The answer says why the check failed, and the next key goes to the same
  connection (its key is replaced, and on a team card a changed "Who may use it" too, through the same update as
  Settings): one card makes one connection at most. A second button while one runs is refused (409). "Not now" after a
  failed key removes that connection again, the way Settings removes one (audited), but never one a connect is still
  making or one holding a finished sign-in; a card whose time runs out leaves it in Settings.
- **Each later button follows the rules of now.** Every connect and done checks again that personal connections are
  allowed (personal cards) and that the person is an admin (team cards), and that the connection the card made still
  has the card's address, kind, sign-in and key header. One changed or removed in Settings meanwhile is no longer the
  card's: refused (409, "ask the AI to connect it again") before the key is opened, so it is never sent; "Not now"
  closes the card without removing it, and the AI is told the card connected nothing because of that change.
- **Answers without a card**, as text the AI can act on: a missing or bad field, an address that is not https or is
  private, personal connections off, a team connection asked for by a member, a connection to the same address that
  the person (or the team) already has (its name and state), the team limit, Google Drive not set up on this server
  (an admin or the operator has to set it up), Google Drive already connected.
- **Signing in again to one's own connection** (QA TC-127): when the person's own connection (not one from a template,
  not a Google app) needs a new sign-in or key, the AI's list of connections names its id, and `connection` (or the
  connection's own address filled in) opens the card for it ("Sign in again to …", `reconnect`): the sign-in or key
  goes to that connection, the limit does not count it, and "Not now" leaves it as it is.
- **Sign-in services** are added first; the card then runs the usual sign-in (`POST /api/integrations/:id/authorize`)
  and, once it finished, tells the server ("done"), which checks the connection before telling the AI. The card says
  that signing in opens a sign-in page in a new window, to check that it is the service the person expects, and that
  the AI never sees the password; it does not name whose page it is, since the sign-in server comes from the address's
  own metadata. Done before the card connected anything says so. Google Drive uses its own sign-in
  ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)) inside the card, then "done" the same way.
- **Google for the team** (#253, as the welcome tools step and Admin › Connected apps): an owner's or admin's Drive
  card also has Connect for the team (`teamOffer`), which opens the same dialog (`DriveShareDialog`, through
  `web/src/components/integrations/GoogleTeam.tsx`). Gmail, Calendar, Docs and Sheets get a card (`target:
  'google_app'`) where the app can be connected and is not connected for the person. An owner or admin
  (`googleAppTeamCard`): Connect for the team (`GoogleAppTeamDialog`), or their own on the app's page, then "I've
  connected it". No one gets this card on a Slack, scheduled or server-started turn (nobody is there to press it): the AI gets the app's
  next step in words. A member (`googleAppOwnCard`, no `teamOffer`): "Connect my
  Gmail" to the same page, then "I've connected it"; on a phone, a line to connect on a computer. A card that closes
  without that press reports the app's state as it is then (connected, Not now, or no answer). A working team Drive share or
  the team's shared Google account the person may use counts as connected: no card. "Done" reads the role again; a team
  connection an admin made that leaves them out ends the card as "connected for the team", with the way to add
  themselves. Connect for the team is not in the phone app (no Google sign-in there).
- **Where it is not offered.** Scheduled runs have nobody to finish a card: the tool answers "skipped" at once.
  Sub-agents never get the tool (`PARENT_ONLY_TOOLS`). Confidential chats (Safe operations) do not offer it: it is not a
  local tool, and connected services are not offered there either.
- **The same answer goes on with the new connection** (owner decision 2026-11-12). A person asks "summarize my Notion
  page about the launch" without Notion connected: the AI shows the card, the person connects it, and the AI goes on
  with the same answer, using Notion, without the question being sent again. A running engine's tools are fixed (the
  engines' tool lists, the model proxy's names, the lockdown check), so the turn goes on in a new step
  (`chat/turn.ts`):
  - Claude: the tool's result tells the AI to end its step; when that attempt ends normally, the turn builds its tool
    set again (`buildToolSet`, the same person and chat, so the same filters as at the start) and resumes the same
    engine session with the turn context (connections as they are now) and a server note as the message
    (`continueAfterConnect`: the connection, its new tools or, when no name is new, `find_tools` / `call_tool` /
    `api_request`, go on with the request in this answer). A new proxy token, lockdown and sub-agent list come from the
    new set; the text goes on in the same answer message. At most `CONTINUE_MAX` (2) times per answer: a third card's
    result says "from the next message". Each continuation gets only the tool rounds the answer has left; with fewer
    than two the answer pauses at the round limit (`tool_limit`, "continue" goes on). The budget, the answer's time and
    Stop apply as to any attempt (`launch`); an error, a stop or a refusal: no continuation. A retry that starts a
    fresh session after a connect gets the new tool set from its start.
  - The API engine (in the server): the tool set is built again before its next round and listed again.
  - Codex (its runs start fresh, without the answer so far): unchanged, the tools come with the person's next message.
  - Google Drive's tools are always offered, so a Drive connect never needs this.
  The result says which (`next`); "Not now", a card whose time runs out or a stopped answer make no continuation. Only
  the turn's person can finish the card (the route checks the owner), and the tools the answer goes on with are that
  person's own: a room's answer (where `connect_service` is not offered) keeps only the asker's own Google apps.
- If the person pastes a key into the chat anyway, the AI tells them not to, that it should be revoked and replaced
  at the service, and calls `connect_service` without the key so they enter a new one on the card (the instructions'
  rule, `prompt.ts` `CONNECT_RULE`). The web app also warns
  before sending text that almost surely holds a key, with "Send anyway" and "Edit" (`SecretWarning`), in every box
  whose text reaches the AI: the message box, an ask_user card's own answer, editing a sent message and editing a
  waiting one. It warns on `hasLikelySecret`: known key prefixes (also Notion, Linear, Groq and `sk-` keys in lower
  case or hex), private keys, JWTs, `Bearer` and `Authorization: Basic` values, and labelled values such as
  `password: hunter22` or `SECRET_KEY=…` when the label is a whole word naming a secret and the value looks like one
  (6+ characters, letters with digits or symbols, not an expression such as `process.env.API_KEY`,
  `response.json()` or `config.auth.token`). Not random-looking text such as a commit hash or a document link, and
  not code or settings such as `token: 4096` or `Password: required`.
- Tests: `tests/unit/connect-service.test.ts` (every answer without a card; the card's fields; a wrong key and then
  the right one on one connection; a seal for another purpose; another person's turn; `/answer` refused; Not now, the
  time running out, a scheduled run; a team connection with the role checked again and its access changed on a retry;
  sign-in then done; Google Drive done; the notes on the card and as saved; a held check: two connects at once, the
  time running out and Not now while it runs; Not now after a finished sign-in; the tool names; a long key; hidden
  characters in each field, refused again where they are saved, and Korean, Japanese and emoji names; another key
  after personal connections were turned off or the connection was changed in Settings; done before connecting; the
  key and the sealed value in no text, row, log or file of the data folder). Who reaches a card: the permission
  matrix's `connectTurn` case on a real card. The card clicked in a small test DOM (`web/test/unit/connect-card.test.tsx`,
  `dom-host.ts`): a wrong key then the right one, sign-in (window reserved in the click, connect, authorize, poll,
  done), Google Drive to done, done again after a failed one; and each box's key warning
  (`web/test/unit/secret-warning.test.tsx`).

## Secrets

- Keys and OAuth tokens (and the OAuth client details) are stored only AES-256-GCM encrypted with the existing Vault
  primitive, in a **dedicated key directory** `<secrets>/integrations/connections` (owned by the server account, 0700,
  no links; checked like Drive's before every use). The AAD binds each secret to its connection
  (`<scope>:<owner or team>:<id>`); a pending sign-in's verifier is bound to its person and flow.
- No API response, log line, audit entry, error text, tool result or tool description carries a key or token: the API
  says only `hasSecret`. Tests check for canaries in responses, the database, the audit log, `tool_events` and logs.
- Keys belong in the key field: people who only use a team connection, and the AI, see its address without the query.
- **The AI's input never places the key.** It goes only in the header the connection names (`Authorization: Bearer`
  or the key header); `api_request` has no header field and the path, query and body are sent as the AI wrote them
  (no placeholders are filled in). MCP tool arguments likewise.
- **What a service sends back has the secrets hidden.** A service may echo them: an endpoint that lists the request's
  headers, an error page that repeats Authorization, an MCP tool that returns its own token. Before an answer reaches
  the AI, the chat, the steps, logs or `tool_events`, every value of the connection's secret (the key; OAuth access
  and refresh tokens and the client secret: as read for the call, as stored after it since a refresh may rotate them,
  and earlier ones seen since the server started, 16 per connection) is replaced by `[hidden key]` (`hide.ts`):
  - forms: the value itself (so also `Bearer <value>`); its characters %-escaped (either case, `+` for a space),
    JSON-escaped (`\/`, `\"`, `\\`, `\uXXXX`) or as HTML entities; base64 (standard or URL-safe, padded or not) of
    any text that contains it: the value alone, `user:<value>` for basic auth, `<value>:`. Up to two bytes at either
    edge of an embedded base64 value share a group with the text around them and stay.
  - where: one exit that every connection tool's result goes through (`tools.ts` `hiding`: `api_request` and MCP
    `tools/call` answers including structured content, resource links, error answers, our error texts, the summary for
    `tool_events`, a thrown error); before any cut (the 40,000 characters for the AI, a JSON-RPC error's 300, a tool
    description's 1,000), so a key across a cut leaves no part; on the whole answer once it is in, never per network
    chunk (an event stream whose bytes arrive split inside a key is hidden too). Saved MCP tool lists (`tools/list`: titles, descriptions, input
    schemas) get the same; a tool whose name carries a secret is left out. `lastError` is only ever a reason code.
  - values shorter than 8 characters are not hidden (they would hide ordinary words); parts of a key in ordinary text
    stay. When a stored secret cannot be read to hide it, the answer is not shown.
  - not caught: a service that changes the value in another way (hashes it, hex-encodes it, changes its case, puts
    its parts in separate fields or events such as two streamed deltas, base64-encodes it twice); a key written into
    the connection's address instead of the key field.
- **A stored key is never sent anywhere else.** Changing the address (any part of it) or how the key is sent (`auth`,
  `authHeader`) drops the stored key or sign-in, unless a new key comes in the same change. A key header may not be
  one the request needs itself (Host, Content-Type, Cookie, Mcp-Session-Id …).
- Ordinary database backups hold ciphertext without its key; restoring them without the key directory needs the keys
  entered or the sign-ins done again. There is no rekey command yet for this directory (Drive has `drive-rekey`).
- Status: `connected`; `needs_auth` (an OAuth connection without a sign-in, or the service refused the key or token:
  401/403); `error` (a key connection without a key, or the check failed). `lastError` is a reason code put into the
  reader's words (`text.ts`), never the service's own body. An MCP server with a saved tool list, connected or in an
  error that was only for now, whose check fails for now too (no answer in time, unreachable, a list over the limits,
  HTTP 408/429/5xx) keeps that list and is `connected` with `lastError` set: Settings says "Last check failed: … The AI
  keeps using the tool list from …" instead of "Error". Any other failure is `error` or `needs_auth`, and a sign-in a
  call found needed during the check stays. A call that goes through (an MCP call, or an `api_request` answered 2xx)
  sets `connected` and clears `lastError`, never a needed sign-in.

## Network rules

Every request (checks, tool calls, OAuth discovery, registration, token, revocation) goes through `net.ts`:

- https only, no user name or password in the address; the address rules of web_fetch (`tools/web-fetch.ts`
  `resolveTarget`): public internet addresses only, never this server, the office network or the office's own exit
  address (`tools/egress.ts`); obviously private hosts are refused when the connection is saved (400 under `body.url`).
- The name is resolved once and the connection pinned to that address (no second lookup, no proxy from the
  environment): `pinnedRequest`, the generalised form of web_fetch's GET.
- **Redirects are never followed**; they are reported (a check: "the service tried to send us to another address";
  `api_request`: the status and Location as external data).
- Standard ports only (web_fetch's 80/443 rule; with https that is 443). 30 seconds per request, answers cut at 1 MiB while reading (also without
  Content-Length), compressed answers decoded with the same limit. A check's `tools/list` and an MCP `tools/call` are
  the exceptions to the 30 s (below).

## MCP servers

Streamable HTTP, implemented here without an SDK: JSON-RPC POSTs with `Accept: application/json, text/event-stream`,
JSON or event-stream answers (reading stops once our reply has arrived, so a stream that stays open is fine), the
`Mcp-Session-Id` kept, `MCP-Protocol-Version` on every request after `initialize`. A session is reused for up to 10
idle minutes; a 404 for it starts a new one.

- **Check** (on create, on change of address or key, "Check again"): `initialize` → `notifications/initialized` →
  `tools/list` with its cursor pages until the list kept is full, at most 20 pages and 16 MiB together (one page may be
  8 MiB; a later page that does not fit in what is left is not kept), so a server that pages on forever costs at most
  that. The list is read for as long as it keeps coming: a page fails only when no bytes arrive for 30 seconds, and the
  check when it is not done 90 seconds after it began ("did not send its whole tool list within 90 seconds"), not at
  the 30 s of other requests (Higgsfield sent its 1.07 MB at 17-38 KB/s, 30-65 s). The check ends at that deadline:
  its requests end by it, it stops waiting for a session (shared with the calls, whose start keeps its own 30 s) at it, and
  no token refresh starts that could end after it (a token still valid is used). So 90 s stays under the relay's 100 s
  wait for an answer and the server's 120 s idle limit and "Check again" is answered. The tool list is saved (`tools_json`): every tool the service lists, up to 1,000 tools and 4,000,000 characters
  of schemas and descriptions per connection (past that Settings and the AI are told "N of M", or "N of more than M"
  when pages were left unread); a tool whose input schema is not an object is left out. A schema over 32,000
  characters is kept with its longest `description` strings cut to one common length that fits, each ending in
  "… (shortened)" (never a name, type, `required`, or a value in `enum`, `default`, `const` or `examples`); only one
  whose structure alone is over 32,000 is left out. Either way the check logs one line (connection, tool names and
  sizes), and a list empty only because of that is saved with `tools_dropped` (migration 365, API `toolsTooLarge`), so
  Settings says the tools were too large to load, not "listed no tools". A tool's own description is cut at 1,000
  characters, with the same marker.
  Turns use the saved list only: nothing is fetched when a chat starts. The server keeps the parsed lists in memory by
  connection and `tools_rev` (moved by a trigger whenever `tools_json` changes; at most 64 MiB of saved JSON, the list
  used longest ago first), so a turn reads the connections without their lists and parses only a list that changed;
  who may use a connection and which of its tools are off are read with every turn and call.
- **Tool calls** (`tools/call`) wait as long as the service works on them: a call fails when nothing at all comes for
  5 minutes ("sent nothing for 5 minutes") and in any case 15 minutes after it began ("did not finish within 15
  minutes"); its session's start keeps the 30 s. Each call names its own `progressToken`, so a service that reports
  progress (or sends any bytes of its event stream) keeps the call alive past 5 minutes. A web scrape takes 1-2 minutes
  (Bright Data, 2026-11), which the 30 s used to cut. 15 minutes stays under the engines' 30 minutes for one of our
  tool calls (Claude Code `MCP_TOOL_TIMEOUT`, Codex `tool_timeout_sec`), so the AI gets our reason; the turn's stall
  guard waits while the call runs. Stop, or one of these limits, ends the call at once and sends the service
  `notifications/cancelled`. A call that
  sent nothing for 5 minutes marks the connection like the 30 s did, as an error that is only for now (a check keeps its
  saved list); one past 15 minutes marks nothing (a long job, not a broken connection).
- **Tool names** for the engine: `my_<slug>__<tool>` (personal) and `team_<slug>__<tool>` (team), letters, digits, `_` and
  `-` only. With the engine's `mcp__team__` the full name stays within 64 characters: longer or clashing names are cut and
  given a short hash; the server maps each back to the remote name.
- **Tools to look up** (docs/DECISIONS.md "Connection tools: deferred, found and called"): one answer offers at most
  200 connection tools with 50,000 characters of definitions as tools of their own (Claude Code defers MCP tools past
  about 10% of the context). A connection that does not fit (Higgsfield: 186 tools, about 1 MB; a service of a dozen
  tools with long schemas) is deferred, like Claude Code's MCP tools: the instructions list its tool names
  (8,000 characters at most), `find_tools(query)` returns matching tools with their input schemas and
  `call_tool(name, arguments)` runs one after checking the arguments against the stored schema (a bounded check that
  runs none of the service's regular expressions), with every check of the tool itself. The two names are the same for Claude Code, Codex, the API engine and sub-agents, so the engines'
  tool lists and the model proxy's names stay fixed for the turn.
- **Single tools on and off**, like the tool switches of Claude's connectors: whoever manages the connection (the
  owner of a personal one, an admin for a team one) turns a tool off with its switch (`POST
  /api/integrations/:id/tools {name, enabled}`; people who only use a team connection see which are off). The names
  that are off are kept per connection (`integrations.disabled_tools`, migration 328); every other tool is on, so a
  tool the service adds later is on, and a name stays off when its tool disappears and comes back. A tool that is off is
  left out where the turn's tools are made (`tools.ts integrationToolProvider`), so it is in neither the engine's tool
  list nor the model proxy's names for the turn (a request naming it stops the answer), nor in the list of tools to look
  up, `find_tools` or `call_tool`, and the instructions say how many are off; a call of one turned off during the turn
  is refused before anything is sent. At most 2,000 names are kept off per connection. A change moves the
  connection's version on (a write being asked about is asked again) and is audited (`changed: ["tools"]`, the tool's
  name for team connections only).
- Descriptions start with `[<connection name>, personal|team connection]`. Remote descriptions are the service's words
  (cut to 1,000 characters): tool descriptions are part of what the AI reads, so connecting a server means trusting it
  that far.
- **Sign-in (OAuth)**, following the MCP authorization spec: the server's 401 (`WWW-Authenticate: resource_metadata`) or
  `/.well-known/oauth-protected-resource[/<path>]` → authorization-server metadata (RFC 8414, OpenID Connect discovery as
  fallback; `issuer` must match, S256 must be offered when methods are listed) → dynamic client registration (RFC 7591,
  public client, our callback) → authorization code with PKCE S256, `state` and the `resource` indicator (RFC 8707);
  `iss` in the answer is checked when present (RFC 9207). The scopes asked for are the 401's `scope`, else every scope
  the protected-resource metadata lists; when those are over 2,000 characters (`MAX_SCOPE_CHARS`) none is asked for (the
  server's default grant, as for a server that lists none; a cut list could leave out the one a tool needs) and the
  sign-in logs it. A server without registration cannot be signed in to (use a
  key, or an own app below). Tokens refresh ahead of expiry and after a 401, one refresh at a time per connection; `invalid_grant` means
  "sign in again". Deleting a connection, or a change that drops its sign-in, removes the local tokens first and then
  asks the service to revoke them (RFC 7009, best effort).
- **Services that need no sign-in, added with sign-in** (QA TC-4771, DeepWiki). Sign-in is the form's default way in,
  so a public server is often added with it. When Sign in finds no sign-in at all (`NoSignInFound`: no
  protected-resource and no authorization-server document answered at any address, each answered 4xx or something that
  is not a JSON object, and none was down with a 5xx, a redirect or a network error), the server answered `initialize`
  without a key (no 401) and it also lists its tools without one, the connection is changed to no sign-in
  (`auth: 'none'`, as if chosen under Advanced; it is checked and its tools saved; the audit entry says
  `via: 'no_signin_probe'`) and `authorize` answers `{ connected: true }` with no flow, only when that check connected
  it. Only a connection never signed in, without its own app and not from a template (a template's members bring their
  own key or sign-in). The write happens only while the connection is as it was read before the probe (same version
  and address, no sign-in stored): a sign-in that finished meanwhile, or an address changed, keeps its own state and
  the old answer is given. The requests go through the same address rules as every other. Metadata that answered but
  cannot be used (another resource or issuer, no S256, no code), a metadata address that is down, and a server that
  refuses its tool list without a key all keep `oauth_unsupported`.
- **Services that accept only apps they approved.** Some refuse the app registered for them: the registration answers
  400 or 403 (Figma 403 outside its catalog, Vercel, Square, Intercom and Indeed 400 for a callback not on their list,
  Railway 403 "registration is disabled"; any 4xx naming `invalid_redirect_uri` or `invalid_client_metadata` counts
  too; 429 is `oauth_busy`, "try again in a few minutes"; other answers keep `oauth_unsupported`), or the registration
  works but the sign-in page refuses it (Canva: HTTP 400 "Invalid redirect URI." for any callback but localhost and
  claude.ai). So before the sign-in address goes to the browser the server opens it once (no redirects, 5 s, at most
  4 KB of the answer read, bounded patterns): a 4xx whose text names the redirect address or the client is a clear
  refusal; a plain 400 naming neither is unclear; a sign-in page, a redirect, a Cloudflare challenge, any other 4xx or
  5xx, a timeout or a network error let it go on. A stored app that is refused is followed by one fresh registration.
  After a refusal (an unclear 400 too), a service whose metadata says `client_id_metadata_document_supported` is offered
  a **Client ID Metadata Document** instead (MCP authorization 2025-11-25, draft-ietf-oauth-client-id-metadata-document):
  the client ID is the address of `GET /api/integrations/oauth/client-metadata.json`, a public JSON document (the
  product name, the team's callback, authorization code and refresh, no secret; `Cache-Control: private`), served only
  at the configured public address or the office tunnel's (404 at any other host), and stored with the connection like
  a registered client so the token exchange and refreshes use it. Only when the person's address is public https (not
  localhost, an IP address or a local name): the service has to fetch the document. Without one, a clear refusal stops
  the sign-in (an unclear 400 lets it go on); with one, a refusal of the document stops it too. It stops with
  `oauth_approved_apps_only` ("This service lets only apps it has approved sign in…"), shown on the connection and the
  chat card; nobody on the team can fix it. Such a refusal is kept as a failed flow, so it counts toward the 20 sign-in
  tries an hour (a service that is down or busy does not count). The document is offered only from an address it is
  served at (`documentOrigins`: the configured public addresses and the tunnel's), never from a server without one.
- **Services that take only an app on the computer** (Canva, Intercom, Square; RFC 8252). They refuse every client
  for the team's https callback but take the return address apps on a computer use, `http://127.0.0.1:<port>/callback`
  (Canva: its sign-in page answers 302 instead of "Invalid redirect URI."; Intercom and Square: registration 201
  instead of 400). The desktop app opens a one-time listener there (`desktop/src/common/sign-in-return.ts`, bridge
  `signInReturn`): 127.0.0.1 only, a port the system picks, one at a time (overlapping opens leave only the later one).
  It takes one `GET /callback` with a state and a code or an error, from its own Host, as a page the browser opens
  (Sec-Fetch-Mode `navigate` and Sec-Fetch-Dest `document` when sent), and sends it on with a 302 to
  `https://<team>/api/integrations/oauth/callback?<the same query>` (only the https team origin the window shows; the
  code is never read there), then closes. Any other request gets 404 and never uses it up, however many come. It closes
  after 10 minutes, on Cancel, by a newer one or a team switch. The web page opens one for every sign-in in the desktop
  app and closes it as soon as the answer says it is not used (asking the server first would cost a second try at the
  service). The page passes its port as `loopbackPort` to `POST /api/integrations/:id/authorize`; the route keeps it
  only for a desktop session (`sessions.client`). The usual client choice (registered app, then metadata document, as
  above) always runs first, from every address; only when it is refused is one app registered for the 127.0.0.1 address
  and its sign-in page opened once (the same preflight). Its address is in the flow's sealed client, so the token
  exchange sends it (refresh sends none) and the answer says `loopback: true`. From the web or the phone app (no port),
  one probe registration for 127.0.0.1 tells whether the desktop app would get in: then `oauth_desktop_only` ("Canva
  only lets you sign in from an app on your computer. Open the Trina desktop app and connect it there."; Get the desktop
  app → Settings › Apps on the web, "Connect Canva on a computer." in the phone app), else `oauth_approved_apps_only`
  (Figma refuses that too). Whether a sign-in server takes 127.0.0.1 (keyed by its issuer and registration address,
  never the team's address) is remembered an hour in memory, and only after a clear answer: it spares the web's probe
  and a desktop try at a server that refused 127.0.0.1. Both reasons count as refused tries. A desktop app from before
  this sends no port and keeps `oauth_approved_apps_only`; so does the Mac App Store build when its App Sandbox (no
  `network.server` entitlement) refuses the listener (expected, not tried on a store build yet). The browser that comes
  back finishes in the app, as for every desktop sign-in (below).
- The sign-in flow (`integration_oauth_flows`) lives 10 minutes, at most 20 per person per hour, bound to the person and
  the session that started it (polling `GET /api/integrations/flows/:id` needs that session); the state is stored hashed,
  the verifier and client details encrypted. A connection change while it is pending (version) fails it. For a team
  connection the sign-in is an admin's and the account is then used by everyone its rules name.
- The callback `GET /api/integrations/oauth/callback` finishes at once in a live browser session of the **same person**
  (any of their sessions); one signed in as someone else is refused, nothing exchanged ("This browser is signed in as
  someone else. Sign out here, or go back to the app and press Connect again.", the flow stays pending). A sign-in
  started in the **desktop app** whose return comes in a browser with no session (the system browser has none of the
  app's) is held for the app on this
  computer (docs/decisions/20261121-connect-browser-handoff.md, the pattern of `google-drive/app-return.ts`): the code
  is exchanged, the tokens stay sealed in the flow (`exchanging`, reason `held`, read as `pending` by its poll, 5
  minutes), and the page gives a one-time code (32 random bytes, only its hash sealed) only in the fragment of the
  desktop app's link (`trina-ax://open?url=<team>/#code=…`, opened by itself and by "Back to the app"), names whose
  account it joins and says not to send it on. The app posts it with its own session to the one claim address
  (`POST /api/integrations/google-drive/claim`, which tries Drive, the Google apps, then connections); only the session
  that started the flow redeems it, once, then the same checks and store as a direct return. A used, late, unknown or
  another session's code is refused; Cancel, a new try or the end of its 5 minutes revoke the held tokens (best
  effort). The same return opened again never gives a second code. A web or phone sign-in in a browser without the
  person's session changes nothing and the flow stays pending ("This link expired. Go back to the app and press
  Connect again."). The page is static
  text in the person's language ("you can close this window") with `no-store`, `no-referrer` and a CSP that allows only
  its own hashed `window.close()`; the code and state are never put anywhere else. A sign-in the service did not finish
  says why in plain words, on that page and on the connection's row (never the reason code, the service's answer or a
  secret): access not allowed (`denied`), an own app's Client ID or Secret refused (`client`, from `invalid_client` or
  `unauthorized_client`; `client_template` for a template's app, whose member is told to ask who set it up), the connection changed meanwhile (`changed`), or did not finish (`exchange`, `invalid`). The
  flow is `completed` only once the connection's check after the sign-in has ended (its lifetime starts again when the
  tokens are stored, so a long check is not swept as expired).

## Your own app (client ID)

Some services do not let apps register themselves (no dynamic client registration, RFC 7591), so the MCP sign-in above
cannot start: Google's MCP servers (`https://gmailmcp.googleapis.com/mcp/v1`, `calendarmcp`, `drivemcp`, `docsmcp`,
`sheetsmcp`, `chatmcp` … all `/mcp/v1`) and HTTP APIs that sign in with OAuth, such as NAVER WORKS
(`https://www.worksapis.com/v1.0`). For them a connection or a template carries an app made in the service's console:
`oauthClient { clientId, clientSecret?, authorizationUrl?, tokenUrl?, scope? }` (contract `OAuthClientInput`; the dialog's
"Sign in with my own app").

- **Where:** a personal connection (the member's own app), a team connection (an admin's), or a template (the team's
  app: each member it is for signs in through it with their own account). Members never see a template's secret, and
  the API shows them nothing of the app (`MyIntegrationTemplate` has no field for it, their connection's `oauthClient` is
  null, they cannot set one on it); the client ID and scopes are in the sign-in address they open, as with any app.
  A member signs in through a template's app only while the template is for them: checked when the sign-in starts,
  when the browser comes back and on "check again" (a group change takes effect before the next list removes the
  connection).
  A request to one member cannot carry an app (a template does that).
- **MCP server:** the client ID and secret are enough. The addresses are found from the server's address as for any MCP
  sign-in; `scope` replaces the scopes the server lists (Google's servers list every scope they know, full mail access
  included, so name the ones you want). With both addresses given nothing is looked up: the resource indicator stays,
  and an empty scope asks for none. The first sign-in with a secret that works remembers the token address it used
  (`foundTokenUrl` in `oauth_client`, never shown; `service.ts pinFound`, once the code was exchanged: a sign-in started
  and never finished remembers nothing); a later sign-in whose server names another one is refused before anything is
  sent ("enter the client secret again"), so a server cannot move where the secret goes. Entering the secret again (the
  same one too, audited as `changed: ["tokenAddress"]`) or another app forgets it, and the next sign-in that works
  remembers the new address. Of two sign-ins started before either finished, the first that works decides; the other is
  refused, before its code is exchanged or, when the exchanges overlapped, by keeping none of its tokens. A sign-in
  through a template's app finishes only on the template as it was when the sign-in started.
- **HTTP API:** sign-in is a choice next to a key and needs the app with both addresses. No resource indicator is sent
  (an API has none). `api_request` and the check send `Authorization: Bearer <token>`; a 401 refreshes the token once
  and sends the request again (a refused request did nothing).
- **The sign-in** is the authorization code with PKCE S256 and `state`, as above. The client secret goes only to the
  token address, in the form body (`client_secret_post`: what Google and NAVER WORKS take) unless the server's metadata
  lists only `client_secret_basic`. An answer's `iss` (RFC 9207) must be the issuer found or, with given addresses, on
  the sign-in address's server (the same origin: an issuer may have a path, such as a tenant's); another is refused
  before the code is exchanged (`oauth.ts issuerMatches`). Google (`https://accounts.google.com`) also gets
  `access_type=offline` and `prompt=consent`: without them it hands out no refresh token and the person would sign in
  again every hour. `expires_in` written as text (NAVER WORKS sends `"86400"`) is read as a number.
- **Secrets:** the client secret is sealed in the connections key directory with its own AAD (`<connection AAD>:client`,
  `template:<id>:client`; migration `338_c_integration_oauth_client.sql`, add-only); the client ID, addresses and scope
  are kept in clear (`oauth_client`) to show them to whoever manages it. The secret is never in a response (`hasSecret`
  only), a log line, an audit entry (`ownApp: true`, `changed: ["oauthClient"]`), a flow row or a tool result, and it is
  hidden in what services send back like the tokens.
- **Changes:** the secret is write-only, and a stored one only goes where it went before (`service.ts appAfter`, for
  personal and team connections and templates alike): a change without it keeps it only with the same client ID, the
  same sign-in and token addresses and the same service address, also when the app's addresses are given; otherwise it
  goes unless a new one comes with the change. A second admin can neither point the token address elsewhere and have the
  first admin's secret sent there, nor point the service address elsewhere: the members of a template would sign in at
  the real service's consent screen for the team's app, and their tokens would then go to the new address. The secret
  is bound to the service address it was entered or kept with (`boundUrl` in `oauth_client`, never shown): an older
  build does not know these columns and can change the address and leave the secret (migration 338 keeps reader level
  1), so a secret entered for another address is not used, the view says `hasSecret: false`, and the next save drops it
  (`store.ts secretHere`). A change that leaves the app where it was never opens the secret (an unreadable key folder
  must not cost it on a rename). Another client ID, secret, address or scope drops the sign-in, like a new address:
  tokens are bound to the app; it is also revoked where the sign-in has a revocation address (found addresses may name
  one; given addresses have none). Revoking sends a client secret only to the token address's own server
  (`oauth.ts revoke`): a revocation address elsewhere is not told. This holds for any client with a secret, also one a
  server registered and gave a secret (best effort either way). On a template it deletes the members' connections; they
  are told to connect again. Leaving sign-in removes the app; `oauthClient: null` goes back to the service's own
  registration.
- **Redirect address** to register in the app at the service: `https://<team address>/api/integrations/oauth/callback`,
  the address the app is open at (the server builds it from the page's own address; the dialog shows it with a copy
  button). Register every address people sign in from.

Setting up Google (Gmail, Calendar … MCP servers; in Google's Workspace Developer Preview Program in 2026-11):

1. In a Google Cloud project, enable the product's API and its MCP service (e.g. Gmail API and Gmail MCP).
2. OAuth consent screen: **Internal** for the company's own Google Workspace (no Google verification); otherwise
   External with test users. Restricted scopes (`gmail.readonly`, `drive.readonly`) need Google's verification before an
   External app may go public.
3. Credentials › OAuth client ID › Web application, with the redirect address above.
4. Admin › Connected apps › add, as a template (each member signs in with their own Google account): MCP server,
   `https://gmailmcp.googleapis.com/mcp/v1`, sign-in, "Sign in with my own app", the client ID and secret, and the scopes,
   e.g. `https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose`.

Setting up NAVER WORKS (API 2.0):

1. Developer Console › the app: its Client ID and Client Secret, the Redirect URL above, the OAuth scopes the AI needs
   (`calendar`, `mail`, `file`, `user.read` …), and the access token's lifetime.
2. Admin › Connected apps › add, as a template: API, `https://www.worksapis.com/v1.0`, sign-in, the client ID and
   secret, sign-in address `https://auth.worksmobile.com/oauth2/v2.0/authorize`, token address
   `https://auth.worksmobile.com/oauth2/v2.0/token`, the same scopes, and notes with the endpoints the AI should call.

Neither has been signed in at for real yet (no app existed when this was written); the tests use the fake services.
Code: `oauth.ts` (`ownClient`, `manualServer`, `issuerMatches`), `service.ts` (`appFrom`, `appOf`, `appAfter`,
`pinFound`, `send`), `store.ts` (`secretHere`), `templates.ts` (`appAfter`),
`web/src/components/integrations/IntegrationDialog.tsx` (`AppSection`). Tests:
`tests/unit/c-integrations-own-app.test.ts`, `web/test/unit/integrations.test.ts`.

## GitHub

GitHub's own remote MCP server (`https://api.githubcopilot.com/mcp/`, github.com/github/github-mcp-server) is a Discover
card. It has OAuth metadata but no dynamic client registration, so every host brings its own app. Here that is ONE
**GitHub App the server holds**: a person presses Connect, signs in at GitHub and is connected, with nothing to set up
or paste ([decision](decisions/20261120-github-connector.md)).

- **The app file.** `MYCEL_GITHUB_APP_FILE`, else `<secrets>/integrations/github/app.json`: a private file of the
  server account (regular, one link, mode 0600, outside the team folder; `server/src/integrations/github/app.ts`),
  `{ "clientId": "Iv23…", "clientSecret": "…", "slug": "<the app's name in github.com/apps/<slug>>" }`. Read each
  time (no restart). No answer, log line or audit entry carries it; the list says only `github: { ready, installUrl }`.
  On a hosted team server the hosting service writes it with the tenant command `github-app-set` (stdin only; the
  server account writes the file 0600 in a 0700 folder; the same values again change nothing), from 0.6.0 on.
- **Which connections use it.** Only one at GitHub's exact official address (`serverAppAt`: https, that host and path,
  no port, query or fragment) without an own app of its own or its template's: personal ones, team ones (an admin
  signs in) and a template's members (each with their own GitHub account). The sign-in and token addresses are GitHub's
  (`https://github.com/login/oauth/authorize`, `…/access_token`), fixed in code: nothing is discovered, so no server can
  name another address for the secret. No scope is asked (a GitHub App's permissions are set on the app). The rest is
  the own-app sign-in above (PKCE S256, state, `iss`, the resource indicator, sealed tokens, the secret only in the
  token request's body and hidden in answers).
- **Tokens.** A GitHub App's user token lasts 8 hours and comes with a refresh token (6 months) that works once; it is
  refreshed ahead of expiry with the app's secret **as the file has it now** (a rotated secret needs no new sign-in;
  another client ID ends the sign-ins: GitHub refuses the old refresh token), and the new refresh token is kept.
  GitHub answers a refused code or refresh token with HTTP 200 and `bad_verification_code`, `bad_refresh_token` or
  `incorrect_client_credentials`; these are read as `invalid_grant` / `invalid_client` (`oauth.ts tokenRequest`).
- **Repositories.** The AI sees what the person may see AND what the app's installation covers. People choose the
  repositories on GitHub's installation page (`https://github.com/apps/<slug>/installations/new`), linked from the
  connection's page ("Choose on GitHub"); an organization's owner installs it there, or a member asks
  them to (GitHub's own request flow). No picker of our own.
- **Without the file** the card says "Not set up yet" (a member can ask an admin; an owner or admin reads, in plain
  words, that adding the company's own GitHub App in Admin › Connected apps turns it on), and a
  sign-in fails with "registers no apps" as before. The GitHub dialog keeps Advanced › "Sign in with my own app" (hidden
  for other listed services), so an admin there makes GitHub a team template or team connection with the company's own
  GitHub App (its callback: the server's own address). A member's page then says "Your team set up GitHub. Connect it
  under Your connectors." instead of the ask, and members who asked are told it is ready (QA TC-5656, TC-5661).

Registering the app (once, by an owner of the GitHub organization; GitHub › Settings › Developer settings › GitHub
Apps › New):

1. Name and homepage; **Callback URL** `https://<team domain>/api/integrations/oauth/callback` with **wildcard
   matching on** (it then takes every `<team>.<team domain>` with that path; a server on another address adds its own
   callback, up to 10, or uses an app of its own). **Expire user authorization tokens** on. **Request user
   authorization (OAuth) during installation** off (it would send the browser to the first callback without our
   state). Webhook off. Where can it be installed: any account.
2. Permissions (repository): Contents, Issues, Pull requests: read and write; Metadata: read (always). Add more only
   when a tool needs them (Actions, Checks, Discussions read for the matching tools).
3. Generate a client secret. Put `clientId`, the secret and the app's slug in the file above (0600). No private key is
   needed: the server never acts as the app itself, only as the signed-in person.

Checked for real on 2026-11-20 with the registered app ("Trina AX", github.com/apps/trina-ax, owned by the trina-app
organization) on a copy of the QA team with the real AI: GitHub's MCP server takes the GitHub App user token (46 tools);
in a chat the AI listed issues, read README.md, created an issue and opened a one-line pull request (each change behind
the write card, made "via Trina AX" as the signed-in person); a project chat showed the share card to the asker only
("Waiting for QA Member to confirm" for the others); a refresh at GitHub after the token's 8 hours (clock moved on)
kept the new tokens and the next call worked. GitHub's wildcard callback took `qa.trina.app` and `potenlab.trina.app`
and refused other hosts and other paths.

- **Disconnect** (and signing in again, and a team connection's sign-out at 팀장 넘기기) ends the connection's token at
  GitHub: `DELETE https://api.github.com/applications/<client ID>/token` with the app's ID and current secret as basic
  auth (`github/app.ts revokeGitHubToken`, best effort, 204). The person's authorization of the app itself stays on
  GitHub (GitHub › Settings › Applications › Authorized GitHub Apps lists Trina AX until they revoke it there), so a
  second connection of the same GitHub account here (a personal one and a team one) keeps working.

Not yet: an admin page for the file, keeping the secret behind the hosting service like the Drive broker.
Code: `server/src/integrations/github/app.ts`, `connections/service.ts` (`serverApp`, `currentClient`), `oauth.ts`
(`GITHUB_GRANT_ERRORS`), `shared/src/service-catalog.ts` (`serverAppAt`), `web/src/pages/Connectors.tsx`,
`web/src/components/integrations/ConnectionPage.tsx`. Tests: `tests/unit/c-integrations-github.test.ts`.

## HTTP APIs: `api_request`

`{ connection, method: GET|POST|PUT|PATCH|DELETE|HEAD, path, query?, body? }`, offered when the person may use at least
one HTTP connection. `connection` is `my_<slug>` / `team_<slug>` (a bare slug when unambiguous). The description lists the
connections with their address and the first 1,000 characters of their notes.

- `path` is under the connection's address: `/tasks` with address `https://api.example.com/v1` calls
  `https://api.example.com/v1/tasks` (a path that already starts with `/v1/`, or a full address under it, is taken as
  is). No `..` or `.` segments (also %-encoded), no encoded slashes, no `//`, `\`, `#`, spaces or other hosts.
- Query parameters from the connection's address, the path and `query` are combined. An object or array body (or a
  string that is JSON) is sent as `application/json`, other strings as text; no body for GET and HEAD; 1 MiB at most.
- The answer is the status, type and text (binary types are not shown), cut to 40,000 characters for the AI.

## Reads, writes and the confirmation card

- MCP tools with `readOnlyHint: true` and `api_request` GET/HEAD are reads and run at once. Everything else is a write.
- Writes follow the connection's write policy: `deny` refuses; `ask` (default) shows the server's own card
  (`ToolCtx.person.confirm`, never the AI's `ask_user`) with the connection's name, the tool or method and path, and
  everything that is sent (`details`: scrollable, with its size, recipient-like fields and `api_request`'s full address
  first; a write over 100,000 characters is refused, never shown cut); `allow` sends. `allow` is for team connections
  only (an admin's choice): a personal connection is refused it and asks. With nobody to ask (a scheduled run, no chat)
  a write is refused, except to an `allow` team connection that the schedule's own card allowed (docs/DECISIONS.md
  "Outbound web channels"). That card offers only the `allow` team connections the task names: in its title or
  instruction, or in `schedule_create`'s `connections`; an edit's card also offers again the ones the task may already
  send to (docs/DECISIONS.md "The schedule card offers only the connections the task names").
- After a team chat room was read in the person's own chat (docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"), MCP tools
  the service marks read-only still run at once, and their arguments go to the connected service, unless the arguments
  hold a web address or a long random-looking part: then the room card asks first. `api_request` keeps the room card
  there, GET and HEAD included: the method is the AI's choice, and some APIs change something on a GET. A write asks on this card alone, the room's line on top
  ("여기에 대화방 메시지(다른 사람이 쓴 글)가 들어와서, 무언가를 바꾸기 전에 먼저 물어봐요."), also for an `allow` team
  connection; `deny` still refuses. Scheduled runs are unchanged.
- The person's own connection in a scheduled run: only when the schedule's card listed it with the recipients it may
  send to (`schedule_create`'s `send_to`, "보낼 수 있는 곳: <connection> · '<recipient>'" on the card), and only when every
  value of the call that may say where it goes is one of them (`pinTargets`, at any depth: every text value except
  under a content name such as text, body or title (a whole e-mail or web address under a short one such as title or
  name still counts) or a block's kind such as `type: "text"`, and every number and yes/no except a few settings such as
  `limit`; for `api_request` the full address too). A call with no such value, with more than 50, or nested deeper than 8 is refused.
  What it sends may carry no other web address, host name or long random-looking part (`carriesAddress`, and host
  names in running text) unless it is a pinned recipient or one of the task's own addresses: a link in a message is
  fetched for its preview. An `allow` team connection's content is not checked this way yet (a follow-up).
  After a room read, such a write skips the room card only when every room the run read is on the schedule's card
  (`TurnTool.sendsTo` names the connection a call writes to); an `allow` team connection keeps the room card then. docs/DECISIONS.md "Scheduled tasks: saving and sending allowed on the card".
- **A team file as an attachment** (docs/decisions/20261116-mail-attach-team-file.md): where an MCP tool takes a file's
  content as base64, the AI gives `team-file:<path in the team folder>` as that whole value and the server puts the
  file there (`team-attach.ts`). The file is read as the person as they are now (read permission, a regular file, not
  held by the safety check; one they cannot read answers like one that is not there). The connection's card shows it
  first ("Team file to attach": name, size, folder), and the exact text shows the handle, never the bytes. After the
  card the account, its access and the file are checked again. At most 10 files and 10 MB together in one call. Not
  with a tool that only reads, not in a scheduled run or where nobody can answer a card, not through `api_request`. A
  connection that sends without asking for this person attaches without a card too, only in a turn they watch from
  the app. A file named twice is refused. A file whose bytes hold one of the person's stored keys is not sent
  (compressed content is not looked into). The audit line names each file (path, size, start of its hash).
- Results are wrapped as external data (`<external_data source="<name>">`, the closing tag neutralised inside), and the
  instructions tell the AI that they are data, never instructions.
- **Read scope**: an answer from a personal connection counts like the person's own folder (`{type:'user'}`); from a team
  connection as `{type:'integration', id}`, whose readers are the active people its rules allow today. Saving what the
  chat read somewhere more people can read asks first (`confirmWidening`, chat/read-scope.ts); the card names the
  connection. Any answer also marks the chat as having seen outside content (`session_tainted`).
- The AI's instructions get a short "Connected services" section; the steps under an answer read
  `<connection name> · <tool>` and `<connection name> · <METHOD> <path>` (no translated words, so they show the same in
  every language).

## Apps on your computer (kind `local`)

Decision: [Apps on your own computer as connectors](decisions/20261118-local-app-connectors.md).

- **What it is.** It is a program on the person's own computer that the desktop app runs for the AI. There are two kinds:
  - an MCP server over stdio, such as `aside mcp`;
  - a plain CLI declared as tools, such as ego lite's `ego-browser nodejs` with the script on stdin and its guide from `ego-browser skill`.
- **What the server keeps.** It is the person's own connection only. In the database it is a column `integrations.local_app` (migration 364), and the API calls it kind `local`. The server keeps the command's shape: the program, its arguments, the setting names and the CLI templates. It never keeps a setting's value.
- **Adding one.** Only the person adds it, in Settings › Connectors in the desktop app: Aside and ego lite have cards of their own in Discover (+ connects their preset command, no picker; web/src/lib/localApps.ts), and any other program is Add custom connector › On this computer (a member, who adds no server by its address, gets only that choice). It cannot be added through `POST /api/integrations/local`'s team counterparts, templates, requests or the connect card.
- **How calls travel.** The calls go through the local relay (`server/src/realtime/local-relay.ts`, the sibling of the browser relay) to the desktop window the message was sent from. They never go out over the network.
  - From anywhere else, the AI says that the app works only from the desktop app on that computer.
  - Scheduled runs, shared chats, rooms and sub-agents never get its tools.
- **On the computer** (`desktop/src/common/local-apps.ts`):
  - The desktop app asks once in its own dialog ("Connect this program?"), and again only when the command changes.
  - It starts the program from an argument list, never through a shell, and never runs as root.
  - Setting values are sealed with safeStorage. They are hidden in every answer before it leaves the computer, then `hide.ts` and `redact.ts` run as usual.
  - Stop and quitting the app end the program.
  - A declared CLI's answer is its stdout, then its stderr, also when it exits 0 (ego lite prints a script's
    `console.log` on stderr). Both together are at most `CLI_OUTPUT_MAX` characters, so the answer stays one WebSocket
    frame (under 16 MB): stderr gets what stdout leaves, and a cut stream ends with a note that says how much is missing.
- **Asking before changes.** Writes ask on the normal card with Always allow, like any connection. A CLI tool's script
  (its stdin argument) shows on the card as a code block, byte for byte with its indentation (`cardLines` `isCode`);
  invisible characters, odd spaces and white space at line ends still mean no lines, and the exact JSON stays open.
- **Turning it off.** The team switch `localApps` (Admin › Team settings › Members can connect apps on their computer) turns it off.

## Audit

- Admin audit log: `integration.create`, `integration.update` (also access changes, with before/after, a completed
  sign-in: `changed: ["signIn"]`, and a tool turned on or off: `changed: ["tools"]`), `integration.delete`. Team connections are named with their host; a member's own
  connections only by scope, kind and auth (no name or address).
- Ask a member to connect: `integration_request.create` / `.withdraw` (the admin) and `.complete` / `.decline` (the
  member), with the member, kind, name, host and auth the admin filled in.
- Each call is a `tool_events` row with a summary only: the tool, `api_request <connection> <METHOD> <path> -> <status>`,
  "confirmed by the user" or why it was refused. No arguments, bodies, query strings or secrets.

## Limits

| Boundary | Limit |
| --- | --- |
| Connections | 20 personal per person (that work, have a key or need no sign-in), 50 team. A personal one still waiting for its first sign-in does not count; those have a cap of 20 of their own. A new connection needs room under both (a sign-in one), the sign-in's callback refuses a first sign-in over 20 (`limit`), and an edit that stops or starts waiting is checked the same way. Connect again at a waiting address picks that one up with the new name, notes and write rule. Settings and the chat's connect card count alike (`personalCounts`) |
| Request | 30 s, no redirects, standard ports (a check's `tools/list`: 30 s without bytes, 90 s in all; a `tools/call`: 5 min without bytes, 15 min in all) |
| Answer | 1 MiB while reading; 40,000 characters to the AI |
| Request body (`api_request`) | 1 MiB |
| Team files attached to one call (`team-file:`) | 10 files, 10 MiB together |
| MCP tools | 1,000 per connection, 4,000,000 schema and description characters per connection, 32,000 per tool schema (longer descriptions in it are shortened to fit); as tools of their own 200 and 50,000 characters per answer, the rest through `find_tools` / `call_tool` |
| Reading `tools/list` (a check) | 8 MiB a page, 20 pages and 16 MiB together; stops once the list kept is full |
| Sign-in flow | 10 minutes, 20 per person per hour |

## Discover

Settings › Connectors (`/settings/connectors`, a section of Settings since 2026-11-12; the old `/connectors` addresses
lead there) and Admin › Connected apps are one
page each: first the connections, one line per connection with its details a click away (in Admin with who may use it
in a chip after the name; on Connectors **Your connectors**: the built-in apps connected, the person's own connections and
what the team provides, with a Team label, each with one status and its page a click away, read-only for a team one),
then **Discover**, what is not connected yet: the built-in apps and MCP servers to add by name
(`web/src/lib/connectors.ts`). The search filters every section. An entry is
only a name and an address: nothing about it is special on the server. A person's own Connect (its page, or + on its
card) is one click: the connection is made with "ask before changes" and its sign-in opens; what the AI may change is
set on the connection's page (QA TC-6928). The add dialog stays for the phone app and Admin, where an admin chooses who
may use it, with the address under Advanced. The sign-in, checks and asking are those of any other connection. "Add connection" and the link under the list take any MCP server or API by its address.

The services come from the remote servers listed on [mcpservers.org](https://mcpservers.org/remote-mcp-servers), starting
with its featured ones and those with a curated logo. A listing is not enough: a service is listed here only if it
answers the way this server needs, Streamable HTTP and OAuth with dynamic client registration (see above). Checked on
2026-11-02 with an unauthenticated `initialize` and the public OAuth metadata, not with a real sign-in, so a service can
still refuse a client it does not know. Left out because they need an app of their own: Slack, Asana, HubSpot,
Box, Zoom, Docusign, PagerDuty, Granola, Clerk. Google Drive has its own integration. GitHub is listed although it registers
no apps: it signs in through the server's GitHub App ("GitHub" below).

Logos are files in `web/public/icons/connectors`, because the content security policy loads no image from elsewhere,
and a connection whose address matches a listed service shows its logo too. Where each file came from is not recorded:
the records name sources only for the set as a whole (svgl.app, Simple Icons and the services' own sites, for the
services listed on mcpservers.org). `docs/THIRD-PARTY-NOTICES.md` has a table per file with what is known, and the source
and its terms of each file are still to be confirmed. Because these files are served from the team's own address,
`web/test/unit/connectors.test.ts` reads every SVG as XML and allows only listed elements and attributes, no character
references and no `url()` outside the file, and the server sends `/icons/**/*.svg` with a policy that runs and loads
nothing (`SVG_ICON_CSP` in `server/src/routes/web-static.ts`). Each logo is its owner's trademark and is used only to name
that service.

## Not in phase 1

An own app on a request to one member (a template carries one), a revocation address for an app's given addresses,
Discover entries for Google's MCP servers (they need an app and Google's preview program), office-network APIs, file upload or
download (binary), an admin allow-list of hosts, mobile OAuth return, multi-replica locking of refreshes
(one active app server per team, like Drive), a rekey command for this key directory, reconnect notifications.

## Tests

`tests/unit/c-integrations-{api,tools,oauth,echo,own-app}.test.ts` with `tests/lib/fake-services.ts` (an in-process https MCP
server with sessions and event streams, an OAuth authorization server with registration, PKCE, refresh and revocation,
one without registration for own apps (`/mcp-own`, client secrets checked) and a REST API signed in at with OAuth,
a REST API, and endpoints and MCP tools that repeat the key they got; reached through web_fetch's test-only address
allowance), and the real-turn test at the end of
`tests/unit/i-wiring.test.ts`. No real service is contacted. `tests/unit/c-integrations-approved-apps.test.ts` adds a
service that accepts only approved apps (`/mcp-strict`) and runs the client choice over every listed service's recorded
metadata (`tests/fixtures/connectors/sign-in-metadata.json`). `bun run check:connectors` (`CONNECTOR_NETWORK=1`, never
in the unit run) asks the real listed addresses: a 401 to an initialize without a sign-in, then the metadata as
`discover` reads it. It registers nothing.
