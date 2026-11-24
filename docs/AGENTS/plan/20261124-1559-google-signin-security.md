# Google sign-in: security fixes before 0.18.0

- Date (UTC): 2026-11-24 15:59
- Branch: `fix/google-signin-security`
- Status: in progress
- Where: server/src/auth (google-login.ts, reauth.ts, accounts.ts, deletion-requests.ts), admin/users.ts,
  notifications, web Activity text. Why: security review of #400 (Sign in with Google) before it ships.
- Version impact: patch — security fixes to a feature not yet released; no API shape change, one additive migration.

## Goal

Someone at an unlocked browser where the victim's Google is signed in must not take over a passwordless account
(replace its Google link, set a password they know), and must not lock passwordless people out by filling the
server-wide Google flow cap.

## Scope

In:
1. Passwordless account: `connect` refuses a Google account other than the linked one (at the start and at Google's
   return); an admin's temporary password is the way to change it.
2. Fresh Google re-check: re-check flows ask Google for a new sign-in (`max_age=0`, `auth_time` requested through
   `claims`); the return needs an id_token `iat` within 60 s and, when Google sends `auth_time`, a sign-in within
   5 minutes. Covers every re-check endpoint (setPassword, connect, ownership transfer, member removal, owner/admin
   re-check routes, deletion request).
3. Owners and admins get an Activity row (credential.change, actions `signin_*`) on every Google link change
   (connect, replace, self/admin disconnect, admin reset that disconnects) and on setPassword; setPassword also tells
   the person.
4. `disconnectGoogle` and admin `disconnectUserGoogle` end that person's other sessions.
5. Flow cap: the server-wide cap counts only flows without a signed-in person (re-checks and connects, one per person,
   are never blocked by it), plus a cap of open sign-in flows per address (migration 134: `ip_hash`).
6. `requestAccountDeletion` for a passwordless account always needs the Google re-check (no recent-sign-in shortcut).

Out: Google's own `prompt=login` (Google does not support it).

## Steps

1. Server changes above; messages in six languages; web Activity texts.
2. Tests: exact attack paths in tests/unit/a-google-reauth.test.ts plus new cases.
3. typecheck, check:prepush, unit + security tests for auth.

## Decisions

docs/decisions/20261124-google-signin-security.md

## Risks

Migration 134 (component A, additive). If Google ignores `max_age` and the client has no `auth_time` setting, the
re-check proves only `iat` freshness; the connect rule and the staff notices still close the takeover.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, tests/unit/a-google-*,
tests/security.

## Result

(at the end)
