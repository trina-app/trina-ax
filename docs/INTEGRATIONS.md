# External-service connections

The AI can use services outside the team server with a person's or the team's own credentials. Phase 1 has two kinds:

- **MCP servers** (Notion, Linear, GitHub, Atlassian …): the address is enough; the server lists its tools. Sign-in
  (OAuth) or a key.
- **HTTP APIs with a key** (an internal tool such as AI PM): address, key and a note on how to use it. The AI gets one
  tool, `api_request`, that can only call addresses under that connection's address. An API that signs in with OAuth
  (NAVER WORKS …) signs in with your own app instead of a key ("Your own app" below).

Google Drive keeps its own integration ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)), shown in Settings › App connectors as a
card whose Connect goes straight to Google (`web/src/components/integrations/DriveConnector.tsx`; the old
`/settings/drive` leads there), and so does asking the AI from Slack ([SLACK.md](SLACK.md)). App connectors are the
apps this server's AI uses with a person's own account (`web/src/lib/connectors.ts` `APP_CONNECTORS`, one card each).
Admin › App connectors shows whether the server has a Google client and how many members are connected, and an admin
can set the client up there. These connections are the other direction from the "connectors" of
`server/src/connectors/remote-mcp` (outside AI apps such as Claude using this server's files), which are Settings › AI
apps and Admin › AI apps.

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
  is always granted, `offline_access` when asked; **파일 쓰기** (`mcp:write`) is a checkbox for everyone, ticked at the
  start only when the app asked for it; **대화 읽기** (`mcp:rooms`) is ticked at the start, **대화 쓰기**
  (`mcp:rooms.write`) unticked and only with reading (a page without these boxes grants neither); `mcp:admin` comes
  with every new connection of an active owner or admin (no
  box; one line on the page says so), never a member's. The token's `scope` names exactly what was granted, and a
  refresh can only narrow it, so an earlier connection without `mcp:admin` connects again (Settings › AI apps says so).
- `upload_file`: base64 bytes in the call, at most 20 MiB, in practice files up to about 50 KB.
- `create_upload_link`: a one-time `PUT <origin>/connector-uploads/<token>` URL for a larger file (at most 50 MiB,
  10 minutes, one path). Claude Code runs `curl -T "<local file>" "<url>"`. The permissions are checked when the link
  is made and again when the file arrives.
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
| Made by | the member (Settings › External services) | an admin (Admin › External services) |
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
would log every call under that one person; a template keeps each call under its member's own rights. In Admin › MCP,
"Add connection" (and a Discover card's +) asks who connects: **For the team (one key)**, a team connection as above,
the default; or **Template: each member connects their own**, which takes the kind, name, address, sign-in method (an
API key with its header, or OAuth), who it is for (everyone, groups, people; admins only when named) and an optional
note, and never a key or a write rule. The address may not have a query or a fragment (`?…`, `#…`): it goes with every
member's key, so a key there would reach every member and the service would log their calls under its owner. The
name reaches every member's AI, so it may not hold hidden or direction-changing characters, a double quote or control
characters (and the note no hidden characters).

- The members it is for see it in Settings › Connectors under `From <team>`. **Connect your account** opens the same
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
  (`integration.template_reconnect`, one per change). Both open Settings › MCP with the template's Connect
  (`?template=<id>`); they carry its id and name only while it is still for that person, never an address or a key.
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
An admin cannot add a personal connection for someone else. Instead, Admin › External services › "Requests to members"
sends one member a request with the service filled in (kind, name, address, key or sign-in, the key's header, usage
notes for an API). The member gets an inbox entry and a banner, and the admin can copy a link
(`/settings/integrations?request=<id>`; only that member, signed in, can open it). In Settings › External services the
member connects it with their own key or signs in, which creates their personal connection through the same path as
one they add themselves, or declines it. The admin sees the state (waiting, connected, declined, withdrawn, expired
after 7 days) and can withdraw a waiting request; the admin never sees the key or the member's connection. Code:
`server/src/integrations/connections/requests.ts`, migrations `220_b_integration_request_notices.sql` and
`331_c_integration_requests.sql`. Decisions: [DECISIONS.md](DECISIONS.md) "Asking a member to connect a service as
their own".

## Connecting from a chat

A person says in a chat "connect Higgsfield" (or Notion, Linear, GitHub, any MCP server or HTTP API, or their Google
Drive). The AI looks up the service's official address itself, fills in the connection with the `connect_service`
tool, and the chat shows a card. The person does one thing on the card: paste the key, sign in, or press Connect. They
never have to open Settings. Code: `server/src/chat/connect-service.ts` (the tool and the card's endpoint),
`POST /api/turns/:id/connect` (`server/src/routes/chats.ts`), the card in the web app. Contract: `ConnectServiceInput`
(`shared/src/tools.ts`), `ConnectServiceRequest` (`shared/src/api/ws.ts`), `TurnConnectBody` / `TurnConnectResult`
(`shared/src/api/chats.ts`).

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
- **Sign-in services** are added first; the card then runs the usual sign-in (`POST /api/integrations/:id/authorize`)
  and, once it finished, tells the server ("done"), which checks the connection before telling the AI. The card says
  that signing in opens a sign-in page in a new window, to check that it is the service the person expects, and that
  the AI never sees the password; it does not name whose page it is, since the sign-in server comes from the address's
  own metadata. Done before the card connected anything says so. Google Drive uses its own sign-in
  ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)) inside the card, then "done" the same way.
- **Where it is not offered.** Scheduled runs have nobody to finish a card: the tool answers "skipped" at once.
  Sub-agents never get the tool (`PARENT_ONLY_TOOLS`). Confidential chats (Safe operations) do not offer it: it is not a
  local tool, and connected services are not offered there either.
- **A new connection's tools come with the next message.** A turn's tools are fixed when it starts (the engines'
  tool lists and the model proxy's names for the turn), so the AI says it is connected and can use it from the
  person's next message.
- If the person pastes a key into the chat anyway, the AI tells them not to, that it should be revoked and replaced
  at the service, and offers the card (the instructions' rule, `prompt.ts` `CONNECT_RULE`). The web app also warns
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
  Content-Length), compressed answers decoded with the same limit. A check's `tools/list` is the one exception to the
  30 s (below).

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
  its requests end by it, it stops waiting for a session (shared with the calls, which keep their own 30 s) at it, and
  no token refresh starts that could end after it (a token still valid is used). So 90 s stays under the relay's 100 s
  wait for an answer and the server's 120 s idle limit and "Check again" is answered; tool calls keep the 30 s. The tool list is saved (`tools_json`): every tool the service lists, up to 1,000 tools and 4,000,000 characters
  of schemas and descriptions per connection (past that Settings and the AI are told "N of M", or "N of more than M"
  when pages were left unread); a tool whose input schema is not an object or is over 32,000 characters is left out.
  Turns use the saved list only: nothing is fetched when a chat starts. The server keeps the parsed lists in memory by
  connection and `tools_rev` (moved by a trigger whenever `tools_json` changes; at most 64 MiB of saved JSON, the list
  used longest ago first), so a turn reads the connections without their lists and parses only a list that changed;
  who may use a connection and which of its tools are off are read with every turn and call.
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
  `iss` in the answer is checked when present (RFC 9207). A server without registration cannot be signed in to (use a
  key). Tokens refresh ahead of expiry and after a 401, one refresh at a time per connection; `invalid_grant` means
  "sign in again". Deleting a connection, or a change that drops its sign-in, removes the local tokens first and then
  asks the service to revoke them (RFC 7009, best effort).
- The sign-in flow (`integration_oauth_flows`) lives 10 minutes, at most 20 per person per hour, bound to the person and
  the session that started it (polling `GET /api/integrations/flows/:id` needs that session); the state is stored hashed,
  the verifier and client details encrypted. A connection change while it is pending (version) fails it. For a team
  connection the sign-in is an admin's and the account is then used by everyone its rules name.
- The callback `GET /api/integrations/oauth/callback` needs a live browser session of the **same person** (any of their
  sessions); a browser without one, or another person's, changes nothing and the flow stays pending. The page is static
  text in the person's language ("you can close this window") with `no-store`, `no-referrer` and a CSP that allows only
  its own hashed `window.close()`; the code and state are never put anywhere else.

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
4. Admin › External services › add, as a template (each member signs in with their own Google account): MCP server,
   `https://gmailmcp.googleapis.com/mcp/v1`, sign-in, "Sign in with my own app", the client ID and secret, and the scopes,
   e.g. `https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose`.

Setting up NAVER WORKS (API 2.0):

1. Developer Console › the app: its Client ID and Client Secret, the Redirect URL above, the OAuth scopes the AI needs
   (`calendar`, `mail`, `file`, `user.read` …), and the access token's lifetime.
2. Admin › External services › add, as a template: API, `https://www.worksapis.com/v1.0`, sign-in, the client ID and
   secret, sign-in address `https://auth.worksmobile.com/oauth2/v2.0/authorize`, token address
   `https://auth.worksmobile.com/oauth2/v2.0/token`, the same scopes, and notes with the endpoints the AI should call.

Neither has been signed in at for real yet (no app existed when this was written); the tests use the fake services.
Code: `oauth.ts` (`ownClient`, `manualServer`, `issuerMatches`), `service.ts` (`appFrom`, `appOf`, `appAfter`,
`pinFound`, `send`), `store.ts` (`secretHere`), `templates.ts` (`appAfter`),
`web/src/components/integrations/IntegrationDialog.tsx` (`AppSection`). Tests:
`tests/unit/c-integrations-own-app.test.ts`, `web/test/unit/integrations.test.ts`.

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
- Results are wrapped as external data (`<external_data source="<name>">`, the closing tag neutralised inside), and the
  instructions tell the AI that they are data, never instructions.
- **Read scope**: an answer from a personal connection counts like the person's own folder (`{type:'user'}`); from a team
  connection as `{type:'integration', id}`, whose readers are the active people its rules allow today. Saving what the
  chat read somewhere more people can read asks first (`confirmWidening`, chat/read-scope.ts); the card names the
  connection. Any answer also marks the chat as having seen outside content (`session_tainted`).
- The AI's instructions get a short "Connected services" section; the steps under an answer read
  `<connection name> · <tool>` and `<connection name> · <METHOD> <path>` (no translated words, so they show the same in
  every language).

## Audit

- Admin audit log: `integration.create`, `integration.update` (also access changes, with before/after, a completed
  sign-in: `changed: ["signIn"]`, and a tool turned on or off: `changed: ["tools"]`), `integration.delete`. Team connections are named with their host; a member's own
  connections only by scope, kind and auth (no name or address).
- Requests to members: `integration_request.create` / `.withdraw` (the admin) and `.complete` / `.decline` (the
  member), with the member, kind, name, host and auth the admin filled in.
- Each call is a `tool_events` row with a summary only: the tool, `api_request <connection> <METHOD> <path> -> <status>`,
  "confirmed by the user" or why it was refused. No arguments, bodies, query strings or secrets.

## Limits

| Boundary | Limit |
| --- | --- |
| Connections | 20 personal per person, 50 team |
| Request | 30 s, no redirects, standard ports (a check's `tools/list`: 30 s without bytes, 90 s in all) |
| Answer | 1 MiB while reading; 40,000 characters to the AI |
| Request body (`api_request`) | 1 MiB |
| MCP tools | 1,000 per connection, 4,000,000 schema and description characters per connection, 32,000 per tool schema; as tools of their own 200 and 50,000 characters per answer, the rest through `find_tools` / `call_tool` |
| Reading `tools/list` (a check) | 8 MiB a page, 20 pages and 16 MiB together; stops once the list kept is full |
| Sign-in flow | 10 minutes, 20 per person per hour |

## Discover

Settings › Connectors and Admin › Connectors are one page each, with the same title (the Admin shell says `Applies to
everyone in <team>`, Settings "Just for you"): first the connections, one line per connection with its details a click
away (in Admin with who may use it in a chip after the name; in Settings what the team provides under `From <team>`,
read-only, then the person's own under "Connected"), then **Discover**, MCP servers to add by name
(`web/src/lib/connectors.ts`). The search filters every section. An entry is
only a name and an address for the add dialog: nothing about it is special on the server, the person still chooses what
the AI may change, an admin still chooses who may use it, and the sign-in, checks and asking are those of any other
connection. "Add connection" and the link under the list take any MCP server or API by its address.

The services come from the remote servers listed on [mcpservers.org](https://mcpservers.org/remote-mcp-servers), starting
with its featured ones and those with a curated logo. A listing is not enough: a service is listed here only if it
answers the way this server needs, Streamable HTTP and OAuth with dynamic client registration (see above). Checked on
2026-11-02 with an unauthenticated `initialize` and the public OAuth metadata, not with a real sign-in, so a service can
still refuse a client it does not know. Left out because they need an app of their own: Slack, GitHub, Asana, HubSpot,
Box, Zoom, Docusign, PagerDuty, Granola, Clerk. Google Drive has its own integration.

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
`tests/unit/i-wiring.test.ts`. No real service is contacted.
