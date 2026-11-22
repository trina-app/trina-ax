# Hosted teams sign in with Google through the hosting service

- Date (UTC): 2026-11-22 06:17
- Branch: `feat/google-login-broker`
- Status: done (code and tests; the control plane side is trina-cloud `feat/google-signin-broker`)
- Umbrella plan: [20261122-0454-google-login.md](20261122-0454-google-login.md), part B
- Where: trina-ax (`shared/src/cloud-protocol/google-signin.ts`, `server/src/auth/google-login*.ts`, one raw route)
  and trina-cloud (`src/google-signin/`, its own plan). Why: a hosted team server has no Google client of its own,
  and Google accepts only exact return addresses; the hosting service lends one client with one return address on the
  console host, as it does for Google Drive.
- Version impact: minor. A new optional way to sign in on hosted teams; one new raw route; no migration.

## Goal

After A1, Sign in with Google works only where the server has its own Google client. Hosted teams (`<team>.trina.app`)
have none. With B, a hosted team without its own client signs people in through the hosting service, and the team
server still decides alone who signed in: it checks Google's own signature on the id_token.

## Scope

In:
- Contract `google-signin.ts` (MIT, no imports, its own signing string `trina-google-signin-v1`): signed POSTs
  `status`, `start { v, returnState, codeChallenge, nonce }` → `{ authorizationUrl, clientId, expiresAt }`,
  `redeem { v, handoff, codeVerifier }` → `{ idToken }`; the console callback path, the team return path
  `/api/auth/google/return`, strict parsers, error codes, the start-answer check.
- Team server: broker mode in `google-login.ts` when the server has no Google client of its own, is hosted, the
  hosting service answers `status` for it, and the page is the team's own address. `begin()` calls `start` and keeps
  the broker's client id in the flow (`config_key = gsi-broker:<client id>`, no migration). `GET
  /api/auth/google/return` runs the same binding, once and expiry checks, then `redeem`, then verifies the raw id_token:
  RS256 against Google's keys (`https://www.googleapis.com/oauth2/v3/certs`, cached by `kid`, through the allow-listed
  Google transport), `iss`, `aud` = the recorded client id, `azp`, `exp`, `nonce`, `email_verified`.
- Tests: the broker path end to end with a fake control plane and a local RSA key standing in for Google's.

Out: self-installed servers through the hosting service (never in this version), the desktop and phone apps (C, D),
the relay's waking page for the new return path.

## Steps

1. This plan.
2. The contract file, exported from `cloud-protocol/index.ts`, with parser tests.
3. The id_token verifier with Google's key cache.
4. Broker mode in `google-login.ts`, the return route, coverage lists.
5. Tests, docs (`docs/site` reference, `changes/google-login-broker.md`).

## Decisions

The client decision of the umbrella plan (`docs/decisions/20261122-google-login-client.md`, written in A) covers this:
the team server checks Google's raw id_token itself in broker mode. No new decision file.

## Risks

- The control plane can send a browser to the team address with a handoff of its choice, but it cannot make an
  id_token Google did not sign for its client, with this flow's nonce. A changed client id mid-flow fails (`aud`).
- Google's key endpoint down: broker sign-in fails ("failed"), password sign-in is unaffected.
- No migration (the client id lives in `config_key`). Number 134 stays free.
- The six app languages: no new people-facing text; broker failures map to the existing results.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/a-google-login*.test.ts`,
`tests/unit/cloud-protocol.test.ts`, `bun run check:prepush`.

## Result

- Contract `shared/src/cloud-protocol/google-signin.ts` with a `status` call beside `start` and `redeem` (the button
  shows only after the console says it serves this team, as Drive does).
- `server/src/auth/google-login-broker.ts` (signed calls, the start answer checked with `googleSigninAuthorizeUrl`),
  `server/src/auth/google-id-token.ts` (RS256 against Google's JWKS through the allow-listed Google transport; one more
  allowed address in `google-drive/client.ts`), broker mode in `google-login.ts` (`googleLoginMode`, async `begin`,
  `settle` with a mode: a flow comes back only the way it went), raw route `GET /api/auth/google/return`.
- No migration: the broker's client id is kept in `config_key` (`gsi-broker:<client id>`).
- Tests: `tests/unit/a-google-login-broker.test.ts`.
