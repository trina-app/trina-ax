# Own app: where its client secret may go (review fixes after #267)

- Date (UTC): 2026-11-09 18:52
- Branch: `fix/oauth-own-client-secret-rules`
- Status: done
- Where: trina-ax core (`server/src/integrations/connections/`, `web/src/lib/integrations.ts`, `web/src/i18n/`, docs).
  Why: fixes to the own-app sign-in of #267, which is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Stricter rules for a stored client secret and the sign-in; no API field, no migration.

## Goal

The independent review of #267 ("Sign in with your own app") found two should-fixes and some nits after it was merged
to `dev`. Fix them forward:

1. **The same secret typed again does not forget the found token address**, though the refusal says to type it again.
   A service that really moved its token address could then never be signed in at again.
2. **A new service address keeps the stored secret when the app has given addresses.** A second admin who never saw the
   secret could point a template at another host: members sign in at the real consent screen for the team's app, and
   their tokens then go to the new host.

## Scope

In:
- `appAfter`: a client secret entered with the app (also the same one) forgets the found token address; a stored secret
  stays only with the same service address, also when the app's addresses are given. The same rule for templates, team
  and personal connections (one rule; a team connection has the same second-admin case), and in the dialog
  (`storedSecretStays`).
- The found token address is remembered after a sign-in that worked (callback), not when one starts; a callback whose
  app remembers another address meanwhile is refused before the secret is sent.
- `authorize` and the callback check that the template still covers the member.
- An `iss` in the answer, with given addresses: its origin must be the sign-in address's origin.
- The address the secret was entered for is kept in `oauth_client` (`boundUrl`); a secret whose connection or template
  moved without it (an older build, migration 338 has reader level 1) is treated as not stored.
- Words: the MCP scope hint (5 languages) says that with given addresses an empty scope asks for none; INTEGRATIONS.md
  and DECISIONS.md (`nextApp` → `appAfter`, "revokes it" only where a revocation address exists).
- Small: the duplicate `owner0` in `create`.

Out: revocation addresses for given setups (still later, as in #267).

## Steps

1. Plan (this commit).
2. service.ts / store.ts / templates.ts: secret rules, pin at success, template coverage, `iss`, `boundUrl`.
3. Web: `storedSecretStays`, scope hint in five languages.
4. Tests: identical secret clears the pin, the template address attack, a connection address change, pin only after
   success, coverage at authorize and callback, `iss` with given addresses, an older build's address change.
5. Docs and CHANGELOG.

## Risks

- Security: the client secret must still never leave for a place its typist did not choose; the new checks only refuse
  more. A member's existing sign-in is kept when the same secret is typed again (the app did not change).
- No migration: `boundUrl` sits in the existing `oauth_client` JSON; rows saved by the first build have none and are
  read as before.
- Five app languages for the changed hint.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, every `c-integration*`,
`c-integrations*`, `remote-mcp-*`, `safe-ops*` test and `docs-site`, the security permission matrix, the whole
`tests/unit` suite (compared with `dev`), and the web unit tests.

## Result

Built as planned: `appAfter` binds a stored secret to the service address for templates, team and personal connections
(and the dialog), the same secret entered again forgets the found token address, the token address is remembered in
the callback after a sign-in worked, the template's coverage is checked at the start and in the callback, `iss` with
given addresses must be on the sign-in address's origin (`oauth.ts issuerMatches`), `boundUrl` in `oauth_client`
(`store.ts secretHere`), the scope hint in five languages, docs and CHANGELOG. No migration, no API field.

Added after an independent review of the first fix commit:
- The callback checks the app again in the write that stores the tokens: of two sign-ins whose exchanges overlapped,
  the one that comes second keeps no tokens (not revoked: that would send the secret there once more).
- A sign-in through a template's app finishes only on the template's version it started with (the same secret entered
  again can bring the app's stored text back to what an earlier sign-in read).
- Forgetting the found token address is audited (`changed: ["tokenAddress"]`).
- "Check again" is refused for a member the template no longer covers (it may refresh a token with the team's app).

Each fix has a test that fails without it (checked by undoing each one). Tests: typecheck, i18n, docs, `docs:api` (no
change); every `c-integration*`, `remote-mcp-*`, `safe-ops*` test and `docs-site` (354 pass); the permission matrix (the
same 3 failures as on `dev`: routes without a case, `driveShareFolders`); the whole `tests/unit` suite (the failing
files fail the same way on `dev`); web unit tests in Docker (1,997 pass, 0 fail, on `dev` 7fb6f3c3).
