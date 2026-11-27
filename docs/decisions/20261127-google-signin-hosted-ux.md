# Google buttons use Google's own words and come first; joining with Google asks for nothing first

- Date: 2026-11-27
- Status: accepted
- Supersedes: part of [20261122-google-signup.md](20261122-google-signup.md) (the join pages asked for a name and a
  username before Google)
- Branch: fix/google-signin-hosted-ux (the owner's Google sign-in plan for self-installed servers, part AX1)

- **Ask:** Hosted teams that sign in through the hosting service saw "This needs a Google app" and no switch in Admin ›
  Team settings. The Google buttons said "Join with Google" and "Start with Google", sat under the password form and had
  no G mark. Joining with Google first asked for a name and a username.
- **Rule:**
  - The admin row counts the hosting service's Google client as well as the server's own
    (`google-login-admin.ts googleClientKind`, read by `googleClientMode` too, so the row and the button never disagree).
  - Button texts are only the three Google's branding guidelines list
    (https://developers.google.com/identity/branding-guidelines, checked 2026-11-27): **Sign in with Google** (sign-in
    page), **Sign up with Google** (setup), **Continue with Google** (invite and team link), translated into the page's
    language as the guidelines allow. The button has Google's standard colour G and the guidelines' light (#FFFFFF fill,
    #747775 edge, #1F1F1F text) and dark (#131314 fill, #8E918F edge, #E3E3E3 text) colours
    (`web/src/components/GoogleButton.tsx`). The app's own font stands in for Google Sans, which it does not load.
  - On the sign-in, invite and team link pages the Google button comes first, then "or", then the password form. On the
    setup page it comes after the team part (Google needs the team name and the setup token) and before the owner's
    password account.
  - `POST /api/invites/google` and `POST /api/team-link/google` take `username` and `name` as optional. The pages send
    neither: on Google's return the username comes from the Google address (`users.ts usernameFromEmail`, "+tag" dropped,
    made unique with -2, -3, …, fallback `member`) and the name from Google (else the username), as setup does. A client
    that sends them gets the old behaviour (the username checked at the start).
  - Guest invites stay password only: no Google button, and the server refuses them (`guest_password_only`) with or
    without a username.
- **Why:** Google allows only those texts and asks for a button at least as prominent as other options. A name and a
  username typed before Google were a step Google can do for the person; they can change both in Profile.
- **Left out:** the hosting console's words, the sign-in broker for self-installed servers, a Workspace domain
  restriction: they wait for the owner's decisions.
- **Tests:** `tests/unit/a-google-login-broker.test.ts` (the admin row in broker mode), `tests/unit/a-google-signup.test.ts`
  (no username on both endpoints, unique, "+tag" dropped, guest refused), `web/test/e2e/google-signup.spec.ts` and
  `google-login.spec.ts` (labels, the G mark, the order).
- **Version impact:** minor: the username became optional on two public endpoints.
