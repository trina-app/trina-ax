# Connectors: a 403 that is not a bad key says so

- Date (UTC): 2026-11-24 09:54
- Branch: `fix/connector-403-no-access`
- Status: done
- Where: server/src/integrations/connections, web/src/components/integrations, web/src/i18n. Why: a service that
  answers 403 to a working sign-in is shown as a bad key ("Sign in again"), which signing in again cannot fix.
- Version impact: patch (a fix to what a failed connection check says and records; no API or data change)

## Goal

A remote connector that signs in fine but then gets HTTP 403 (GitLab MCP: "MCP server not enabled for any of your
groups") shows "The service didn't accept its key or sign-in. Sign in again." next to "Signed in". The person signs in
again and nothing changes. After this, the page says the account is signed in but not allowed to use the service, with
the service's own short reason, and that the account's or organization's owner turns it on. "Check again" picks it up
once they do.

## Scope

In:
- mcp.ts: a 401/403 keeps the OAuth `error=` code (WWW-Authenticate or JSON body) and a short, sanitized excerpt of
  what the service said (JSON `error_description`/`message`/`error`/`denial_reason`, WWW-Authenticate
  `error_description`, or a short plain-text body): stored secrets hidden, token-like strings hidden, tags and control
  characters removed, at most 200 characters. New module `refusal.ts`.
- One mapping for MCP checks, MCP tool calls and HTTP API checks:
  - 401, or 403 `invalid_token`: unchanged (`refused`, needs_auth, sign in again). A 403 `invalid_token` also gets
    the one token refresh a 401 gets.
  - 403 `insufficient_scope`: new reason `scope` (needs_auth): "Sign in again and allow the access it asks for".
  - any other 403: new reason `no_access` with status `error` (not needs_auth: no "sign in again" notice, no reconnect
    card, no "needs a new sign-in" line for the AI); the excerpt is kept in last_error (`no_access:403:<excerpt>`) and
    shown in the server's words. The AI's call error says the same and that signing in again will not help.
- One log line per refused check: status, reason, excerpt (no tokens).
- Words in every language (server text.ts six languages; web en/ko/ja/es/id/zh for `scope`).

Out: no new buttons, no migration, no change to the API shape (`lastErrorReason` carries the new codes).

## Steps

1. refusal.ts: parse + sanitize + classify; unit tests.
2. mcp.ts McpError carries `oauthError` and `said`; service.ts statusOf / check / callMessage / withMcp use it.
3. text.ts reasons `scope`, `no_access`; reasonText reads the excerpt; connect-service stateOf keeps only the code.
4. Web: REASON_KIND `scope`; `no_access` shows the server's words.
5. docs/INTEGRATIONS.md / CONNECTIONS.md where they describe these states; changes/connector-403-no-access.md.

## Decisions

none (follows the existing reason-code design in docs/INTEGRATIONS.md).

## Risks

- last_error now may hold a third part; every reader that splits on ":" takes the first part (store.ts) or anchors the
  whole code (PASSING); reasonText and stateOf are updated.
- The excerpt is the service's text shown to people: plain text only (React escapes it; tags removed anyway), capped,
  secrets hidden.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for refusal, connection checks and calls, i18n.

## Result

Built as planned. New `server/src/integrations/connections/refusal.ts` (parse, sanitize, classify); mcp.ts `McpError`
carries `refusal`; service.ts statusOf / check / withMcp / callMessage use it and log one line per refused check;
text.ts reasons `scope`, `no_access`, `no_access_bare` in six languages; connect-service gives the AI the code only.
Web: `scope` has its own line ("Sign in again and allow the access it asks for"); `no_access` shows the server's words.
Differs: text.ts parses the code itself instead of importing refusal.ts, since the web mock server imports text.ts and
refusal.ts reaches the chat code (web typecheck). No migration. Tests: tests/unit/c-integrations-403.test.ts.
