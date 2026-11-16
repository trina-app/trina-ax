# After setup in a computer's browser, a one-time code signs the desktop app in

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/desktop-first-onboarding (plan: docs/AGENTS/plan/20261116-1936-desktop-first-onboarding.md)

- **Ask:** "Find work files on this computer" works only in the desktop app, and nothing tells a new owner that the app
  exists. Right after the owner makes the first account on the web `/setup` page, steer them into the Mac or Windows app,
  with no second password.
- **Rule:**
  - After setup in a Mac or Windows browser (not inside our apps, not a phone, not Linux; on https or this machine),
    the owner goes to `/open-app`: one title, one line why, one button "Continue in the Mac app" (or Windows), one quiet
    "Continue in the browser" (the welcome steps as before). The page never tries to find out whether the app is
    installed. After a press it says, the same whatever happened: "Didn't open? Install the app, then press the button
    again" with the download page, and "If the app opened, you can close this tab." Each press makes a new code.
  - The button asks the team server for a one-time code (`POST /api/auth/app-signin`) and opens
    `<scheme>://open?url=https://<team>/app-signin#c=<code>`. The desktop app asks first on its screen ④ ("Connect to
    {host}?", the 600 ms gate unchanged); yes opens `/app-signin` in the app, which takes the code out of the address,
    spends it (`POST /api/auth/app-signin/redeem`) and says "Signed in to {team} as {name}" with Continue and a quiet
    "This isn't me" (signs out). A Mac App Store build adds one line: it cannot find files; get the download version.
  - The code: 32 random bytes (43 characters), only its SHA-256 stored (`app_signin_codes`, migration 128_a), 3 minutes,
    spent once by one UPDATE that checks unused and unexpired, the account checked again (active, not deleted), then
    the existing `AuthService.signIn` with a cookie. Made only by a cookie session (a bearer token is refused), 10 per
    person per 15 minutes; one live code per person (a new one voids the one before). The code belongs to the browser
    sign-in that made it (`session_id`, deleted with it): signed out there, signed out from another device or expired,
    the code is gone. A redeem from an app (or browser) that is signed in as someone else is refused with 409 and the
    code stays unspent: a code never replaces another person's sign-in (security review 2026-11-17: a member's code sent
    to the owner's signed-in app would otherwise have turned it into the member's). The session it makes is always a
    desktop one. A password change or reset, an
    admin's temporary password, a disabled or deleted account and a sign-out void the person's codes. Spending counts
    failures per client IP like invite links. POST only, CSRF-checked like every cookie POST. The audit has
    `auth.app_signin_code` and `auth.app_signin` with the IP, never the code. The sweeper removes spent and expired rows;
    a restored backup has none.
  - The link reader accepts `/app-signin#c=<43 characters>` only in a link that opened the desktop app from outside
    (`readDesktopLink`), with no query and nothing else in the fragment. The first-run box and the phone (scheme and
    universal links) refuse it. `/app-signin` counts as a sign-in page (the app shows the team address), an update
    restart never reopens it, and a failed page load is logged without its fragment.
  - In a Mac or Windows browser the welcome files step and My files show one quiet line, "Finding work files on this
    computer works in the Mac and Windows app. Open the app" → `/open-app`. Never to guests.
  - Settings › Apps: the Mac row leads to the download page (the signed, notarized dmg), not the Mac App Store, and with
    a download page it never offers the team server's own unsigned installer (owner 2026-11-15: Mac App Store updates
    stopped; the website offers only the dmg).
- **Why a code and not a second password:** the owner asked for no second sign-in. A reviewer proposed asking for the
  password again in the app; that was declined, and the review's other points were taken (one live code, the account
  shown after sign-in, the fragment dropped first, POST only, no "was it used?" polling from the browser).
- **Risks we accept (each bounded by 3 minutes and one use):**
  - Another program on the same computer can register `trina-ax://` and receive the link. A web page cannot register a
    scheme; a program that can is already able to read the browser's cookies. Slack, Zoom and Figma accept the same.
  - On Windows the link reaches the app on its command line, which other programs of the same user can read while it
    runs.
  - Login CSRF into an app that is signed out (or a team it does not know yet): an attacker could send someone a link
    with a code of their own account. An app signed in as someone else refuses it (above). Screen ④ names the host
    before anything loads, the page then says "Signed in to {team} as {name}", and "This isn't me" signs out.
  - On a development server over plain http on this machine the screen shows, but the app refuses links to this
    machine; that is only for development and the tests.
- **Left out:** detecting the installed app (Linear's local port check breaks when the browser blocks it), a check from
  the browser tab whether the code was used, the console checklist's wording (another repository).
- **Tests:** tests/unit/a-app-signin.test.ts, tests/unit/team-link.test.ts, tests/unit/e-desktop-common.test.ts,
  web/test/unit/open-app.test.ts, web/test/unit/apps.test.ts, web/test/e2e/open-app.spec.ts.
- **Version impact:** minor (a new screen, two endpoints, a migration; nothing removed).
