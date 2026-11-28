# Google: a disconnect here never ends the grant elsewhere; a browser sign-in finishes in the return tab

- Date (UTC): 2026-11-28 16:08
- Branch: `fix/google-broker-disconnect-no-revoke`
- Status: done
- Where: `server/src/integrations/google-drive/`, `server/src/integrations/google-apps/`, `shared/src/api/`,
  `web/src/components/`. Why: the Google connectors' service code and pages live there (docs/REPOSITORY-RULES.md).
  trina-cloud gets a companion PR (`src/drive-broker/broker.ts`: the hosting service stops revoking for old servers).
- Version impact: patch (bug fixes; one new value `kept` in four disconnect answers, read only by this server's web app)

## Goal

Windows QA 2026-11-28, a self-installed 0.20.4 server that signs in to Google through the hosting service:

1. Disconnecting Google connectors on that server removed the person's whole "Trina AX" entry in their Google
   account. Google's `/revoke` on any token ends the whole grant of that person for that OAuth client, and the
   hosting service's Google app is one client for every hosted team and every registered server. The same person's
   Drive on qa.trina.app stopped too. The "last sign-in here" rule (docs/GOOGLE-APPS.md "Disconnecting") only knows
   this server.
2. After Google's consent the return page said "Almost done. Go back to the Trina AX app and confirm the account" in a
   browser (there is no app), and the person had to find the first tab and press "Connect this account". The first tab
   cannot close the sign-in window: Google's pages (COOP) cut the window's link to its opener, so the window stays.

## Scope

In:

- A token sealed by the hosting service (broker mode) is never revoked from a team server: disconnect, stop sharing,
  a share whose admin left, the team account's removal, handover, unused sign-in results. The answer is `kept`. The
  company's own Google app (direct mode) keeps today's rule (revoke when it was the last sign-in here).
- After a disconnect with `kept`, Drive's page and the Google apps' toast say the access stays for other Trina
  servers, with a link to Google's third-party connections page to remove it everywhere.
- A browser return with the very session that started a personal sign-in (Drive or a Google app) connects at once;
  the page says "Connected, you can close this tab". The first tab's poll sees `completed` (it already handles it).
- The confirm step stays where it is a choice: a Drive share (an admin names it), the team account of an app, a
  sign-in finished by the desktop or phone app (its code, then confirm in the app). Their browser page says "go back to
  the first tab and press Connect this account", never "the app".
- trina-cloud: `/revoke` answers `revoked` without calling Google (servers before this fix still call it).

Out: auto-finishing the desktop app's claimed sign-ins (confirm in the app stays); MCP connectors' own revoke.

## Steps

1. Server: `isBrokerToken`, `kept` in Drive `revoke`, `end`, shares, handover and Google apps `revokeToken`,
   `disconnect`, `removeTeam`, `dropTokens`.
2. Server: callback auto-completes personal same-session flows (`done: 'connected'`); return page `connected` and the
   browser wording of `ok`.
3. Shared API enums; web messages and link (six languages).
4. Decision file, GOOGLE-APPS.md / GOOGLE-DRIVE.md, changes file, tests.
5. trina-cloud PR.

## Decisions

`docs/decisions/20261128-google-broker-grant-kept.md` (new). Changes docs/GOOGLE-APPS.md "Disconnecting" (owner
decision 9 there stays for the own app) and the "confirm the account" step of docs/GOOGLE-DRIVE.md for browser flows.
The 2026-11-20 decision (`20261120-drive-connect-return-to-app.md`) already notes the account confirm is not a security
step (an attacker confirms too); the binding is the state, PKCE and the same signed-in session.

## Risks

Security: the auto-complete needs the same live session as the flow (not only the same person); a desktop flow without
a session is still held for the app's code. No migration. The six languages for new strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/c-drive-*`, `c-google-*`, the Google apps
unit tests, web unit tests for the connectors.

## Result

Built as planned. Differences: the return page finishes a sign-in only when the route asks (`callbackOutcome(…, {
finish: true })`, routes/drive.ts and google-apps.ts), so the service's `callback` keeps its old meaning for tests and
other callers; a flow the desktop or phone app started is never finished in the browser (its app confirms, as before).
The team server's broker client lost its `revoke` call. trina-cloud companion: `fix/broker-no-grant-revoke`.
