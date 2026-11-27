# Desktop Google sign-in finishes in any browser: the code goes back to the app over 127.0.0.1

- Date (UTC): 2026-11-27 11:02
- Branch: `fix/google-connect-desktop-wait`
- Status: done
- Where: server (held return pages), desktop (a return address on 127.0.0.1), web (tells the server that address),
  shared (the contract). Why: one sign-in hand-off, used by every connection the desktop app signs in to.
- Version impact: patch: a fix to an existing sign-in; no new screen, no migration, no API shape change (one optional
  request header).

## Goal

Owner, 0.20.0 (and before): connecting Google Drive from the desktop app, Google's consent finishes in the browser, but
the app keeps waiting ("계속 로딩중임 안끝나") until its 5-minute limit.

Evidence (2026-11-27, read only):
- The owner's Mac sends https links to **ego lite** (its default browser), which has no session of the team. So Google's
  return is "held for the app": the page gives a one-time code only through the app link
  `trina-ax://open?url=<team>/#code=…`, opened by a meta refresh and a button.
- ego lite (Chromium 156) cannot open a custom scheme at all: the meta refresh (and a click) end on
  `chrome-error://chromewebdata/` ERR_UNKNOWN_URL_SCHEME, the page with its button is gone, the app never gets the
  code. Reproduced on qa.trina.app with the owner's ego lite and a 0.20.1 desktop app: flow stays "Waiting for Google".
- The owner's app log (`handoff.log`) on 11-27 09:2x: no `(sign-in code link)` line for any of the three sign-ins
  (the hosting service redeemed each), only one plain `open-url (link)`.
- The same flow with a browser signed in to the team as the same person ends in "Connect this account?" in the
  desktop app: the server and the app's polling are fine. Only the hand-off to the app fails.
- A top-level navigation from the team page to `http://127.0.0.1:<port>/…` works in ego lite without a gesture.

## Scope

In:
- Desktop: one return address for sign-in codes on 127.0.0.1 (system port, open while the app runs). A page load of
  `/sign-in-code?code=<43 chars>` with the exact Host, as a navigation, hands the code to the same claim the app link
  uses (team on screen, the app's own session), brings the window forward, and answers a short static page.
- Web: inside a desktop app that has it, every API call says that port (`x-mycel-app-return`).
- Server: remembers the port per DESKTOP session (memory only, bounded). Every held page (Drive, Google apps, app
  connections, Slack) sends the browser to that address (meta refresh + button); without a port (an older desktop app,
  a restart before its next call) the app link as before.
Out: changing the security rule (a browser without the session never finishes by itself), browsers that refuse
http://127.0.0.1 navigations (none found).

## Steps

1. Shared: header name, path, bridge `codeReturn.port()`.
2. Desktop: `common/code-return.ts` (pure, node:http) + main/preload wiring + AppWindow claim.
3. Web: header in `lib/api.ts`.
4. Server: port registry (`google-drive/app-return.ts`), middleware note, `heldLink()` in the four held pages.
5. Tests: server held pages with and without a port, middleware only for desktop sessions; desktop listener rules.
6. Real check on qa.trina.app with the owner's ego lite and a desktop build.

## Decisions

`docs/decisions/20261127-desktop-sign-in-code-loopback.md` (changes the "not the loopback listener" note of
`server/src/integrations/google-drive/app-return.ts`).

## Risks

Security: a code is redeemable only by the session that started the flow, as with the app link; the address is the
port the starter's own app reported, so a phished victim's browser goes to the victim's own computer. A local program
that finds the port can only hand codes it already has to the app. Desktop needs a release to reach people (older apps
keep the app link).

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit` for google-drive, google-apps, connections, slack, desktop
sign-in hand-off, `tests/security`.

## Result

Built as planned, plus from the independent review: the 127.0.0.1 link carries the team's address and the app hands
the code on only while that team is on screen (never to another team's server; a code for another team is not
remembered, so a reload after switching back still works); the held page keeps the app link beside it ("If the app does
not open, press here") for an app that quit meanwhile; the port map keeps the newest call last. Unit tests:
`tests/unit/c-sign-in-code-loopback.test.ts` (REPRO fails on the old page), `c-connect-app-return.test.ts` (connections
route). Live check: ego lite navigates from a team page to http://127.0.0.1 without a prompt (11-27). The end-to-end
check on qa.trina.app needs this on dev (server) and a desktop build with `codeReturn`.
