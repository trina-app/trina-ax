# The phone app shows its own "Resuming your team…" note when a saved hosted team sleeps

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (extends the add-team wake, QA wake gap 1, to a saved team in the web view)
- Branch: mobile-waking-sleeping-team (QA TC-1952: app 1.0.10, trial sleep on)

Plan: [docs/AGENTS/plan/20261122-1023-mobile-waking-sleeping-team.md](../AGENTS/plan/20261122-1023-mobile-waking-sleeping-team.md).
Where: `mobile/App.tsx` (TeamWeb), `mobile/src/reconnect.ts`, `mobile/src/team-check.ts`. No relay, server or web change.

- **Ask:** a person opens the phone app for a hosted trial team that sleeps. The relay holds the page load about 2.5 s
  and answers 503 with its own waking page (`x-relay-error: team_waking`). The app showed "Could not reach your team"
  and Try again, and each Try again started the wait again.
- **Rule:**
  - A **503** on the team page is not a failure yet. The app asks the team at once (`checkTeam`, the add-team check):
    a sleeping team (`team_waking`, `team_offline_cloud`) is woken with a page load (`GET /` with
    `Sec-Fetch-Mode: navigate`) and waited for (up to 3 minutes). The screen shows a spinner, then the native
    "Resuming your team…" note (`waking`, `wakingDetail`) with "Change team". The page loads when the team answers.
  - Trina updating (`team_maintenance`, `x-mycel-updating: 1`) shows "Trina is updating", and a self-hosted team that
    is off shows "Could not reach your team", as before. Both retry by themselves.
  - Any **other 5xx** (500, 502, 504), a network error and a crashed web process stay as before: the failure screen.
  - The failure screen's automatic retry (src/reconnect.ts) shows the waking note too when its check finds the team
    starting. Each probe gets an AbortSignal: when the screen goes away or the app goes to the background, the wake
    and its requests stop.
- **Why the native note, not the relay's waking page:** the page is on the team's origin, so its load end would install
  the bridge and ask for the session on the relay's page, again at each of its reloads (3-20 s). The native note needs
  no bridge and has the same words.
- **Why the check, not the header:** react-native-webview's `onHttpError` gives the status only, not the response
  headers, so the app cannot read `x-relay-error` there. The check reads the relay's answer itself.
- **The retry before this change** already woke a sleeping team (its check follows a "may be asleep" answer with a page
  load), but it showed "Could not reach your team" for the whole wait, and Try again stopped it.
- **Left out:** the relay and the server. The add-team and setup screens: they wake a team already.
- **Ships with:** a new app build (TestFlight, App Store, Play). App 1.0.10 and older keep the old screen.
- **Tests:** `tests/unit/mobile-reconnect.test.ts`, `tests/unit/wake-add-team.test.ts`.
- **Version impact:** patch (phone app fix).
