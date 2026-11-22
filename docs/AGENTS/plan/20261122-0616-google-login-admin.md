# Sign in with Google, part A2: the admin side, the connect notice, Google apps in one more tap, the docs page

- Date (UTC): 2026-11-22 06:16
- Branch: `feat/google-login-admin` (part A2 of [the umbrella plan](20261122-0454-google-login.md); built on A1,
  `feat/google-login`)
- Status: done
- Where: trina-ax (`server/src/auth/`, `server/src/admin/`, `server/src/notifications/`, the Google Drive and Google apps
  authorize code, `shared/src/api/`, Admin › Team settings and Members, Settings › Security & devices, the Inbox,
  `docs/site/`). Why: the team switch, the members' label and the connect notice belong to the sign-in feature, which
  lives here (see docs/REPOSITORY-RULES.md).
- Version impact: minor. One team setting, two endpoints, one add-only migration and a new Inbox notice.

## Goal

A1 lets a person connect a Google account and sign in with it. A2 gives owners and admins control over it and tells the
person when their account gets a new way in:

- an owner or admin can turn **Sign in with Google** off for the team, and see and remove a member's Google account;
- the person learns in their Inbox when a Google account is connected to their account (if someone else did it);
- after connecting, Google Drive and Gmail sign in with the same Google account without the account picker;
- a docs page explains it, for teams and for self-installed servers.

## Scope

In:
1. **Admin › Team settings › Members and AI: "Sign in with Google"**, on or off, on by default (a new optional team
   setting `googleSignIn`, stored like the others). Off: `googleLoginAvailable` answers false (no button, no connect,
   no start) and a Google return that was already on its way does not sign in or connect. Connected accounts stay and
   work again when it is turned back on. Owners and admins change it, like the other switches. The row shows only when
   this server has a Google client; without one, one line says how a self-installed server adds one, with a link to
   Admin › Connectors › Google Drive (where the server's Google client and the company's own Google app are set).
   The page learns it from a new admin read, `GET /api/admin/google-login` (`{ client }`), so part B can add the
   hosting service's client there without changing the page.
2. **Admin › Members**: a "Google" label beside a person who connected one (new optional `google` list of user ids in
   `GET /api/admin/users`, like `deletionRequested`), and **Disconnect Google** in the person's "…":
   `DELETE /api/admin/users/:id/google`, with the `guard` rules (nobody acts on the owner or on themselves here, only the
   owner acts on admins), audited as `user.google_disconnected` (no e-mail in the audit).
3. **Inbox notice `account.google_connected`** to the person when a Google account is connected to their account, shown
   always, like `account.reset_link`: its own table `google_connect_notices` (migration `132_a_google_connect_notices.sql`),
   `Notifications.googleConnected`, the event type in `shared/src/api/notifications.ts`, the Inbox words in six languages.
   The source is the connection's `linked_at` (never the Google account or its address). While that same connection is
   still there, the row says what to do if it wasn't them and opens Settings › Security & devices. The table's `user_id`
   is in the account cleanup.
4. **Google Drive and Gmail in one more tap**: with a connected Google account, the direct-mode Google address of a
   person's own Google Drive and of their own Gmail, Calendar, Docs and Sheets carries `login_hint=<that e-mail>`, so
   Google skips the account picker. Not for a Drive or app account shared with the team (often another account), not in
   broker mode (the hosting service builds that address; passing it would change the broker contract). After a connect
   (`?google=connected`), Settings › Security & devices shows one line offering Google Drive and Gmail, linking to their
   connector pages (only the ones not connected yet).
5. **Docs page** `docs/site/use/sign-in-with-google.md` (English), in the nav's "Your account" group (every language's
   nav lists it; the others link to the English page).
6. The guards: `docs/features.ts` (the new endpoints under a new feature `admin.google-sign-in`, with its AI scope and
   scenario), `tests/security/lib/cases.ts` (a case per new route), `bun run docs:api`, `changes/google-login-admin.md`,
   a decision file.

Out: the hosting service's client (B), the apps (C, D), a notice when an admin disconnects someone's Google account,
ending sessions when Google is disconnected (a reset does that), Google Workspace suspension (said in the docs).

## Steps

1. This plan.
2. Server: the setting, `googleLoginAvailable` and the return check it, `GET /api/admin/google-login`, the admin
   disconnect, the `google` list in the users list, the migration and the notice, `login_hint`. Unit tests.
3. Web: the Team settings row, the Members label and action, the Inbox words, the one line after a connect; six
   languages. Web unit tests where the words are picked.
4. Docs page, nav, features, security cases, `docs:api`, changes, decision.

## Decisions

- `docs/decisions/20261122-google-login-admin.md`: the team switch (on by default; off keeps connections and stops a
  return on its way), the always-shown connect notice, `login_hint` only for a person's own Google sign-ins in direct
  mode.

## Risks

- Migration 132: other open branches have 133 and 134; check `server/migrations/` on `dev` right before the merge.
- A1 is still open: this branch changes `server/src/auth/google-login.ts` (the switch, the notice after a new
  connection) and `web/src/components/settings/GoogleAccount.tsx` (the one line after a connect). Kept small.
- Permissions: the switch and the read are admin endpoints; the disconnect uses the members guard.
- Six languages, phone and computer layouts of the Team settings row, the Members row and the person's page.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests: the switch off and on (no start, no
connect, a return on its way refused, connections kept), the admin disconnect and its guard, the users list label, the
notice (one row, no address, the account cleanup coverage test), `login_hint` for Drive and a Google app; web unit tests
for the notice words; `bun run check:prepush`.

## Result

Built as planned, no PR yet (A1 is still open; this branch is merged after it).

- Server: `TeamSettings.googleSignIn` and `server/src/auth/google-login-admin.ts` (the switch, `GET /api/admin/google-login`);
  `disconnectUserGoogle` in `server/src/admin/users.ts`; `google` in the users list; migration
  `132_a_google_connect_notices.sql` and `Notifications.googleConnected`; `login_hint` in the Drive and Google apps
  authorize. A1 files changed: `google-login.ts` (the switch in `googleLoginAvailable` and at the return, the notice after
  a new connection) and `login-identities.ts` (two readers added at the end).
- Web: the row in Team settings › Members and AI, the Members label and Disconnect Google, the Activity words, the
  Drive and Gmail line in `GoogleAccount.tsx`.
- Differs from the plan: the admin side got its own feature id, `admin.google-sign-in` (scenario ADM-08), rather than
  more endpoints under A1's `auth.google`, so the two branches do not edit the same line.
- Tests: `tests/unit/a-google-login-admin.test.ts`, `tests/unit/a-google-login-hint.test.ts`,
  `web/test/unit/google-sign-in-admin.test.tsx`, `web/test/unit/google-account-offer.test.tsx`, a case in
  `web/test/unit/inbox-notice-rows.test.tsx`.
