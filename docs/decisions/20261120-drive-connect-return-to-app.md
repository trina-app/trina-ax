# A Drive sign-in from the desktop app finishes in the app, with a one-time code from the browser

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (narrows "the system browser must be signed in" of [Connectors that take only an app on the computer](../DECISIONS.md#connectors-that-take-only-an-app-on-the-computer-sign-in-from-the-desktop-app-featconnector-desktop-loopback-signin-2026-11-15) for Google Drive)
- Branch: fix/drive-connect-return-to-app (the owner's QA on diontest, 2026-11-20; security review of #98)

Where: `server/src/integrations/google-drive/{app-return,oauth,store,callback-page}.ts`, `server/src/routes/drive.ts`,
`shared/src/api/drive.ts` (`openPath`, `claimDriveFlow`), `web/src/lib/driveSignIn.ts`,
`web/src/components/{settings/DriveConnection,integrations/DriveShares}.tsx`, `desktop/src/common/address.ts`
(`isShownTeamStart`, `signInCode`), `desktop/src/main/app-window.ts`.

- **Ask:** the owner connected Google Drive from the welcome steps' Tools step in the desktop app on a hosted team.
  Google's answer reached the team server in the system browser, which has no session of the app. The return refused it
  (`browser_session_required`), showed "This browser is not signed in to Trina AX", and the app kept "Waiting for
  Google…" until its 5-minute limit. The app noticed nothing because nothing had happened.
- **Rejected first design (security review, HIGH):** a one-time address that gave the system browser a cookie to finish
  the flow. Anyone can mint such addresses: any member, or a `client: 'desktop'` login made with curl. They could
  phish a victim and get the victim's Drive on the attacker's account. The cookie also overrode a browser signed in as
  someone else. A 2-minute single-use limit does not help (the attacker mints fresh addresses), nor does the account
  confirm (the attacker confirms). Removed entirely.
- **Rule:** the answer goes to the app on the computer that signed in (the idea of RFC 8252):
  - When Google's return comes in a browser **without a session**, for a flow a **desktop** session started, the server
    takes the hosting service's handoff (it lives 2 minutes) and keeps the result sealed in the flow. The flow stays
    `exchanging`, and no account is shown to anyone. The server makes a one-time completion code: 32 random bytes, only
    its hash kept in the sealed secret, valid for `CLAIM_MS` (5 minutes).
  - To its owner the flow reads plain `pending` until the code comes back (never `exchanging`).
  - The page names whose Trina account the Drive joins (name and @username) and which Google account. It adds "Open
    this link only in your own Trina AX app. Don't send it to anyone."
  - The page gives the code only in the "Back to the app" link's **fragment**:
    `trina-ax://open?url=<team>/#code=<code>`. It is never in a query string, so no server, proxy or log sees it.
  - The desktop app takes it only for the team it shows (`signInCode`) and posts it with **its own session**
    (`POST /api/integrations/google-drive/claim`). The code counts only for a flow of that same session. The flow
    turns `ready` and the person confirms the account as always. A code that is used, unknown, from another session's
    flow, or late is refused. A late code ends its flow.
  - A phished victim's browser hands the code to the victim's own computer. That app's session is not the attacker's,
    so nothing connects.
  - A browser signed in as **someone else** is refused, as before. A browser signed in as the **same person** finishes
    at once, as before.
  - **Before Google**, the desktop app opens a page of the team server (`GO_PATH`, with a random key whose hash is
    sealed in the flow). It names the Trina person the Drive will belong to ("Connecting Google Drive to the account
    of Olga (olga). If that is not you, close this window."), then links on to the hosting service's guide and
    Google. It grants nothing.
- **Why not a 127.0.0.1 listener:** the hosting service sends the browser only to the team's https address. From there
  a page cannot hand a fragment to http://127.0.0.1 (the listener never receives fragments), and a query would put the
  code in a query string. The app's own link carries it instead. One press on "Back to the app" (and the browser's
  "open the app?" prompt) is the cost.
- **Pages:**
  - After Google, an app's flow says to go back to the app, never to the web app. With a code: "Press the button to go
    back to the app and finish". Signed in as the same person: "Connected. Go back to the app".
  - The desktop app only brings its window forward for a link to the start of the team it shows.
  - A browser not signed in gets "Sign in and connect here", and an app's flow gets "go back to the app and press Try
    again".
  - The page has its own small style, with its CSP allowing only that style (by hash).
- **Not now:**
  - The phone app: its browser hand-off takes Google's address only, and the phone app does not read a code from a
    link yet. It needs a phone release; until then its page says to go back and try again.
  - Gmail, Calendar, Docs and Sheets (`google-apps`) and MCP connectors (Notion): next, with the same pattern.
- **Tokens never used are revoked at Google (best effort):** a held result whose code comes late, whose flow runs out,
  or that is cancelled; a ready result never confirmed that runs out, is cancelled or is replaced by a new sign-in. A
  failed revoke changes nothing on this server; the tokens are dropped either way.
- **Tests:** `tests/unit/c-drive-app-return.test.ts` covers:
  - attack (A), a curl desktop session plus a victim browser without a session, and attack (B), a victim browser signed
    in as the victim: both must not connect
  - code reuse, a late code, redemption by another session, and the code only in the fragment
  - the page before Google, and the web and phone flows
  
  Also `tests/unit/c-google-return-page.test.ts`, `e-desktop-common`, `server-app`, the security matrix
  (`claimDriveFlow`, `RAW GET GO_PATH`), and web `drive-sign-in` and `connect-card`. Version impact: patch (optional
  answer field, a new endpoint, a new public GET; older apps open the sign-in page as before).
