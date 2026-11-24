# Connections: register the app with the scope the sign-in asks for

- Date (UTC): 2026-11-24 10:00
- Branch: `fix/oauth-register-with-scope`
- Status: done
- Where: server (`integrations/connections/oauth.ts` register, chooseClient, loopbackClient; `service.ts` clientFor)
- Version impact: patch (a bug fix; no API change)

## Goal

Connector sign-in check 2026-11-24: Calendly's sign-in page always said "The requested scope is invalid, unknown, or
malformed." Trina asks for the scopes Calendly's MCP server lists (`scopes_supported`: `mcp:notetaker:read
mcp:scheduling:read mcp:scheduling:write`).

## Cause

Trina registered its app (RFC 7591) without `scope`. Calendly then gives the app only its default scopes
(`mcp:scheduling:read mcp:scheduling:write`) and refuses a sign-in that asks for more. Checked by hand on 2026-11-24 with
two registrations at `https://calendly.com/oauth/register`: without `scope` the answer had the two default scopes and
the same authorize URL showed the error; with `scope` the answer had all three and Calendly showed its consent page.

## Change

- `register` sends the sign-in's scope (when there is one) and keeps it on the client as `registeredScope`.
- `chooseClient` and `loopbackClient` pass the setup's scope.
- `clientFor` does not offer the stored app again when the sign-in asks for a scope it was not registered with, so a
  connection registered before this change gets one fresh registration on its next sign-in.

## Tests

`tests/unit/c-integrations-approved-apps.test.ts`: the scope goes with the registration and stays on the client; no scope
is sent without one; chooseClient registers with the setup scope. The fake `/as/register` records what it got.
