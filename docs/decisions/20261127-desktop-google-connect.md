# The desktop app's page may say "desktop" when it starts a Google sign-in

- Date: 2026-11-27
- Status: accepted
- Supersedes: none
- Branch: fix/desktop-google-connect (QA on qa.trina.app: desktop Connect kept loading, the browser said "not signed in")

- **Ask:** Google Connect in the desktop app kept loading forever, while it worked in a browser.
- **Cause:** the desktop hand-off (`server/src/integrations/google-drive/app-return.ts`) holds a return without a
  session for the app's one-time code only when the flow's session is recorded as `desktop`. A desktop app's session
  can be recorded as `web`, for example one made by creating the team in the desktop app (`setup` always signed in as
  `web`). Such a return was refused ("This browser is not signed in"), and the app was never told.
- **Rule:** the start of a Google Drive, Drive share or Google app sign-in (personal or team) takes an optional
  `client: 'desktop'`. The desktop app's page sends it (`web/src/lib/driveSignIn.ts` `googleStartBody`). The flow keeps
  it sealed in its secret. A return without a session is held for the app's code when the session is `desktop` or the
  flow says `desktop`. `setup` signs in with the client the page names (default `web`).
- **Why it is safe:** the field only changes how a return **without** a session ends. The result is held. The one-time
  code goes only to the app on the computer whose browser it is, in the app link's fragment. Only the session that
  started the flow can redeem it. A browser signed in as someone else is refused as before. Any member could already
  get the same result with a `client: 'desktop'` login made with curl (the case #98's review tested), so the field
  adds no new power. `tests/unit/c-google-connect-finish.test.ts` repeats that phishing case for a browser session
  that says `desktop`.
- **Left out:** MCP and API connectors (`server/src/integrations/connections/service.ts`) also decide by the session's
  kind. They can take the same field later. Their loopback port stays limited to desktop sessions. Sessions already
  recorded as `web` are not rewritten.
- **Tests:** `tests/unit/c-google-connect-finish.test.ts` (the repro for Gmail and Drive, the phishing case, setup's
  session kind), `web/test/unit/drive-sign-in.test.ts`.
- **Version impact:** patch (a bug fix; the field is optional).
