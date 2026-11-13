# Gmail, Google Calendar, Google Docs and Google Sheets: one shared Google account for the team, set up by an admin

- Date (UTC): 2026-11-13 04:08
- Branch: `feat/google-team-connection`
- Status: in progress
- Where: trina-ax core (`server/src/integrations/google-apps/`, `connections/`, `web/src/components/integrations/`).
  Why: built-in connectors are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (a new admin feature, new API endpoints and fields, an add-only migration).
- Source: QA sheet TC-198, tracking TC-748.

## Goal

Today each Google app (Gmail, Calendar, Docs, Sheets) is per person only: Admin › Connectors › <app> › Team settings ›
Who can use it is fixed text ("Everyone in the team, each with their own Google account"). Other connectors can be
connected once for the team ("For the team (one key)") with a rule of who may use it. An admin wants to connect one
Google account (say a team mailbox or a shared calendar) once and let chosen people use it in their chats without
connecting their own. Only owners and admins may make, change or remove that shared connection.

Google Drive already has this: "Drives shared with the team" (admin-only, chosen folders, the same people picker). It
stays as it is; only its Who-can-use line is made to say it.

## Design

**Reuse the team-connection model, no second permission system.** A shared app is an `integrations` row with
`scope = 'team'`, `owner_user_id = NULL`, `google_app = <app>`, its rule in `integration_access` (everyone, groups,
people), its tokens sealed with the team AAD (`team:team:<id>`). `store.ts mayUse` then gives it exactly the rule every
team connection has (an access rule must match; being an admin is not one). Everything that already asks `mayUse` /
`usable` covers it: the turn's tools (chats, side chats beside a room, scheduled runs), the read scope of a chat
(`usersOf`), hiding secrets (`secretsFor`), member Always allow (`integration_user_allow`, pruned with the rule).

**Per member stays the default.** Nothing is shared until an admin connects the shared account and saves who may use
it; its rule starts as nobody (like a Drive share), so a half-made one reaches no one.

**One shared connection per app.** A partial unique index; the service also checks in its transaction.

**A member's own connection is never touched.** The shared one is a different row (`scope = 'team'`); connect,
reconnect and remove of the shared one never read or write a personal row. A member who has both gets both in a chat:
`my_gmail__…` (their own) and `team_gmail__…` (the team's); the AI's list says which is the shared account (its email)
and to use the person's own unless they ask for the team's.

**Writes keep asking.** The shared connection's write rule is `ask` and no screen changes it (the generic manage APIs
already refuse `google_app` rows). A change asks on the card in the member's chat; the card's Always allow is that
member's own (team-connection rule, `integration_user_allow`), never after outside content or a room read. A scheduled
run cannot send through it (a team connection set to ask has nobody to ask: refused). Gmail attachments by address stay
refused. A reconnect with another account clears members' Always allow (they chose it for the old account).

**Revocation.** Removing the shared connection, or a person disconnecting their own app, revokes at Google only when no
other Google sign-in here uses the same Google account (personal apps, the shared ones, Drive), since Google revokes a
whole grant.

**Handover.** The admin who signs in the shared account is recorded in `team_sign_ins` (`team_connection`), so 팀장
넘기기 lists and can end it like other team sign-ins.

## Data

Migration `349_c_google_app_team.sql` (348 is taken by an open branch, feat/slack-read-one-connect), additive, reader 1:
- `google_app_flows.scope TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','team'))`: a sign-in an admin
  started for the shared connection; only the admin's team complete accepts it, only the personal complete a personal one.
- `CREATE UNIQUE INDEX integrations_google_app_team ON integrations(google_app) WHERE google_app IS NOT NULL AND scope = 'team'`.

An older build ignores the column; it never offers a team `google_app` row (its `mayUse` requires personal) and its
generic lists hide `google_app` rows from manage APIs.

## API (shared/src/api/google-apps.ts)

All `auth: 'admin'` (the route kit checks the role), and the service checks the caller is an active owner/admin again:
- `POST /api/admin/google-apps/:app/team/authorize` → sign-in for the shared account.
- `GET /api/admin/google-apps/:app/team/flows/:id`, `DELETE …/flows/:id` → poll, cancel (own session's flow only).
- `POST /api/admin/google-apps/:app/team/flows/:id/complete` → makes or replaces the shared connection (rule kept on a
  reconnect, nobody for a new one).
- `PUT /api/admin/google-apps/:app/team` body `{ access }` → who may use it (groups and people checked to exist).
- `DELETE /api/admin/google-apps/:app/team` → remove it (tokens at once, then Google when no other sign-in uses it).
- `GoogleAppAdminStatus.team`: `{ status, account, access, usedBy, connectedBy }` or null.
- `GoogleAppView.team` (member's view): `{ account, status }` only when the shared one covers that person; null else.

## Permission checks (server), each with a unit test

1. Members get 403 on every team endpoint (route role) and the service refuses a non-admin actor too.
2. A team flow cannot be completed by the personal complete and the other way round; a flow is bound to its admin and
   session.
3. Members outside the rule: no tools in a chat turn, scheduled run or side chat; not in `usersOf`; not in their view.
4. The admin themselves is not covered unless the rule includes them.
5. Connecting / reconnecting / removing the shared one leaves every personal row (tokens, Always allow) unchanged.
6. Generic connection APIs (`/api/integrations/...`, admin team list) do not list or manage the shared row.
7. Writes ask on the card; the scheduled run is refused; Always allow is the member's own row.
8. Removing a group or a person from the rule takes their access (and their Always allow) away.

## Web

- Admin › Connectors › <app> › Team settings: "Who can use it" says each person connects their own, and below it a
  "Shared Google account" row: empty → **Connect for the team**; connected → the account, who uses it and how many,
  ⋯ with Change people, Reconnect, Remove. The dialog is Drive share's: Google sign-in, confirm the account, then the
  people picker (`AccessPicker`), Save; Cancel before Save removes it again.
- Settings › Connectors › <app> (member): a line "Shared by an admin: <account>. You can use it in your chats." when it
  covers them; their own Connect stays. No way for a member to make or change the shared one.
- Removed: the fixed sentence "Each member connects their own … account" in the page's about line is reworded to say
  both ways.

## Plain-words check

No "OAuth", "token", "scope", "MCP", "team connection". Words: "Shared Google account", "Connect for the team", "Who can
use it", "Shared by an admin", "Remove". Five languages.

## Risks

- Migration number clash with parallel branches: check right before push.
- `noteAnswer` used `owner_user_id!` for Google apps: a team row has none, so a team app's answer is scoped to the
  connection's people (as other team connections).
- Real Google sign-in cannot run locally: tested with the fake Google / broker / library doubles.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api` + docs-site test; unit `c-google-apps-*.test.ts`,
`c-integrations*`, a new `c-google-apps-team.test.ts`; `test:web`, `build:web`, e2e of the Google admin and member pages.

## Result

(filled in at the end)
