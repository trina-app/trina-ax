# Every MCP connection gets a refresh token, asked for `offline_access` or not

- Date (UTC): 2026-11-21 10:15
- Branch: `fix/mcp-refresh-without-offline-access`
- Status: in progress
- Where: server/src/connectors/remote-mcp (oauth, policy), the consent page line, docs. Why: the open item of
  docs/decisions/20261120-mcp-connector-session.md (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix to how long a connection lasts; no API shape, no migration

## Goal

A person who connects an app that does not ask for `offline_access` (ChatGPT asks for the 401 header's `mcp:read`
only; MCP SDK clients that follow the 401 `scope` do the same) gets an access token alone and signs in again every
hour. Since #127 a connection is meant to last until the person disconnects it. After this change every connection
gets a refresh token, with the rotation, replay detection and 90-day sliding life of #127.

## Scope

In:
- `decide()` puts `offline_access` in every grant (the token answer's `scope` says so, RFC 6749 3.3, as it already
  does for `mcp:admin` and `mcp:rooms`).
- `issue()` issues a refresh token on every code exchange and refresh, and a refresh that narrows the scope keeps
  `offline_access` (narrowing is for what the app may reach, not for how long it stays).
- The consent page always shows the "Stay connected" line.
- Comments, docs (`docs/site/agents/mcp-connector.md`, the API summary), `changes/` note, a decision file that amends
  20261120-mcp-connector-session.md.

Out:
- Honouring a registration whose `grant_types` leaves out `refresh_token` (registration is not stored; our answer
  already says every client is registered for `refresh_token`).
- Dropping `offline_access` from the protected-resource metadata (SEP-2207 SHOULD NOT): no client is known to break
  on it; a later change.
- Grants made before this change without `offline_access`: they have no refresh token, sign in once more.

## Steps

1. Plan (this file).
2. oauth.ts / policy.ts change, tests updated (the two tests that expected no refresh token) and new tests.
3. Docs, decision, changes note. typecheck, check:prepush, remote-mcp unit tests, tests/security.

## Decisions

`docs/decisions/20261121-mcp-refresh-without-offline-access.md`, amending
[20261120-mcp-connector-session.md](../../decisions/20261120-mcp-connector-session.md) ("Left out").

## Risks

Security: a refresh token now reaches clients that did not ask for one. It reaches only the data of the person who
allowed the app, on the scopes they allowed, bound to the app's client id; it rotates, a replay ends the connection,
and every way the person loses access ends it. No migration. No UI wording changes (an existing string shown always).

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/remote-mcp-*.test.ts`, `tests/security`.

## Result

(at the end)
