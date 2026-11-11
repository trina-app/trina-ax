# A connection keeps its refreshed tokens when it changes during the refresh

- Date (UTC): 2026-11-11 12:06
- Branch: `fix/connection-refresh-race`
- Status: in progress
- Where: `server/src/integrations/connections/service.ts`. Why: the token refresh of external connections lives there
  (see docs/REPOSITORY-RULES.md: AI connections are core)
- Version impact: patch, a bug fix with no new behaviour or setting

## Goal

QA TC-198 (audit finding #8). A connection signed in with OAuth refreshes its access token when it runs out. When an
admin changes the connection while the refresh is on its way (switches one tool off, renames it, sets "always allow"),
the row's `version` moves on and `oauthToken` throws the new tokens away. A service that rotates refresh tokens has
already made the old refresh token invalid, so the next refresh is refused (`invalid_grant`) and the connection falls to
"needs sign-in" for everyone who uses it. After this change the connection keeps working.

## Scope

In: `oauthToken` stores the refreshed tokens whenever the stored sign-in is still the one that was refreshed (same
refresh token), whatever else changed; only the token fields of the stored secret change. The call that started the
refresh still ends with "the connection changed; try again" when the version moved (a tool may be off now, a write
may need asking again), and the next call uses the kept tokens. Each caller that waited on the shared refresh checks
its own version.

Out: a separate version for credentials (a schema change for no extra gain here); other version checks.

## Steps

1. In the refresh task, read the row and its secret after the token request. If it is still an OAuth secret with the
   refresh token that was used, seal `{ ...stored, tokens }` and write it where `secret_enc` is still that value.
   Else (signed out, signed in again, moved address) the new tokens are dropped, as before.
2. Move the "connection changed" check out of the shared task, after the await, against each caller's own row.
3. Unit test (`tests/unit/c-integrations-oauth.test.ts`): a team connection to the fake service (it rotates refresh
   tokens); the refresh is held, an admin switches a tool off, the refresh ends; the next call works with no new
   refresh and the connection is not `needs_auth`. A second case: the address moves meanwhile; the new tokens are
   not stored.

## Risks

No migration. Security: a token is never stored onto another sign-in (the refresh token must match) or sent to a
moved address (the call still stops on the version check). No UI text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/c-integrations-oauth.test.ts`
and the other `c-integration*` tests.

## Result

