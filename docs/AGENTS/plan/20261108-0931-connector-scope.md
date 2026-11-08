# App connectors: a read scope per MCP session, real refusal reasons for write/edit, team rules for connected AIs

- Date (UTC): 2026-11-08 09:31
- Branch: `fix/connector-scope`
- Status: in progress
- Where: trina-ax core (`server/src/connectors/remote-mcp/`, one migration in the A range). Why: the remote MCP
  connector is the core's "AI 연결" (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Connector behaviour fixes; one add-only migration; no API or screen change.

## Goal

A design audit of dev found three connector problems:

1. Everything a connected AI reads is added to the connection's read scope (`remote_mcp_grants.sources`) and nothing
   clears it, so it lasts as long as the sign-in (up to 30 days). One read of a private note blocks every later save to
   a shared folder, in every new session, and the refusal does not say what to do. The in-app chat starts each new chat
   empty.
2. `write` and `edit` hide why a save was refused ("Tool unavailable or access denied." for a read-only folder, a
   plugin-managed folder, a missing folder), and log no rejected-file event; `upload_file` gives the reason.
3. Team rules (header-less `skills/*.md`) and the company profile reach every in-app turn, never a connected AI.

## Scope

In:
- The read scope is kept per MCP session. `initialize` answers with an `Mcp-Session-Id` (MCP Streamable HTTP); the
  client sends it back, and the scope is keyed by the grant and the id's hash. A new session starts empty; the same
  session keeps its scope. The id is never required and never refused (no 404): an unknown id is a new, empty scope,
  which a client could get by initializing again anyway.
- A client that sends no session id has one scope per connection, forgotten after 1 hour without a tool call.
- What older builds stored on the grant is carried into that no-session scope by the migration (clients connected
  before the update send no id until they initialize again), so the update itself widens nothing.
- Upload links remember the session that made them; the PUT checks that session's scope.
- The widening refusal says what to do: a folder with the same or narrower access, or a new session (for clients
  without a session: what they read is forgotten after an hour without tool calls). The room_send refusal and the
  scope-limit line say "session" too.
- `write`/`edit` route their pre-check through upload_file's failure handling (`uploadFailure`): the same reasons,
  the rejected-file event and an audit row; unexpected errors keep the generic answer.
- The connector's `initialize` instructions name the team rule files the person can read (the same first ten the
  in-app AI follows) and the company profile, by path, briefly; `skills_list` lists the rule files marked `rule: true`.
  Clients read them with `read`, so what they read joins the scope as any read does.

Out: a server-side end of a session (DELETE stays 405), a confirmation card for connected AIs, mirroring the scope back
to the grant row for an older build.

## Steps

1. Migration 117 (`remote_mcp_scopes`, `remote_mcp_upload_links.session`, carry-over of grant sources).
2. `scope.ts`: key, load (idle expiry), touch, save (per-grant session cap).
3. `transport.ts`: issue the id on `initialize`, read and check it on other requests, pass it to the tools.
4. `tools.ts`, `upload.ts`, `upload-link.ts`, `rooms.ts`: use the session scope; write/edit failure handling.
5. `guide.ts` and `skills_list`: team rules and the company profile.
6. Tests, DECISIONS entry, CHANGELOG line.

## Risks

- Security: the guard gets weaker by design for a new session (owner's decision: the guard is a guide, not a wall;
  PR #155). Read access checks, skill-root refusals and the size and storage caps do not change.
- Clients that keep one MCP session for many conversations keep one scope for them; clients that open a session per
  request reset it often. Both are what "per MCP session" means; named in DECISIONS.
- Migration 117: highest A number on dev is 116; add-only.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit/remote-mcp-*.test.ts` and the
other tests that name the connector (`rg -l "remote-mcp|remote_mcp" tests`), plus new tests: a new session starts
empty, the same session keeps its scope, the no-session scope expires after an idle hour, write/edit refusal reasons,
rule files in the guide and in `skills_list`.

## Result

Filled in at the end.
