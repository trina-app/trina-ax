# The Mac app tells an updated team server about the computer again, without a restart

- Date (UTC): 2026-11-18 02:50
- Branch: `fix/push-when-desktop-active`
- Status: done
- Where: trina-ax core, `desktop/src/common/system-activity.ts`. Why: the phone rule depends on the desktop app's
  computer report, and the app stopped sending it for good after one 404 (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a desktop fix; no server, contract or migration change)

## Goal

QA TC-4834. The owner: "still both my desktop app and my phone app get notifications", with the Mac app open and in use.
Expected (Slack's default, docs/decisions/20261116-away-os-idle.md): no phone push while the computer is in use.

What was checked:

- The server path works on dev (= 0.5.13 in this area): with the real desktop app (dev build) signed in to a local copy
  of the QA team, a phone device and a mock push gateway, an @mention to the person was cancelled for the phone with
  the window in front and with the app hidden, while the app's computer report came every 30 s.
- The report's sender (`ComputerReporter`) stops for good after one 404, 405 or 403 from the team server ("an older
  server"), until a team is opened again. Team servers update themselves at night under an app that stays open for
  days, and the page reload after the update opens no team. Reproduced with the real app: the computer call answered
  404 for the first 45 s, then the server had it; no report reached the server for the rest of the 8-minute run. The
  phone push itself still went out cancelled on this test Mac, because its hidden page kept passing the app's word on;
  on the Mac measured on 2026-11-16 (20261116-away-os-idle.md) a window in the back is throttled and stops counting
  after a minute, and the phone rings as in 0.5.7, until the app is restarted.
- Not settled here: which desktop version the owner's Mac runs. On 2026-11-16 it stayed on 0.5.7 after an update
  (commit 43e23d98); a Mac app before 0.5.10 has no report at all and needs the update.

## Scope

In: the reporter asks a server that had no call (or refused it) again after 5 minutes (`UNSUPPORTED_RETRY_MS`), as well
as when a team is opened. Unit test.
Out: older desktop apps (before 0.5.10) have no report at all; they need the app update. Turning off background
throttling (left out in 20261116-away-os-idle.md).

## Steps

1. `ComputerReporter`: the unsupported origins keep a time to ask again; an optional clock for tests.
2. Unit test: 404, ticks for 4.5 minutes send nothing, then one ask, then reports again; 403 the same.
3. Decision file, changelog fragment.

## Decisions

- docs/decisions/20261118-push-when-desktop-active.md (changes one line of
  docs/decisions/20261116-away-os-idle.md: "not asked again until a team is opened").

## Risks

An older team server gets one 404 every 5 minutes from each open desktop app (a tiny request). No server change.

## Tests

`bun run typecheck`, `bun test tests/unit/e-system-activity.test.ts tests/unit/b-presence-computer.test.ts
tests/unit/b-push-away.test.ts` (Bun 1.3.12), `bun run check:docs`. Hands-on: the real desktop app against a local QA
team copy with the computer call answering 404 first.

## Result

The reporter asks again after 5 minutes. PR to dev.
