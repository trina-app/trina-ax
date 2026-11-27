# A desktop sign-in's code goes back to the app over 127.0.0.1, not only through the app link

- Date: 2026-11-27
- Status: accepted
- Supersedes: the "Not the loopback listener of RFC 8252 7.3" note in `server/src/integrations/google-drive/app-return.ts`
  (decided with the security review of trina-ax #98)
- Branch: fix/google-connect-desktop-wait (the owner: "구글 드라이브 연결 … 계속 로딩중임 안끝나", 0.20.0)

- **Ask:** Google Drive from the desktop app never finished for the owner: Google's consent ended in the browser, the
  app kept "Waiting for Google…" until its 5-minute limit. It had "always" been so on his Mac.
- **Cause:** the owner's default browser is ego lite, signed in to Google but not to the team. A desktop sign-in that
  Google answers in a browser without a session is held for the app; its page handed the one-time code ONLY through the
  app link `trina-ax://open?url=<team>/#code=…`. ego lite opens no apps (ERR_UNKNOWN_URL_SCHEME, also on a click): the
  meta refresh replaced the page by an error page and the code never reached the app. Reproduced on qa.trina.app with
  his ego lite and a 0.20.1 app. Any browser that does not open the app (a blocked prompt, an in-app browser, a copy of
  the app the system does not open) ends the same way.
- **Rule:** the desktop app keeps one return address on `127.0.0.1` (a port the system picks, open while the app runs;
  `desktop/src/common/code-return.ts`). Its team page sends the port with every API call (`x-mycel-app-return`); the
  server keeps it in memory for that DESKTOP session only. Every held page (Google Drive, the Google apps, app
  connections, Slack) sends the browser to `http://127.0.0.1:<port>/sign-in-code?code=<code>` (meta refresh and
  button) when the session said a port, else the app link as before. The app hands the code to the claim address with
  its own session (the same claim as the app link) and brings its window forward for the account's confirm.
- **Why safe:** nothing about who may finish changes. The code is one-time, lives 5 minutes and is redeemed only by the
  session that started the sign-in. The port is the starter's own app's: a phished victim's browser goes to the victim's
  own computer, where the victim's app (another session) gets a refusal. A program on the computer that finds the port
  can hand on only codes it already has, as it could with the app link. The code is in a query only on the way to this
  computer (RFC 8252 7.3); the address answers only `GET /sign-in-code?code=<token>` from its own Host as a page load,
  hands each code on once, at most 20 a minute.
- **Left out:** an app from before this change keeps the app link (no port known); a server restart forgets the ports
  until the app's next call (within seconds while a sign-in waits).
- **Tests:** `tests/unit/c-sign-in-code-loopback.test.ts` (REPRO: the held page goes to the app's address, the app
  redeems, the person confirms; old app keeps the app link; only desktop sessions; the listener's rules).
- **Version impact:** patch (a fix; one optional request header, no API shape or migration).
