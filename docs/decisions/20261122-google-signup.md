# Sign up with Google: the first owner, invites and the team link make an account with no password

- Date: 2026-11-22
- Status: accepted
- Supersedes: the connect-only part of [Sign in with Google: matched by Google's sub only](20261122-google-login-identity.md)
  ("a Google account is connected only from a signed-in session with the current password"): an account made with
  Google gets its Google account at sign-up. Connecting one to an existing account still needs the current password.
- Branch: feat/google-signup ([the plan](../AGENTS/plan/20261122-0756-google-signup.md), Scope 1, 2 and the web pages)

- **Ask:** the founder (2026-11-22): customers sign up and pay with Google at account.trina.app, then the team server
  asks for a username and a password, and every invited employee makes one too. Sign-up with Google before launch.
- **Rule (where):** three starts, each in a browser only, each offered where the server says so (`googleSignUp` on
  `GET /api/setup`, the invite's info and the team link's info: this page can sign in with Google,
  `googleLoginAvailable`, and for the setup only while that visitor is told setup is needed, so the relay still tells
  nobody without the setup token whether the team exists):
  - `POST /api/setup/google`: the setup token, the team name, language, time zone and website;
  - `POST /api/invites/google`: the invite token in the body, the username, name and language the person picked;
  - `POST /api/team-link/google`: the same for the team link.
  A fresh self-installed server without a Google client file shows only the password form; a hosted team has a client
  through the hosting service (`googleClientMode` broker).
- **Rule (the start checks what the password form checks, at once):** the setup token as `POST /api/setup` does
  (`checkSetupToken`: never from the office internet or Tailscale address, the relay's order, wrong tokens counted per
  address), the hosted team name (`ownerTeamName`); an unknown time zone or a website that is not one is dropped there.
  An invite (`inviteForGoogle`): known, working now (410 with its reason), not a guest invite (403
  `guest_password_only`: guests join with a password), a free username, a free seat. The team link (`linkForGoogle`):
  the join's own checks and its per-link limit.
- **Rule (what travels):** what the person typed goes sealed in the flow with the PKCE verifier and the nonce
  (`google_signin_flows.secret_enc`, `begin`'s `extra`), never in a plain column. Never a token: the setup token only as
  its SHA-256, an invite or link only by its id. The flow's `next` holds the page to come back to (`/invite`, `/join`)
  or, for the setup, the page to open after it. No migration.
- **Rule (Google's return):** the same write as the password forms, with the same checks inside it:
  - setup: `bootstrapOwner` (only while no user exists), and only while the setup token is still the one the start had;
    the owner's username from the Google address before @ (a `+tag` dropped, the Username rule, made unique,
    `usernameFromEmail`), the name from Google's `name` (else the username), the e-mail from Google; then the welcome
    steps with the website and a signed-in session, as `POST /api/setup`;
  - invite: `joinWithInvite` (also `acceptInvite`'s), team link: `joinWithLink` (also `joinTeamLink`'s): a free
    username, the invite or link still works and its maker could still make it, a free seat, used once (the link's
    uses), the groups as they are now; the e-mail from Google. What follows a join (the personal folder, the welcome
    card, project joins, template offers, the lead invite's notice, the owners' notice, the everyone room) runs after
    the commit, as before.
  - The account has `password_hash` NULL and its `login_identities` row, connected and used now.
  - A Google account already connected to someone here signs that person in instead (`signInWith`, with its refusals:
    turned off, a temporary password). It is read inside the same write before anything is used, so nothing is made,
    used up or changed (an admin invite opened by a member does not make them an admin), and two tabs with one Google
    account meet there.
  - Refusals come back to the page with `?google=<result>`: `username_taken` (the page keeps what was typed and the
    invite or link token in the tab, so the person picks another and tries again), `gone`, `full`, `cancelled`,
    `expired`, `failed`. The invite page comes back through `/invite`, which reopens the invite this tab started from.
- **Rule (a password is optional):** a password sign-in of an account without one answers exactly like a wrong
  password (`verifyPassword` with no hash checks a dummy hash and says no; the same 401, counted the same).
- **Rule (limits):** a sign-up start does not count on the per-address Google start limit, so an office joining from
  one address is not stopped at 30. An invite's or link's starts count on its own limit (`linkKey`, as the team link's
  joins), given back when the account was made or the person already had one; refusals keep their count. The open-flow
  cap holds for all.
- **Audit:** `setup`, `invite.accept` and `team_link.join` say `method: 'google'`; never the Google address, a code, a
  token, the id_token or the nonce.
- **Why:** nobody should have to be moved from passwords to Google after launch, and the person who just proved who
  they are with Google at the console should not make a second secret for the team server.
- **Left out:** guests with Google; joining without an invite by `@company.com`; "Google only" teams; sign-up inside the
  desktop and phone apps (their join pages keep the password form; the person opens the link in a browser).
- **Tests:** `tests/unit/a-google-signup.test.ts` (setup token rules and the relay, only while no user exists, the token
  spent, no password; invite and team link joins, single use, seats, the maker, the link's uses and limit, a taken
  username, an already connected Google account, guest invites refused, the per-address start limit; a password-less
  account's password sign-in), `web/test/e2e/google-signup.spec.ts`.
- **Version impact:** minor (new endpoints and a new way to make an account; no migration).
