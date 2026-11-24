# Google sign-in: a takeover at an unlocked browser is closed

- Date: 2026-11-24
- Status: accepted
- Supersedes: parts of docs/decisions/20261122-google-reauth.md (what a Google check proves; the apps' deletion
  shortcut)
- Branch: fix/google-signin-security (security review of #400 before 0.18.0)

- **Ask:** the Google re-check (`prompt=select_account`) only proved that the person's Google account was signed in in
  that browser. Someone at an unlocked browser could pass it, replace a passwordless account's Google link with their
  own (`POST /api/me/google/connect`), or set a password they know (`POST /api/me/password`), and only the victim was
  told. ~17 addresses could also fill the server-wide cap of 500 open Google flows and lock passwordless people out.
- **Rule:**
  - An account without a password never changes its Google account itself: `startGoogleConnect` refuses (409
    `no_password`), and Google's return refuses again inside the write. An admin's temporary password (which also
    disconnects Google) is the way to another one.
  - A re-check flow asks Google for a new sign-in: `max_age=0` and the `auth_time` claim (`claims` parameter; Google
    sends it where the client has it on). Google's return confirms only an id_token issued within 60 s and, when
    `auth_time` comes, a Google sign-in within 5 minutes (`freshEnough`); otherwise the window says it was not
    confirmed and the audit says `not_fresh`. Every re-check endpoint gets this, since they all spend such a flow.
  - Every Google link change (connected, replaced, disconnected by the person or an admin, or dropped by an admin's
    reset) and every first password tells every active owner and admin in Activity (credential.change rows, actions
    `signin_*`: who did it and whose account, never the Google account). A first password tells the person too.
  - Disconnecting Google (the person or an admin) ends the person's other sessions (the person's own stays).
  - The 500 cap counts only flows without a signed-in person (a connect or re-check is one per person and never
    blocked); open sign-in flows are also capped at 10 per address (migration 134, `ip_hash`).
  - Asking for one's own deletion without a password always needs the Google re-check; the "signed in within 10
    minutes" shortcut of the apps is gone (a new Google sign-in at an unlocked browser takes no password). The apps
    say to ask in a web browser.
- **Why:** each step alone leaves a gap where Google ignores `max_age` and the client has no `auth_time`: the
  connect rule and the staff notices then still stop or show a takeover.
- **Left out:** `prompt=login` (Google refuses it).
- **Tests:** tests/unit/a-google-reauth.test.ts (the attack paths, freshness, notices, sessions, the flood).
- **Version impact:** patch.
