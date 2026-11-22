# Desktop sign-in hand-off: read the claim's answer, send a lost one again, log each step

- Date (UTC): 2026-11-22 00:10
- Branch: `fix/drive-share-desktop-finish`
- Status: in progress
- Where: desktop/src (main process). Why: the app's half of the Google sign-in hand-off (trina-ax #98, #205).
- Version impact: patch. It fixes a bug and changes no API or data.

## Goal

Owner 2026-11-22, 0.7.0 app and server, hosted team: the "Google Drive 공유" dialog stayed on "Google을 기다리는 중…"
after Google, even though the return page showed the code and Chrome opened the app. It worked on the fifth try. The
app's main process logged nothing.

## Findings

- Server: a team share flow uses the same path as personal Drive (begin → `fromApp` → held result → claim). A unit
  test now covers the share variant: a share flow from a desktop session, a callback without a browser session, the
  code, the claim, then 'ready' on the poll and a share on the confirm.
- Desktop parsing: `signInCode(appLink('https://totoro.trina.app', code), 'https://totoro.trina.app')` returns the code.
  Electron 44's `session.fetch` sends the team cookie with no Origin, so CSRF passes (checked with a real Electron 44).
- Gap: `AppWindow.claimSignIn` (desktop/src/main/app-window.ts) sent ONE POST, never read the answer and logged only
  a thrown error. A lost POST (relay or network hiccup, timeout, 5xx) was dropped without a trace, and the dialog waited
  until its 5-minute limit. The handler also skipped the claim while the window was in its offline state.
- Already in place: a link that arrives before the window exists is kept (main.ts launchLink), and Windows/Linux
  second-instance argv goes to onLink. On macOS only one bundle declares the scheme (owner's Mac checked).

## Steps

1. `desktop/src/common/sign-in-handoff.ts` (pure): `deliverSignInCode` posts the code. A 2xx answer means claimed.
   Another 4xx is refused and not sent again. No answer, 408, 429 or 5xx is sent again after 1, 3, 8 and 13 s (about
   25 s, inside the code's 5 minutes). Each try is logged with the team address and the status, never the code.
2. `claimSignIn` uses it with the team page's own session. It stops when the team on screen changed.
3. `offerLink` logs whether the code link is for the team on screen. It claims in the offline state too.
4. Tests: tests/unit/e-desktop-signin-handoff.test.ts, plus the share case in c-drive-app-return.test.ts.

## Decisions

- One claim address for every code (`/api/integrations/google-drive/claim`). The server tries Drive flows (personal
  and share), then the Google apps, then app connections. Other connectors' hand-offs need no app change.
- A refusal is never retried: the code is single use, and only a 2xx answer uses it up.

## Result

(filled at the end)
