# Phone app: a sleeping hosted team shows "Resuming your team…", not "Could not reach your team"

- Date (UTC): 2026-11-22 10:23
- Branch: `mobile-waking-sleeping-team`
- Status: done
- Where: mobile/ (App.tsx, src/reconnect.ts). Why: the phone app is in this repo; no server or relay change.
- Version impact: patch (fix in the phone app; it ships with the next app build)

## Goal

A person opens the phone app for a hosted trial team that sleeps (trial sleep on). The relay holds the page load
about 2.5 s, then answers 503 with its own "Resuming your team…" page (`x-relay-error: team_waking`). The app treats
every 5xx as a failure: it shows "Could not reach your team" and Try again. The team starts in about 20 s, but the
screen does not say so, and each Try again starts the wait again. The person must tap Try again many times.

After this change the app shows its own "Resuming your team…" note while the team starts, and opens the team when it
answers.

## Scope

In:
- A 503 on the team page: the app asks the team at once (the same check as the add-team screen, `checkTeam`). A
  sleeping team is woken and waited for, with the waking note on screen. Then the page loads again.
- The automatic retry of the failure screen (src/reconnect.ts) shows the waking note too when its check finds the team
  starting, and its wake stops when the screen goes away (an AbortSignal).
- Other failures stay as they are: no network, DNS, TLS (onError), 500/502/504, a crashed web process.

Out:
- The relay and the server: no change.
- The add-team and setup screens: they wake a team already.

## Steps

1. src/reconnect.ts (no native imports, unit tested): `httpFailure(status)` (503 → check, other 5xx → unreachable),
   `probeAnswer(check)` (what a check means for the failure screen), `Reconnect.now()` (probe at once), an
   AbortSignal for each probe (aborted by stop and pause).
2. App.tsx TeamWeb: onHttpError uses `httpFailure`; a 503 shows a spinner, the check runs at once, and the screen
   shows `WakingNote` when the team is starting. The probe passes `onWaking` and the signal to `checkTeam`.
3. Tests: tests/unit/mobile-reconnect.test.ts (new functions, App.tsx wiring), tests/unit/wake-add-team.test.ts (a
   cold-start 503 sequence).
4. Decision file, changelog fragment.

## Decisions

- docs/decisions/20261122-mobile-waking-sleeping-team.md: the app does not show the relay's waking page in the web
  view; it shows its own native note.

## Risks

- react-native-webview's onHttpError gives the status, not the headers: the app cannot read `x-relay-error` there.
  The check after a 503 tells the cases apart (asleep, updating, offline).
- The fix reaches people only with a new app build (TestFlight, App Store, Play).
- No new text: the note reuses `waking` and `wakingDetail` (all app languages have them).

## Tests

`npm --prefix mobile run typecheck`, `npm --prefix mobile test`, `bun test tests/unit/mobile-reconnect.test.ts
tests/unit/wake-add-team.test.ts tests/unit/team-link.test.ts`, `bun run check:docs`.

## Result

Built as planned. Also: `checkTeam` passes its signal to each request (health and wake), and a stopped check answers
`cancelled`, so the add-team Cancel stops a request on its way too. The waking screen has "Change team", not Try
again (Try again started the wait again). The retry before this change already woke a sleeping team, but it said
"Could not reach your team" for the whole wait. PR: see the branch.
