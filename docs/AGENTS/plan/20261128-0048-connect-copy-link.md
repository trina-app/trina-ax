# Desktop connect: "Copy link" on the wait, and a held sign-in code bound to the app

- Date (UTC): 2026-11-28 00:48
- Branch: `feat/connect-copy-link`
- Status: done
- Where: web (wait lines), desktop (return secret), server (held sign-in claim). Why: a Connect in the desktop app
  always opens the default browser; the owner wants to finish it in another browser or profile (docs/REPOSITORY-RULES.md)
- Version impact: patch (a small addition to an existing wait and a tighter claim; optional headers only, no API shape
  change, no migration)

## Goal

Pressing Connect in the desktop app opens the system's default browser. Someone who signs in to Google (or Slack, or
another service) in another browser or profile has no way to get there. Claude Code shows its sign-in address to copy
when its browser does not fit; we do the same: one small "Copy link" beside the wait. The copied link must not let
anyone else finish the connection into this person's account.

## Scope

In:
- Desktop app only: a "Copy link" text button on every wait that opened the system browser (Google Drive, Drive
  shares, Gmail/Calendar/Docs/Sheets personal and team, app connections in Connectors / chat card / welcome steps,
  Slack sign-in and Add to Slack). It copies the same address Connect opened. Connect keeps opening the default
  browser.
- The held code (a return in a browser without the app's session, app-return.ts) is redeemable only by the app that
  started it: the app keeps a random secret with its 127.0.0.1 return address (per team), the page sends its sha256
  with every API call (like the port), the server seals that hash into the held result, and the claim must carry the
  secret (header, from the main process only; the page never sees it).
- A start that only SAYS `client: 'desktop'` (#698) is held only with an app key sealed at the start: a browser's page
  (no app) no longer gets held results by saying so; a hand-made client still can, as with a curl `desktop` login.

Out:
- The web app: Connect opens a tab of the same browser; a copied link in another browser has no session there and the
  web flow refuses it ("not signed in"). Nothing to add.
- Requiring the key for sessions recorded as desktop (desktop apps before this change send none): later, once every
  app sends it.

## UX spec (reviewed before building; owner 2026-11-28 "UX 검수하고 만들어줘")

References looked at: Claude Code (its own sign-in: "Opening browser to sign in…", then "Browser didn't open? Use the URL
below to sign in" with the address to copy), VS Code (the "open the external website?" dialog: Open / Copy; GitHub
sign-in "Having trouble logging in? … try a different way?"), GitHub CLI (copy a one-time code, open any browser). Slack,
Notion, Linear and GitHub Desktop show no copy option in their docs or source (unverified beyond that); Figma users ask
for one because its login opens only the default browser. Common pattern: the address is offered as a fallback beside
the wait, not as a second button; after Copy the app keeps waiting by itself.

Our wait today (screenshots 1440/390, light/dark, ko/en): spinner + "Google을 기다리는 중…" + a three-sentence hint, and
다시 시도 / 취소 on the right. In a browser the wait looks the same without the app's sentence.

- **Where:** desktop app only, on every wait that opened the system browser. One quiet text link at the end of the
  wait's small grey words (the hint), in the accent text style of the wait's existing links; on a phone a 44 px tall
  target. Not among 다시 시도 / 취소, no new line, no card, no icon-only control.
- **Words:** ko `링크 복사` / en `Copy link`. After a copy it reads, until the wait ends: ko
  `복사했어요. 다른 브라우저에 붙여 넣으세요.` / en `Copied. Paste it into another browser.` A copy the browser refuses
  changes nothing (the page's copy already falls back to the old copy command).
- **What it copies:** exactly the address Connect opened (Drive: this team's page that names whose Drive it is, then
  Google; the others: the service's sign-in page). Connect still opens the default browser. 다시 시도 makes a new link
  and the link reads `링크 복사` again; 취소 and the 5-minute limit end the wait (a link pasted later ends on the
  existing "expired or already used / cancelled … press Connect again" page, nothing new).
- **Web:** none (see Out).

UX review (fresh reviewer, cuts first), applied: no failure toast; no 2-second flash, one copied state that stays; no
second line of instructions, the copied label says what to do; the link sits inline at the end of the hint instead of
its own line; the security and "nothing new" paragraphs moved out of the spec. Not applied: rewriting the existing
Google hint (its 5-minute and work-account sentences came from QA TC-2132 / TC-1417; out of scope here).

## Steps

1. shared: header names (`x-mycel-app-return-key` hash on page calls, `x-mycel-app-return-proof` secret on the claim).
2. desktop: CodeReturn keeps a secret per run, per team (HMAC of the team origin); bridge `codeReturn.key()`; the claim
   sends the proof header.
3. server: noteAppReturn keeps port and key; the four held places (Drive, Google apps, connections, Slack) seal the
   key; their claims require the proof when a key is sealed; Drive/Google apps flag-only holds need a key.
4. web: api.ts sends the key; a `CopySignInLink` text button in BrowserWait, SignInPanel, ConnectCard, ToolsStep,
   DriveFlowPanel; the flows keep the address they opened.
5. Tests (fail without the fix), docs (decision, CONNECTIONS.md, GOOGLE-DRIVE.md), changes file, i18n in all
   languages.

## Decisions

- `docs/decisions/20261128-held-sign-in-app-key.md` (new). Changes the "Why safe" of
  `docs/decisions/20261127-desktop-sign-in-code-loopback.md` and `docs/decisions/20261127-desktop-google-connect.md`.

## Risks

- A new app on an old server: the old claim schema is strict, so the secret goes in a header (ignored there).
- An old app on a new server: no key, held as before for desktop sessions; flag-only starts are not held (as in 0.20.2:
  #698 is not released).
- An app restart between the return and the claim: a new secret, the held code is refused; Connect again.

## Tests

- `tests/unit/c-sign-in-code-loopback.test.ts` / `c-google-connect-finish.test.ts`: a held code with a sealed key is
  refused without the proof and with a wrong one, redeemed with the right one; flag-only start without a key is not
  held. Connections and Slack the same.
- web unit test for the copy link (desktop only, copies the opened address).
- E2E on qa.trina.app: desktop dev build, Copy link → another browser → Connected, Drive question answers.

## Result

- Built as the UX spec says: `web/src/components/integrations/CopySignInLink.tsx`, at the end of the wait's hint in
  BrowserWait (Drive, Drive shares, Google apps personal and team, Slack sign-in and Add to Slack), the Drive panel of
  the chat card, app connections (SignInPanel, chat card, welcome steps). Desktop app only.
- The held code needs the app's proof: the key is sealed at the start of each sign-in (security review: a key read at
  hold time could be replaced by a later call, and a restart dropped it); the page waits up to 1.5 s for the key before
  its calls. Tests fail without the server change (`c-held-sign-in-app-key`: 3 of 6).
- Screenshots before/after (1440/390, light/dark, ko/en) taken with `web/test/e2e/connect-copy-link.spec.ts`
  (`SHOTS_DIR`). The real-browser walk on qa.trina.app runs after the merge (qa takes dev builds).
