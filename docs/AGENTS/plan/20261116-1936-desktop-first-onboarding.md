# After making the team in a computer's browser, continue in the desktop app without a second sign-in

- Date (UTC): 2026-11-16 19:36
- Branch: `feat/desktop-first-onboarding`
- Status: done
- Where: `server/src/auth/` (one-time app sign-in code), `shared/src/api/auth.ts`, `shared/src/team-link.ts` (+ its
  phone copy), `desktop/src/common/address.ts`, `desktop/src/main/app-window.ts`, `web/src/pages/OpenApp.tsx`,
  `web/src/lib/open-app.ts`, the files step and My files, `editions/trina/branding/apps.json`. Why: sign-in and sessions
  are component A's, the link reading is shared by the desktop and phone apps, the screens are the web's (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor (a new screen, two new endpoints and a migration; nothing removed)

## Goal

"Find work files on this computer" only works in the desktop app, and nothing tells a new owner that the app exists.
Right after the owner makes the team on the web `/setup` page in a Mac or Windows browser, one screen offers to
continue in the app. The button opens the app on this team already signed in (no second password). Without the app the
screen says how to get it and to press the button again (the way Zoom does it). People who stay in the browser see one
quiet line in the welcome "Team files" step and in My files.

## Scope

In:
- Web `/open-app`: one title, one line why, one primary button ("Continue in the Mac app" / "… Windows app"), one quiet
  "Continue in the browser". After a press: a fresh code, `trina-ax://open?url=<team>/app-signin#c=<code>`, and one quiet
  line with the download page and "If the app opened, you can close this tab." Shown after setup only in a Mac or
  Windows browser, never inside our apps, on phones or Linux.
- Server: `app_signin_codes` (migration 128_a), `POST /api/auth/app-signin` (mint: cookie session only, rate-limited per
  person, one live code per person, 3 minutes) and `POST /api/auth/app-signin/redeem` (token guard per IP, atomic spend,
  the existing `signIn`, cookie only). Codes go with password changes, resets, disabling, deleting and sign-out of all
  sessions; the sweeper removes old rows.
- Web `/app-signin` (signed in and out): takes `#c=` out of the address first; outside the desktop app it only says the
  link opens in the app; inside it redeems and says "Signed in to {team} as {name}" with Continue and "This isn't me".
  A Mac App Store build gets one line about the download version. An expired code says so, with a way to sign in.
- Desktop/shared: `readDesktopLink` (only) accepts `https://<team>/app-signin#c=<43 characters>`; the box and the phone
  refuse it; screen ④ stays as it is; `/app-signin` is a sign-in path (the address shows).
- One shared line in the files step and My files: "Finding work files on this computer works in the Mac and Windows
  app. Open the app" → `/open-app`.
- Settings › Apps: the Mac row leads to the download page (the signed DMG), not the Mac App Store; the team server's
  own unsigned installer only when the edition has no download page.

Out: detecting whether the app is installed (Linear's way breaks); the console checklist wording (another repo); a
"was it used?" check from the browser tab (dropped after review).

## Steps

1. Plan (this file).
2. Server: migration, mint/redeem in `server/src/auth/app-signin.ts`, contracts, voiding hooks, sweeper, unit tests.
3. Shared/desktop: the `appSignIn` option, `readDesktopLink`, `answerLink` keeps the entry path, `isSignInPath`, tests.
4. Web: `lib/open-app.ts` (pure rules + tests), `/open-app`, `/app-signin`, the one-liner, Setup's target, i18n (en,
   ko, ja, zh, es, id).
5. Edition apps: `apps.json` mac → "", regenerate, `lib/apps.ts` prefers the download page; tests.
6. Decision file, changelog fragment, e2e spec with screenshots at 1440/390, light/dark.

## Decisions

`docs/decisions/20261116-desktop-first-onboarding.md`: the one-time app sign-in code and its residual risks.

## Risks

- Migration: 128_a (highest A on dev is 127). Additive, reader level 1.
- Security: a code is a sign-in. 32 random bytes, hash only, 3 minutes, one use, one live per person, POST only, only in
  a fragment, CSRF-checked, rate-limited. Another local app could claim the scheme; on Windows the link is on the
  command line; a login-CSRF into someone else's team is answered by screen ④ and "Signed in to {team} as {name}".
- Languages: six (en first).
- Phones: the screen never shows there; the link reading refuses the code on the phone.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests for auth, team-link, desktop common, web
lib; a targeted web e2e spec with screenshots.

## Result

Built as planned on `feat/desktop-first-onboarding` (not pushed; no PR yet). Endpoints `POST /api/auth/app-signin` and
`POST /api/auth/app-signin/redeem`, migration `128_a_app_signin_codes.sql`, pages `/open-app` and `/app-signin`
(web/src/pages/OpenApp.tsx), the shared line (web/src/components/onboarding/OpenAppLine.tsx), the desktop link reading
(`appSignIn` option, `readDesktopLink`, `retypablePath`), Settings › Apps' Mac row, six languages, decision
docs/decisions/20261116-desktop-first-onboarding.md, changelog changes/desktop-first-onboarding.md.

Differences from the plan:
- The screen also shows on plain http to this machine (development and the e2e mock); the app refuses such links,
  which only matters for development.
- From the files line, "Continue in the browser" goes back to where the line was (after setup it goes to the welcome
  steps).
- The code is spent with `UPDATE … RETURNING user_id` (one row or none) instead of reading `changes`.
- The office Mac's owner hint in Settings › Apps now says Macs get the app "from the link above" (it said the App Store).
