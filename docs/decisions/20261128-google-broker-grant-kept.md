# The hosting service's Google grant is never revoked from a team server; a browser sign-in finishes in its return tab

- Date: 2026-11-28
- Status: accepted
- Supersedes: for the hosting service's shared Google app only, the "revoke when it was the last Google sign-in here"
  rule of [docs/GOOGLE-APPS.md "Disconnecting"](../GOOGLE-APPS.md#disconnecting) and Google Drive's Disconnect; for a
  browser's personal sign-in, the separate account confirm of [docs/GOOGLE-DRIVE.md](../GOOGLE-DRIVE.md)
- Branch: fix/google-broker-disconnect-no-revoke (Windows QA 2026-11-28, a self-installed 0.20.4 server signing in
  through account.trina.app)

Where: `server/src/integrations/google-drive/{oauth,broker,share-admin,callback-page}.ts`,
`server/src/integrations/google-apps/service.ts`, `server/src/routes/{drive,google-apps}.ts`, `shared/src/api/drive.ts`
(`Revocation`), `web/src/components/{settings/DriveConnection,integrations/DriveConnector,integrations/GoogleAppConnector}.tsx`.
trina-cloud: `src/drive-broker/broker.ts` (`/revoke`).

## 1. Disconnect forgets the token; it never ends the grant at Google

- **Ask:** disconnecting Google connectors on one server removed the person's whole "Trina AX" entry in their Google
  account (third-party connections), and their Drive on another Trina server stopped too.
- **Cause:** Google's `/revoke` on any refresh or access token ends the person's whole grant for that OAuth client.
  The hosting service's Google app is one client for every hosted team and every registered self-installed server.
  The rule "revoke only when it was the person's last Google sign-in here" only sees this server.
- **Rule:** a token the hosting service sealed (broker mode, the `ev1.` envelope) is never revoked from a team server:
  Disconnect (Drive and the four apps), Stop sharing, a share whose admin left, the team account's removal, handover,
  and sign-in results that are never used. The server deletes its copy at once, as before. The answer's `revocation` is
  `kept`. The team server's broker client has no revoke call any more.
- **The way to remove it everywhere** is Google's own page: after a `kept` disconnect, Drive's page and the Google apps'
  notice say the other Trina servers keep working and link to https://myaccount.google.com/connections ("Remove
  Trina's access at Google"). Removing it there ends every Trina server's sign-in with that account, which is then the
  person's own explicit choice.
- **Servers already installed** (0.20.4 and older) still call the hosting service's `/revoke`. The hosting service now
  answers `revoked` without calling Google: the token's copy on that server is deleted, which is all `revoked` ever
  promised there, and an older page shows no "also remove it at Google" line that would end the other servers' grant.
- **Unchanged:** the company's own Google app (direct mode). That client belongs to the team, so the old rule stays:
  revoke when it was the person's last Google sign-in here (owner decision 9 of docs/GOOGLE-APPS.md).
- **Trade-off:** a token this server forgot still works at Google until the person removes the grant there or it goes
  unused for six months. Nobody can use it: the copy is gone, and only this server's key could ask the hosting service
  to refresh it.

## 2. A browser sign-in connects in the tab Google came back to

- **Ask:** after Google, the return tab said "Almost done. Go back to the Trina AX app and confirm the account". In a
  browser there is no app, and the person had to find the first tab and press "Connect this account".
- **Why the extra step was there:** the first tab polls the flow and closes the sign-in window once it is ready. Google's
  pages set Cross-Origin-Opener-Policy, which cuts the window's link to the first tab, so that close never works and
  the return tab stays in front. The confirm itself is not a security step: the result is bound by the state, PKCE and
  the same signed-in browser, and an attacker would confirm too
  ([20261120-drive-connect-return-to-app.md](20261120-drive-connect-return-to-app.md)).
- **Rule:** when Google's return comes in a browser that holds **the very session that started** a personal sign-in
  (the person's own Drive or Gmail, Calendar, Docs, Sheets), the return page connects it at once and says "Connected.
  You can close this tab and go back to the first one." The first tab's poll sees `completed`. Another session of the
  same person, a browser without a session, or someone else: as before.
- **The confirm stays** where it is a choice or the app finishes it: a Drive share (an admin names it), an app's team
  account, a result held for the desktop app's code, and the phone app. Their browser page now says "go back to the
  first tab and press Connect this account"; the word "app" stays only for a sign-in started in an app.
- **Tests:** `tests/unit/c-google-connect-finish.test.ts`, `c-google-return-page.test.ts`, `c-drive-broker.test.ts`,
  `c-drive-oauth.test.ts`, `c-google-apps-signin.test.ts`, `c-drive-app-return.test.ts`; trina-cloud
  `tests/drive-broker.test.ts`.
- **Version impact:** patch (bug fixes; `kept` is a new value of four disconnect answers, read by this server's own web
  app).
