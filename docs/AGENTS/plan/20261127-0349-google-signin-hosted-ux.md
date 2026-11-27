# Google sign-in on hosted teams: the admin switch, Google's button words, Google first, join without a username

- Date (UTC): 2026-11-27 03:49
- Branch: `fix/google-signin-hosted-ux`
- Status: in progress
- Where: server/src/auth, shared/src/api, web/src/pages. Why: sign-in and its pages live there (see docs/REPOSITORY-RULES.md)
- Version impact: minor. `username` (and `name`) become optional on `POST /api/invites/google` and
  `POST /api/team-link/google`; older clients that send them still work.

## Goal

A hosted team that signs in with Google through the hosting service saw "This needs a Google app" in Admin › Team
settings and no switch. The Google buttons used words Google's branding guidelines do not list ("Join with Google",
"Start with Google"), had no G mark and sat below the password form. Joining with Google first asked for a name and a
username that Google can give.

## Scope

In (AX1 of the Google sign-in plan for self-installed servers):
1. `googleSignInClient` counts the hosting service's client too (one helper, `googleClientKind`, that
   `googleClientMode` in google-login.ts uses as well). The Team settings hint is right for both.
2. Button words per https://developers.google.com/identity/branding-guidelines: "Sign in with Google",
   "Sign up with Google" (setup), "Continue with Google" (invite, team link), with Google's colour G mark and the
   light and dark button colours that page gives.
3. Google on top, then "or", then the password form: sign-in, setup, invite and team link pages.
4. `/api/invites/google` and `/api/team-link/google` without `username`: the server picks one from the Google
   address on the way back (`usernameFromEmail`, as setup), the name comes from Google. "Fill in your name and
   username first" goes. Guest invites stay password only.

Out: the hosting console's words, the sign-in broker for self-installed servers, a domain restriction (owner decisions).

## Steps

1. Server: `googleClientKind`, `googleSignInClient` reads it; optional username and name in `GoogleJoinBody`; the start
   checks the username only when given; the return picks it from the e-mail when absent.
2. Web: a Google button with the G mark; Google first on the four pages; the join pages send no username.
3. i18n: en.ts first, then every locale.
4. Tests: a-google-login-admin (broker mode), a-google-signup (no username, unique, +tag dropped, guest refused),
   web e2e (labels, order).

## Decisions

docs/decisions/20261127-google-join-without-username.md: a join with Google takes its username from the Google address.

## Risks

No migration. Public API: additive (fields optional). Five app languages. Phone and desktop apps keep the password
join (they never offered Google sign-up).

## Tests

`bun run typecheck`, `bun run check:prepush`, the auth unit tests, web e2e for the sign-in and sign-up pages.

## Result

(filled in at the end)
