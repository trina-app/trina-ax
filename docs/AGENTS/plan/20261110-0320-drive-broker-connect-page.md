# Hosted Google Drive sign-in starts on the hosting service's own page

- Date (UTC): 2026-11-10 03:20
- Branch: `feat/drive-broker-connect-page`
- Status: in progress
- Where: `shared/src/cloud-protocol/drive-broker.ts` (MIT wire contract), `server/src/integrations/google-drive/`,
  `web/src/components/settings/`, `web/src/components/integrations/`. Why: the broker contract and its team-server
  client live here; the hosting service's page lives in the control plane (see docs/REPOSITORY-RULES.md).
- Version impact: minor, a new backward-compatible field in the broker contract and a new step in the web sign-in.

## Goal

On a hosted team (`<team>.<team domain>`), **Connect Google Drive** opens Google's sign-in straight away. The person
never sees that the hosting service signs in for the team, and Google's "unverified app" warning (the Drive scope is
restricted, so an unverified app shows it) comes without any explanation.

After this change the web app first opens the hosting service's page (`<console origin>/drive-broker/connect`). It names
the team, says what Trina reads (Drive, read-only), explains Google's warning and how to continue, and has one
**Continue to Google** button. Google then returns to the hosting service and the person lands back on the team as
today.

## Scope

In:
- Contract: `DRIVE_BROKER_CONNECT_PATH = '/drive-broker/connect'`; the start answer MAY carry `connectUrl`
  (`<console origin>/drive-broker/connect?state=<43 base64url>`), next to `authorizationUrl` (Google, unchanged).
  `driveBrokerConnectUrl()` checks that shape for a given origin.
- Team server: `DriveBroker.start()` returns both; `connectUrl` only when it is exactly that page on the configured
  broker origin (else dropped). The Drive authorize answers (`/api/integrations/google-drive/authorize` and the share
  authorize) get an optional `connectUrl`.
- Web: the browser window opens `connectUrl` when present; the Google link stays as the fallback. The phone app keeps
  opening Google directly, because the installed native app accepts only `accounts.google.com`.
- Control plane (separate repository): the page itself, returning `connectUrl` from `start`. Tracked there.

Out: Google verification; a direct (non-hosted) server, which keeps its own client and opens Google as today; any
change to the native phone app.

## Steps

1. Contract: path constant, optional `connectUrl` in `DriveBrokerStartAnswer`, `driveBrokerConnectUrl(origin, url)`.
2. `broker.ts` `start()`: return `{ authorizationUrl, connectUrl? }`; `oauth.ts`: pass `connectUrl` through.
3. `shared/src/api/drive.ts`: optional `connectUrl` in the authorization answer.
4. Web (`DriveConnection.tsx`, `DriveShares.tsx`): check `connectUrl` (https, exact path, one `state`), open it in the
   reserved window outside the phone app; keep the Google URL check for the phone app and the fallback link.
5. Tests: contract parser, broker start (accepted, wrong origin dropped, missing kept Google-only), web helper.
6. Docs: `docs/GOOGLE-DRIVE.md` "Hosted teams".

## Risks

- Phishing: the page is on a fixed origin the operator set (`MYCEL_GOOGLE_DRIVE_BROKER_URL`), checked by the server;
  the web checks the path and the single `state`. The page never takes a return address from the request.
- Mixed versions: an old team server ignores `connectUrl` (Google first, as today); a new team server with an old
  control plane gets no `connectUrl` (Google first). Nothing breaks in either order.
- No migration. Five app languages: no new strings in this repo (the page text is the control plane's).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/c-drive-*.test.ts`, the web unit tests for
Drive, the web e2e `drive.spec.ts`.

## Result

Filled in at the end.
