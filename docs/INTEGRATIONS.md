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
  reader's words (`text.ts`), never the service's own body.

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
  Content-Length), compressed answers decoded with the same limit.

## MCP servers

Streamable HTTP, implemented here without an SDK: JSON-RPC POSTs with `Accept: application/json, text/event-stream`,
JSON or event-stream answers (reading stops once our reply has arrived, so a stream that stays open is fine), the
`Mcp-Session-Id` kept, `MCP-Protocol-Version` on every request after `initialize`. A session is reused for up to 10
idle minutes; a 404 for it starts a new one.

- **Check** (on create, on change of address or key, "Check again"): `initialize` → `notifications/initialized` →
  `tools/list` with every cursor page (at most 20). The tool list is saved (`tools_json`); at most 100 tools and
  256,000 characters of schemas per connection; a tool whose input schema is not an object or is over 32,000 characters
  is left out. Turns use the saved list only: nothing is fetched when a chat starts.
- **Tool names** for the engine: `my_<slug>__<tool>` (personal) and `team_<slug>__<tool>` (team), letters, digits, `_` and
  `-` only. With the engine's `mcp__team__` the full name stays within 64 characters: longer or clashing names are cut and
  given a short hash; the server maps each back to the remote name. At most 200 such tools per turn.
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

- Admin audit log: `integration.create`, `integration.update` (also access changes, with before/after, and a completed
  sign-in: `changed: ["signIn"]`), `integration.delete`. Team connections are named with their host; a member's own
  connections only by scope, kind and auth (no name or address).
- Each call is a `tool_events` row with a summary only: the tool, `api_request <connection> <METHOD> <path> -> <status>`,
  "confirmed by the user" or why it was refused. No arguments, bodies, query strings or secrets.

## Limits

| Boundary | Limit |
| --- | --- |
| Connections | 20 personal per person, 50 team |
| Request | 30 s, no redirects, standard ports |
| Answer | 1 MiB while reading; 40,000 characters to the AI |
| Request body (`api_request`) | 1 MiB |
| MCP tools | 100 per connection, 256,000 schema characters per connection, 32,000 per tool; 200 per turn |
| Sign-in flow | 10 minutes, 20 per person per hour |

## Not in phase 1

Gmail / Calendar / Slack style OAuth apps (each needs its own app registration), office-network APIs, file upload or
download (binary), per-tool switches, an admin allow-list of hosts, mobile OAuth return, multi-replica locking of refreshes
(one active app server per team, like Drive), a rekey command for this key directory, reconnect notifications.

## Tests

`tests/unit/c-integrations-{api,tools,oauth,echo}.test.ts` with `tests/lib/fake-services.ts` (an in-process https MCP
server with sessions and event streams, an OAuth authorization server with registration, PKCE, refresh and revocation,
a REST API, and endpoints and MCP tools that repeat the key they got; reached through web_fetch's test-only address
allowance), and the real-turn test at the end of
`tests/unit/i-wiring.test.ts`. No real service is contacted.
