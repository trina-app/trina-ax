# Desktop connect: "Copy link" on the wait, and a held sign-in code bound to the app

- Date (UTC): 2026-11-28 00:48
- Branch: `feat/connect-copy-link`
- Status: in progress
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
- A start that only SAYS `client: 'desktop'` (#698) is held only when its session has such an app key, so a browser
  session can no longer get a held result by saying so.

Out:
- The web app: Connect opens a tab of the same browser; a copied link in another browser has no session there and the
  web flow refuses it ("not signed in"). Nothing to add.
- Requiring the key for sessions recorded as desktop (desktop apps before this change send none): later, once every
  app sends it.

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

(filled in at the end)
