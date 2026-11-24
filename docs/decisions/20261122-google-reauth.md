# Accounts without a password re-check with Google; nothing locks them out

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "Not changed: everyone keeps a password" line of
  [Sign in with Google: matched by Google's sub only](20261122-google-login-identity.md), and the password part of
  ownership in [W6 — Onboarding v6: easy owner handover](../DECISIONS.md#w6--onboarding-v6-easy-owner-handover-featonb6-handover-2026-11-08)
- Branch: feat/google-reauth (part of [sign up with Google](../AGENTS/plan/20261122-0756-google-signup.md), scope items
  3–5; reviewed 2026-11-22)

- **Ask:** with sign-up with Google, an account can be made without a password (`users.password_hash` NULL). Every place
  that asks a signed-in person to type their password again must still work for them, and nothing may leave such a
  person without a way in.
- **Rule (one re-check):** `requireReauth` in `server/src/auth/reauth.ts` is the only re-check: the owner-reauth and
  admin-reauth endpoints (`server/src/http/route.ts`), an admin removing a member, one's own deletion request, the voice
  key, the office update and connecting Google. The bodies spread one fragment, `ReauthFields`
  (`shared/src/api/common.ts`): `password` (as before) or `reauthFlow`, exactly one (both: 400; neither: what the
  endpoint answered for a missing password, 400 where it was required, 403 where it was optional). `SessionService`
  has `verifyReauth` (`AuthService.verifyReauth`).
- **Rule (the Google check):**
  - Only for an account **without** a password. People with a password keep typing it; `POST /api/me/google/reauth`
    answers 409 `has_password` for them, and a confirmed check of an account that got a password meanwhile is refused.
  - `POST /api/me/google/reauth` (a browser's cookie session, not a guest, a Google account connected, the re-check
    limit not locked) starts a Google sign-in flow with intent `reauth`, bound to this session and person, with
    `prompt=select_account`. Google's return must come in this session and answer for the very Google account
    connected to the person (`sub`); it marks the flow `confirmed` with `confirmed_at` and that `sub` (migration 131,
    edited in place: not released) and shows a page that closes itself. Another Google account is refused, audited
    (`auth.reauth_failed`, `method: google`, `reason: wrong_account`, never the account) and counts on the re-check limit.
  - The tab polls `GET /api/me/google/reauth/:id` (only the session that started it; `no-store`): `waiting`,
    `confirmed` or `failed`. It then sends its request with `reauthFlow: <id>`, which spends the flow once, atomically,
    within 5 minutes of `confirmed_at`, for the same session and person, while the same Google account is still the one
    connected and the account is active, without a password and without a forced change.
  - Wrong, used, late, made-up or other-session flows count on the person's re-check limit like wrong passwords and lock
    it the same way (`onReauthLocked`, the owner's note). A locked limit refuses the Google check too, and no check
    starts while it is locked: "There is no sign-in without a password to bypass it" (W6) still holds for the lock.
  - Works in direct and broker mode (the flow and its return are the sign-in's).
- **What a Google check proves:** that the person's connected Google account is signed in in this browser now. It is
  not "typed a password just now": Google may not ask for its password again, and `max_age`/`auth_time` are not used
  (Google does not reliably send `auth_time`, and the broker contract has no `max_age`). It still stops a session
  cookie used on another machine, and only the session that started it can spend it.
- **Rule (Set a password):** `POST /api/me/password` (`setPassword` in `server/src/auth/accounts.ts`), its own endpoint
  (in `changePassword` a missing current password means the forced temporary-password path): new password + a Google
  check; the password rule is checked before the check is spent; refused (409) once the account has a password; open
  reset links stop; other sessions stay; audited `auth.password_set`. Settings › Security & devices shows "Set a
  password" instead of "Change password" for such an account. No Inbox notice: the person did it in this session after
  a Google check, and the existing notice tables are per event type (a new one needs a migration and an Inbox kind).
- **Rule (nothing locks them out):**
  - Google cannot be disconnected from an account without a password: `DELETE /api/me/google` and
    `DELETE /api/admin/users/:id/google` answer 409 `no_password`, read inside the write. An admin's way out is a
    temporary password (`resetPassword`), which works for such accounts and disconnects Google, as before; a reset link
    too.
  - The team switch (Admin › Team settings › Sign in with Google) stops new people only: connecting, and joining or
    starting with Google. Off, the sign-in page still offers Google while someone has no password, and only such an
    account signs in with it (`signInAnyway` in `server/src/auth/google-login.ts`; a password account gets `failed`,
    audited `google_off`); the Google check always runs.
  - The server's own Google client is not removed (own app removal) or replaced by another client id (own app, Admin ›
    Connectors setup) while an active non-guest account has no password: 409 `passwordless_accounts` with the count,
    unless the hosting service serves this server's Google sign-in (`guardOwnGoogleClient` in
    `server/src/auth/google-login-admin.ts`). The same client id with a new secret is fine.
- **Rule (the apps):** the Google check needs a browser: in the desktop and phone apps Google opens in the system
  browser, which does not have the app's session. The dialog says so. Only for one's own account deletion (the store
  apps must let people ask in the app), a person without a password may ask without a check from a session made in
  the last 10 minutes (`requestAccountDeletion`); the request still waits its days, can be cancelled, and the owner is
  told, as before.
- **Rule (W6):** a person without a password who signs in with Google may become owner or admin; the owner steps
  (handover, restore, update, connection, connected folders) take the Google check. The temporary-password rule for the
  handover target stays.
- **Web:** `ReauthDialog` and every inline password re-check (handover, API engine, voice key, office update) use
  `useReauth` (`web/src/pages/admin/common.tsx`): for an account without a password, "Confirm with Google" in place of
  the field; the press opens `about:blank` at once (Safari blocks a window opened after a request), then Google, and
  the request goes when the poll says `confirmed` (`web/src/lib/googleCheck.ts`). `Me.user.hasPassword`.
- **Left out:** the Google check inside the desktop and phone apps (an app-bound flow like sign-in's, later); an Inbox
  notice for Set a password.
- **Tests:** `tests/unit/a-google-reauth.test.ts` (every kind of re-check with a check, used / late / other session /
  other person / made up, another Google account, the lock, accounts that got a password, W6 both ways, disconnect,
  team switch, own client, deletion from the apps, Set a password, admin reset), `web/test/unit/google-reauth.test.tsx`.
- **Version impact:** minor (new endpoints and an optional body field; migration 131 is not released yet).
