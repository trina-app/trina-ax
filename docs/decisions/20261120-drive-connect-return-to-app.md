# A Drive sign-in from the desktop app finishes in the system browser it opened

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (narrows "the system browser must be signed in" of [Connectors that take only an app on the computer](../DECISIONS.md#connectors-that-take-only-an-app-on-the-computer-sign-in-from-the-desktop-app-featconnector-desktop-loopback-signin-2026-11-15) for Google Drive)
- Branch: fix/drive-connect-return-to-app (the owner's QA on diontest, 2026-11-20)

Where: `server/src/integrations/google-drive/{app-browser,oauth,callback-page}.ts`, `server/src/routes/drive.ts`,
`shared/src/api/drive.ts` (`openPath`), `web/src/lib/driveSignIn.ts`, `web/src/components/{settings/DriveConnection,integrations/DriveShares}.tsx`,
`desktop/src/common/address.ts` (`isShownTeamStart`), `desktop/src/main/app-window.ts`.

The owner connected Google Drive from the welcome steps' Tools step in the desktop app on a hosted team. Google's
answer reached the team server in the system browser, which has no session of the app, so the return refused it
(`browser_session_required`), showed "This browser is not signed in to Trina AX" and the app kept "Waiting for
Google…" until its 5-minute limit. The app never noticed, because nothing had happened. Decided:
- **The browser the app opened is proof enough.** A desktop session's start answers with `openPath`, a one-time
  address on this server (a 32-byte ticket, only its hash kept, in memory). The app opens it in the system browser
  instead of the sign-in page. It works once, within 2 minutes (`TICKET_MS`; the app opens it at once), only while the
  flow waits. It gives that browser a cookie (`mycel_drive_signin`, a new random value, hash kept; `Path` = the
  return path, HttpOnly, SameSite=Lax, 10 minutes) and sends it on to the flow's sign-in page. The return accepts that
  browser for that flow without a session. A browser signed in as the same person still works, as before.
- **What still holds:** the flow is still pending, its session is alive, PKCE, the hosting service's single-use
  handoff, and the person confirms the Google account in the app. A forwarded `openPath` is dead within 2 minutes and
  after its first use. Another flow's cookie, no cookie, or a different person's browser are refused as before. The
  remaining exposure is narrower than "no proof": someone would have to make the person open their own fresh address
  within 2 minutes. **Security review requested** before this goes to dev.
- **The last page goes back to the app, never to the web app.** When a flow was started in the desktop or phone app,
  the return page says "Connected. Go back to the Trina AX app and confirm the account there. You can close this
  tab." The desktop app also gets a Back to the app button (`trina-ax://open?url=<team>/`). The desktop app now only
  brings its window forward for a link to the start of the team it shows (`isShownTeamStart`), instead of asking on
  screen ④ to connect a team it already shows. An older desktop app still asks; "No" goes back.
- **Not signed in is no dead end.** "Sign in and connect here" (`/login?next=/settings/connectors/google-drive`), and
  for an app's flow, "go back to the app and press Try again". The page has its own small style (CSP by hash).
- **Not now:** the phone app (its browser hand-off accepts only Google's address, so it gets no `openPath`; it needs a
  phone release), Gmail, Calendar, Docs and Sheets (`google-apps`), and MCP connectors (Notion). They still need the
  system browser signed in, and are the next step with the same pattern. The hosting service's start page shows
  Google's warning as two marked pictures (trina-cloud).
- Tests: `tests/unit/c-drive-app-browser.test.ts`, `tests/unit/c-google-return-page.test.ts`. Version impact: patch
  (an optional answer field and a new public GET; older apps open the sign-in page as before).
