# Sign in with Google: matched by Google's sub only, connected with the current password, resets disconnect it

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: feat/google-login (part A1 of [the plan](../AGENTS/plan/20261122-0454-google-login.md))

- **Ask:** companies on Google Workspace want their staff to press **Sign in with Google** instead of typing a password
  every day.
- **Rule (who a Google account signs in):**
  - An account is found only by Google's `sub`: `login_identities` (migration `131_a_login_identities.sql`) has
    `UNIQUE (provider, subject)` and the key `(user_id, provider)`, so one Google account signs one person in, and a
    person has at most one. `email` and `hd` are kept as of the last sign-in to show in Settings, never to match. A
    Google account nobody here connected gets "not connected", whatever its e-mail (`signInWith` in
    `server/src/auth/google-login.ts`). Google must answer `email_verified: true`.
  - Sign-in opens a session (`AuthService.signIn`, client `web`, cookie) only for a connected account that is active,
    not a guest and not under a forced password change. A turned-off account hears `account_off`, as a password sign-in
    with the right password does; a temporary password from an admin hears `password_first` ("sign in with it first").
- **Rule (connect):** `POST /api/me/google/connect` with the current password (`startGoogleConnect`), and only:
  - from a browser's cookie session (`auth.via === 'cookie'`; a bearer token is refused);
  - not as a guest (the endpoint is not in `GUEST_ENDPOINTS`, and `isGuest` is checked again);
  - not while the account must change its password (the endpoint is not `allowWhilePasswordChange`, so
    `http/route.ts` refuses it);
  - the password is checked by `AuthService.verifyPassword`: wrong tries count against the person's re-check limit and
    are audited (`auth.reauth_failed`), as for a password change.
  - Google's return must come in the same browser (the binding cookie) and the same session that started it, with the
    person still active, not a guest and not under a forced change (`connect`); otherwise `expired`. A Google account
    someone else here connected gives `in_use`. Connecting another Google account replaces my earlier one.
- **Rule (disconnect):**
  - A person disconnects their own with `DELETE /api/me/google`, without a password: it only removes a way in.
  - An admin's temporary password (`resetPassword` in `server/src/admin/users.ts`) and a completed reset link
    (`completeReset` in `server/src/auth/accounts.ts`) delete the person's Google accounts (`forgetLoginIdentities`);
    their audit rows say `googleDisconnected: true`.
  - A person's own password change (`changePassword`) keeps it: they typed the current password, and nothing says
    someone else got in.
  - Account removal deletes the rows (`registerAccountsCleanup`).
- **A credential like the password:** adding or removing a row advances `safe_ops_policy.generation` (the two triggers
  in migration 131), as `319_c_policy_epoch.sql` does for `users.password_hash`. Audit: `auth.google_connected`,
  `auth.google_disconnected`, and `auth.login` / `auth.login_failed` with `method: 'google'` (and a `reason` on a
  failure). Never the Google address, a code, a token, the id_token or the nonce.
- **Why only `sub`:** e-mails here are free text, not unique, and a person can edit their own
  (`server/migrations/001_init.sql`, `PATCH /api/me`). Matching by e-mail would let anyone who controls a Google account
  with that address sign in as that person.
- **Why the password to connect:** someone who only holds an open session (a borrowed laptop, a stolen cookie) must not
  add a way in that outlives the session. The temporary-password and forced-change sessions are refused for the same
  reason: they have not chosen their own password yet.
- **Why resets disconnect:** an admin's reset is how a suspected break-in is locked out. A Google account the intruder
  connected would otherwise outlive it.
- **Not changed:** everyone keeps a password, so the owner handover rule and every password re-check stay as they are
  ([W6 — Onboarding v6: easy owner handover](../DECISIONS.md#w6--onboarding-v6-easy-owner-handover-featonb6-handover-2026-11-08)).
- **Left out:** an admin removing a person's Google account and the "Google" label in Admin › Members, and the Inbox
  notice when one is connected (part A2); joining with Google, accounts without a password, joining by e-mail domain,
  guests, other providers (later plans).
- **Tests:** `tests/unit/a-google-login.test.ts` (password, cookie session, the same session, one Google account per
  person, e-mail never matches, turned-off account, admin reset, disconnect, audit without the address),
  `web/test/e2e/google-login.spec.ts`.
- **Version impact:** minor (new endpoints, an add-only migration, a new optional way to sign in).
