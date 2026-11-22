# Desktop sign-in hand-off: read the claim's answer, send a lost one again, log each step

- Date (UTC): 2026-11-22 00:10
- Branch: `fix/drive-share-desktop-finish`
- Status: done
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
5. macOS second start (added after the owner's Mac showed 23 stale registrations of the bundle id). LaunchServices
   may start another registered copy for a link. That copy loses the single-instance lock and quits, so the link was
   lost and the running app only came to the front. Now:
   - a second start waits up to 3 s for its open-url and hands the link to the running app over
     `<userData>/link.sock` (mode 600), main/link-forward.ts;
   - the running app checks the link as any other (linkFromArgv, offerLink);
   - a packaged Mac app registers its own bundle again at every start (`lsregister -f`).
6. The hand-off log also goes to `<userData>/logs/handoff.log` (256 KB, one rotation). It holds no code.

## Decisions

- One claim address for every code (`/api/integrations/google-drive/claim`). The server tries Drive flows (personal
  and share), then the Google apps, then app connections. Other connectors' hand-offs need no app change.
- A refusal is never retried: the code is single use, and only a 2xx answer uses it up.

## Result

Real-app loop on this Mac: the built desktop app in its own bundle (com.example.trinarepro), 6 teams stored, the team on
screen a local https team server with fake Google, delivery through LaunchServices (`open -b`), app in front, Finder
in front or app hidden:
- origin/dev with logs only: 30/30 without hiccups, 20/30 with a 2.5 s claim hiccup on every 3rd run (all 10 lost,
  logged `try 1: 502`).
- this branch: 30/30 without hiccups, 30/30 with the same hiccups (`try 1: 502`, `try 2: 502`, `try 3: 200`).
- A stale second copy of the bundle id registered (old code): 0/6. The running app logged no open-url at all; the
  link went to the other copy. This is the owner's case; unregistering stale copies fixes it there.
