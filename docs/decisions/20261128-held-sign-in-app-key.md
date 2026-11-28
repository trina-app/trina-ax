# A held sign-in code is redeemed only with the desktop app's own proof; the desktop wait offers "Copy link"

- Date: 2026-11-28
- Status: accepted
- Supersedes: the "Why safe" of `docs/decisions/20261127-desktop-sign-in-code-loopback.md` (the starter's session
  alone redeemed a held code) and the flag rule of `docs/decisions/20261127-desktop-google-connect.md` (the page's
  `client: 'desktop'` alone made a return held)
- Branch: feat/connect-copy-link (the owner: Connect in the desktop app always opens the default browser)

- **Ask:** Connect in the desktop app opens the system's default browser; the owner signs in to Google in another
  browser or profile. Like Claude Code ("Browser didn't open? Use the URL below to sign in"), the wait offers the same
  address to copy. A copied address can be pasted somewhere else, so it must not let anyone else finish the connection
  into this person's account. The review of #695 also flagged that any session could say `client: 'desktop'` and get
  its returns held.
- **Rule:** the desktop app keeps a random secret for each run (never written anywhere) and derives one proof per team
  (HMAC of the team's origin, `desktop/src/common/code-return.ts`). The team page sends the proof's sha256 with every
  API call (`x-mycel-app-return-key`, like the port), and the server keeps it in memory for that session. A result held
  for the app's code (Google Drive, the Google apps, app connections, Slack) seals the key of the starter's session;
  its claim must carry the proof (`x-mycel-app-return-proof`), which only the app's main process sends, on the claim to
  the team on screen (`AppWindow.claimSignIn`). A missing or wrong proof is the same refusal as an unknown code. A start
  that only says `client: 'desktop'` (a session recorded as a browser's) is held only when that session said a key.
  The desktop wait shows "Copy link" (`web/src/components/integrations/CopySignInLink.tsx`) with the address Connect
  opened.
- **Why safe:** the copied address carries nothing that finishes anything: no code, no proof. Whoever opens it gets at
  most a held result that only this app can redeem, and the person then sees that account and confirms or cancels (as
  before). The page's own script, an artifact or a frame with the session cannot redeem a held code either: it never
  has the proof. Headers, not body fields: a server from before keeps its strict claim body and ignores them; a new
  server holds nothing more for an app from before (no key: as before, desktop sessions only).
- **Left out:** requiring a key for every held result (apps before this change send none): once every app sends it.
  An app restarted between the return and the claim has a new secret: the held code is refused, Connect again. The
  web has no "Copy link": another browser has no session of the team and the web flow refuses it.
- **Tests:** `tests/unit/c-held-sign-in-app-key.test.ts` (Drive and an app connection: no proof, a wrong one, another
  team's, the right one; the word without a key is not held; an app from before), `c-google-connect-finish.test.ts`
  (Gmail), `c-slack.test.ts` (Slack), `c-sign-in-code-loopback.test.ts` (the app's 127.0.0.1 return with its proof),
  `web/test/e2e/connect-copy-link.spec.ts` (desktop only; copies the opened address).
- **Version impact:** patch (a small addition to an existing wait and a tighter claim; optional headers, no API shape
  change, no migration).
