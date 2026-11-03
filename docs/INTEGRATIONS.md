# External-service connections

The AI can use services outside the team server with a person's or the team's own credentials. Phase 1 has two kinds:

- **MCP servers** (Notion, Linear, GitHub, Atlassian …): the address is enough; the server lists its tools. Sign-in
  (OAuth) or a key.
- **HTTP APIs with a key** (an internal tool such as AI PM): address, key and a note on how to use it. The AI gets one
  tool, `api_request`, that can only call addresses under that connection's address.

Google Drive keeps its own integration ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)). These connections are the other direction
from the "connectors" of `server/src/connectors/remote-mcp` (claude.ai using this server's files).

## App connectors (the other direction)

A person can connect their own Claude (Claude Code, Claude Desktop, claude.ai) to this server as a remote MCP server
with OAuth (`server/src/connectors/remote-mcp/`, routes in `server/src/routes/remote-mcp.ts`). It is off until the server
has a public origin for it: `server.json` `appConnectors: true` with `tunnel.host` (the Linux installer:
`--public-host HOST --app-connectors`), or the environment variable `MYCEL_REMOTE_MCP_ORIGIN`, which wins when it is
set. Tools: `list`, `glob`, `grep`, `read`, `skills_list`; with the `mcp:write` scope also
`write`, `edit`, `upload_file` and `create_upload_link`. All of them use the person's current folder permissions.

- `upload_file`: base64 bytes in the call, at most 20 MiB, in practice files up to about 50 KB.
- `create_upload_link`: a one-time `PUT <origin>/connector-uploads/<token>` URL for a larger file (at most 50 MiB,
  10 minutes, one path). Claude Code runs `curl -T "<local file>" "<url>"`. The permissions are checked when the link
  is made and again when the file arrives.

Details: docs/DECISIONS.md "App connectors: upload_file for binary files" and "App connectors: one-time upload links".

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
  leaves out anything that looks like one.
- **Nothing is connected until the person presses the card's button.** The tool only opens a card, so an instruction
  planted in a page can make the AI open a card but never finish one. The AI learns only the outcome:
  `{"connected": true, "name", "status", "tools"}` (up to 30 tool names) or `{"skipped": true}` (Not now, the card's
  time ran out, the answer was stopped).
- **The same path and checks as Settings** (`service.ts create`): personal connections switched off, the limits, https
  only, no private, local or office addresses, the header rules, the short name. A team connection only for an admin,
  with the role read again when the card is finished (the endpoint is for any signed-in person). "Just me" names the
  admin in the connection's rule (admins are not users of team connections otherwise); "Everyone" is everyone.
- **The card says where the key goes**: the address's host, next to the key box. The key is stored for that one
  connection and sent only to its address, as for any connection.
- **A wrong key keeps the card open.** The answer says why the check failed, and the next key goes to the same
  connection (its key is replaced): one card makes one connection at most. "Not now" after a failed key removes that
  connection again, the way Settings removes one (audited); a card whose time runs out leaves it in Settings.
- **Answers without a card**, as text the AI can act on: a missing or bad field, an address that is not https or is
  private, personal connections off, a team connection asked for by a member, a connection to the same address that
  the person (or the team) already has (its name and state), the team limit, Google Drive not set up on this server
  (an admin or the operator has to set it up), Google Drive already connected.
- **Sign-in services** are added first; the card then runs the usual sign-in (`POST /api/integrations/:id/authorize`)
  and, once it finished, tells the server ("done"), which checks the connection before telling the AI. Google Drive
  uses its own sign-in ([GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)) inside the card, then "done" the same way.
- **Where it is not offered.** Scheduled runs have nobody to finish a card: the tool answers "skipped" at once.
  Sub-agents never get the tool (`PARENT_ONLY_TOOLS`). Confidential chats (Safe operations) do not offer it: it is not a
  local tool, and connected services are not offered there either.
- **A new connection's tools come with the next message.** A turn's tools are fixed when it starts (the engines'
  tool lists and the model proxy's names for the turn), so the AI says it is connected and can use it from the
  person's next message.
- If the person pastes a key into the chat anyway, the AI tells them not to, that it should be revoked and replaced
  at the service, and offers the card (the instructions' rule, `prompt.ts` `CONNECT_RULE`). The web app also warns
  before sending a message that looks like it holds a key.
- Tests: `tests/unit/connect-service.test.ts` (every answer without a card; the card's fields; a wrong key and then
  the right one on one connection; a seal for another purpose; another person's turn; `/answer` refused; Not now, the
  time running out, a scheduled run; a team connection with the role checked again; sign-in then done; the key and
  the sealed value in no text, row, log or file of the data folder).

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
  "Outbound web channels").
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

Settings and Admin > External services have two tabs: **Connected**, one line per connection with its details a click
away, and **Discover**, MCP servers to add by name (`web/src/lib/connectors.ts`). An entry is only a name and an address
for the add dialog: nothing about it is special on the server, the person still chooses what the AI may change, an admin
still chooses who may use it, and the sign-in, checks and asking are those of any other connection. "Add connection"
and the link under the list take any MCP server or API by its address.

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

Gmail / Calendar / Slack style OAuth apps (each needs its own app registration), office-network APIs, file upload or
download (binary), an admin allow-list of hosts, mobile OAuth return, multi-replica locking of refreshes
(one active app server per team, like Drive), a rekey command for this key directory, reconnect notifications.

## Tests

`tests/unit/c-integrations-{api,tools,oauth,echo}.test.ts` with `tests/lib/fake-services.ts` (an in-process https MCP
server with sessions and event streams, an OAuth authorization server with registration, PKCE, refresh and revocation,
a REST API, and endpoints and MCP tools that repeat the key they got; reached through web_fetch's test-only address
allowance), and the real-turn test at the end of
`tests/unit/i-wiring.test.ts`. No real service is contacted.
