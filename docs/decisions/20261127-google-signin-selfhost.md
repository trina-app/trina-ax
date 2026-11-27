# Self-installed servers sign in with Google through the hosting service's sign-in broker; an optional domain list reads `hd`

- Date: 2026-11-27
- Status: accepted
- Supersedes: the line "A self-installed server never uses it in this version" of the hosted sign-in broker
  ([20261122-google-login-client.md](20261122-google-login-client.md) part B); the Google row of Admin › Team settings
  ([20261127-google-signin-hosted-ux.md](20261127-google-signin-hosted-ux.md))
- Branch: feat/google-signin-selfhost (the owner's Google sign-in plan for self-installed servers, part AX2; owner
  decisions 2026-11-27)

- **Ask:** An admin of a self-installed server who only wants "Sign in with Google" had to make a Google Cloud project
  and client and paste it under Google Drive (about 10 steps on 10 Google pages). Once Drive went through the hosting
  service, sign-in would have vanished, because the sign-in broker served hosted teams only.
- **Rule:**
  - A self-installed server (selfhost or office, not dev) with a public address and `MYCEL_GOOGLE_DRIVE_BROKER_URL` left
    out uses the edition's console for Sign in with Google, as Drive does (`selfInstalledDefault`). An operator's
    variable counts on any server; a hosted server never registers. A server's own Google client always wins.
  - Registration does not depend on Drive: while the console answers `not_hosted`, the sign-in broker registers the
    server's own address with Drive's signed `register` (`{ v: 1, origin }`, unchanged; one registration serves both
    brokers), backing off 1, 2, 4, 8, 16, then 30 minutes. The key route `GOOGLE_BROKER_KEY_PATH` answers while either
    broker registers itself.
  - The console serves a self-registered server for sign-in only under its own flag `CP_GOOGLE_SIGNIN_SELF`, separate
    from Drive's (trina-cloud, `docs/google-signin.md` §5), and sends the browser only to the origin it proved. The team
    server still checks Google's RS256 signature, the audience and its own nonce.
  - Passwordless Google accounts are allowed there (owner). When the console can't be reached and someone has no
    password, the button stays and a click says "Google sign-in can't be reached right now. Try again in a few minutes,
    or ask your admin for a temporary password."
  - Admin › Sign-in methods replaces the Team settings row: Password (no switch); Google with the switch, one status
    line (own app / the hosting service / needs a public web address / not served yet / can't be reached), the domain
    list and "Try it".
  - Domain list (`TeamSettings.googleSignInDomains`, empty by default): when set, Google's `hd` claim must be on it,
    lower-cased; never the e-mail suffix (a personal Google account can carry bob@acme.com, verified, with no `hd`).
    Sign-in, connect and sign-up (setup, invite, team link) alike; a re-check only confirms the account already
    connected and is not refused by it. A sign-in refused so is audited `google_domain`, without the address.
  - "Try it" is a connect flow of the admin's session whose `next` is `/admin/sign-in` (migration 131's CHECK allows no
    new intent): its return says which Google account answered and whether the list lets it in, and signs nobody in.
    The team switch does not stop it.
- **Why:** the same proof and trust boundaries as Drive's self-registration, with identity scopes only (no verification,
  no 100-user cap); a domain list can only let fewer people in.
- **Left out:** "Require Google" (later, owner); a per-server switch and the privacy wording live in trina-cloud.
- **Tests:** tests/unit/a-google-login-broker.test.ts (self mode, registration and back-off, the key route without
  Drive, no public address, the outage, hosted-only rules), a-google-login.test.ts (`hd` on connect and sign-in, the
  setting, Try it), a-google-signup.test.ts (`hd` on a join), web/test/e2e/sign-in-methods.spec.ts.
- **Version impact:** minor (a new admin page, a team setting and an admin endpoint; nothing removed from the API).
