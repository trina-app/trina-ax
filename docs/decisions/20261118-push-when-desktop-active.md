# The desktop app asks an updated team server about the computer call again

- Date: 2026-11-18
- Status: accepted
- Supersedes: one line of [A locked screen is away; the Mac app reports the computer's own use for the phone rule](20261116-away-os-idle.md)
  ("an older server (404) or a refusal (403) is not asked again until a team is opened"); the rest stands
- Branch: fix/push-when-desktop-active (the owner, QA TC-4834)

- **Ask:** the owner, 2026-11-18: "still both my desktop app and my phone app get notifications", with the Mac app open
  and in use and the phone app signed in.
- **Cause found:** the server side works (checked on dev, the same code as 0.5.13 here: with the real desktop app, its
  computer report every 30 s and a phone device, an @mention's phone push was cancelled with the window in front and
  with the app hidden). But the desktop app's `ComputerReporter` stopped for good after one 404, 405 or 403 from the
  team server, until a team was opened again. A team server updates itself at night under an app that is left open
  for days, and the page reload after that update opens no team. So an app that first met the server before its
  0.5.10 update never told it about the computer afterwards; with its window in the back the page is throttled, the
  server stops counting it after a minute, and the phone rings as in 0.5.7. The stop was reproduced with the real app
  (the call answered 404 for its first 45 s, then the server had it: no report reached the server for the rest of an
  8-minute run); the throttled page that then lets the phone ring is the one measured on 2026-11-16 (the hidden page on
  the test Mac kept passing the app's word on, so the push there was still cancelled).
- **Rule:** a server that had no call (404/405) or refused it (403) is asked again after 5 minutes
  (`UNSUPPORTED_RETRY_MS`, `desktop/src/common/system-activity.ts`), and, as before, whenever a team is opened. An
  older server gets one small request every 5 minutes from each open app.
- **Left out:** desktop apps before 0.5.10 have no report at all and need the app update (Settings › Apps). Turning
  off background throttling stays out (battery; see the decision above).
- **Tests:** `tests/unit/e-system-activity.test.ts` (404, nothing for 4.5 minutes of ticks, then asked again and
  reports from then on; 403 the same).
- **Version impact:** patch. Needs the desktop app only.
