# A locked screen is away; the Mac app reports the computer's own use for the phone rule

- Date: 2026-11-16
- Status: accepted
- Supersedes: [Phone notifications when I'm away](../DECISIONS.md#phone-notifications-when-im-away--no-phone-push-while-im-at-trina-featpush-when-away-2026-11-13-product-owner) (only what "in use" means for the desktop app; the rest stands)
- Branch: fix/away-os-idle (the owner, 2026-11-16; QA rows for the Mac app in the back, an idle computer, a locked screen)

- **Ask:** the owner, 2026-11-16: with "Phone notifications only when I'm away" on, the Mac app (0.5.7) open behind
  other windows and the owner working on the computer, every notice showed on the Mac **and** rang the phone. The
  setting says "While you're using Trina … not on your phone"; Slack keeps the phone quiet while you use the computer.
- **Cause:** a Trina window covered by other windows or minimized is hidden to the browser engine, and Electron
  throttles it (`backgroundThrottling`, on by default). Measured on this Mac with Electron 44.7.2 and the app's
  BaseWindow + WebContentsView: the page's 20 s ping fired once and then not again for over four minutes, and the main
  process's 30 s word on the computer reached the page 3-61 s late. The page sends its state only on a change, so the
  server heard nothing from the window for over a minute, `inUse` left it out (`PRESENCE_SILENT_MS`) and the phone push
  went. The same code ran in v0.5.7.
- **Rule:** "using Trina", for the phone rule only (`server/src/realtime/presence.ts` `inUse`):
  - **Desktop app:** the app is running and signed in to this team, and the computer had input (any app) within
    10 minutes (`PRESENCE_COMPUTER_IDLE_MS`, Slack's desktop idle). The app's main process, which is not throttled,
    reads `powerMonitor.getSystemIdleTime()` and the lock state and posts them to the open team every 30 s and at once on
    a lock or an unlock (`POST /api/me/computer`; `desktop/src/common/system-activity.ts` `ComputerReporter`). A report
    counts for 60 s (`PRESENCE_COMPUTER_FRESH_MS`): the app quit, the computer slept or the team signed out make it old.
    Nothing is sent while signed out; a 401 makes the app check its session; an older server (404) or a refusal (403)
    is not asked again until a team is opened. Going to sleep is told like a lock, signing in is told at once, and
    leaving the team (another team opened, the window closed) is told at once as "not at it". The Trina window may be
    in front, behind other apps or minimized. Guests report too (they have push).
  - **Per computer:** a report is kept per sign-in (the app's session), so one computer locked or idle never makes the
    person away while another device is in use. A fresh "locked" or "idle" report only stops that sign-in's own windows
    from counting.
  - **Not team use:** the report does not count as activity for the hosted service's sleep policy
    (`server/src/system/activity.ts`: an app left open is not use).
  - **A locked screen is away**, so the phone rings: a fresh locked report wins over a window of the same computer
    that still counts as active. The old wording ("counts … a locked screen") meant the same in code (a locked screen made the window idle),
    but read as if a locked screen kept the phone quiet; now it is said plainly.
  - **Browser tab:** unchanged. It cannot see the computer: in use only while visible and within 10 minutes of its own
    input; a hidden tab is idle at once.
  - The page also sends its state again on each word from the desktop app, so a 0.5.7 desktop app gets some help from a
    server update alone (as far as its throttled page lets it).
  - Manual away still wins. The report changes nobody's dot and is kept only in the server's memory.
- **Left out:** turning `backgroundThrottling` off (battery, and it makes a hidden window look visible to the page,
  which its "looked at" rules read). Teams the app has not opened are not reported (the app shows one team at a time).
- **Tests:** `tests/unit/b-presence-computer.test.ts` (background window with recent OS input → cancel, OS idle past
  10 minutes → send, locked → send, no window → send, two computers, hidden browser tab → idle, the endpoint's own-person,
  body, CSRF, guest, sleep-clock and signed-out checks), `tests/unit/e-presence-activity.test.ts`, `tests/unit/e-system-activity.test.ts`.
- **Version impact:** patch (a fix; the new call is additive). Needs the server and the desktop app (0.5.10).
