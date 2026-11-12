# Phone app: a failed session check no longer shows "다른 팀에 연결" under a signed-in page

Owner 2026-11-12 (iPhone, TestFlight 1.0.5 build 9, 4G): Settings showed "potenlab.trina.app · Connect to another
team" under the tab bar — "여기도 가끔 이상하네".

## Cause
The app asks GET /api/me in the page (src/session-check.ts) on every load and route change, and shows the team line
until the answer is yes. Any answer that is not 2xx — a network blip on 4G, a 502 from the relay or tunnel, a 429 —
counted as "signed out", so the line came up under a signed-in page until the next route change asked again.

## Plan
- The page posts the status (0 when the request failed); `readSessionCheck` answers 'in' (2xx), 'out' (401/403) or
  'unknown' (anything else).
- App.tsx: 'in'/'out' set signedIn; 'unknown' keeps it (and only counts as answered on the first check, as before).
- Ask again when the app comes back to the foreground.
- tests/unit/mobile-push.test.ts: the three answers; the App wiring.

## Result
`tests/unit/mobile-push.test.ts` 43/43 (in/out/unknown, the App wiring); mobile `tsc --noEmit` passes. Ships with the
next app build (iOS build 10).
