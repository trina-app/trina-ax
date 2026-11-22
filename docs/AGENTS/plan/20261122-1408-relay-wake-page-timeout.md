# Relay waking page: reload a #fragment address, and a real answer after 3 minutes

- Date (UTC): 2026-11-22 14:08
- Branch: `fix/relay-wake-page-timeout`
- Status: done
- Where: relay/src/pages.ts. Why: the relay serves the "Resuming your team…" page (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix on the relay's waking page (no API or data change)

## Goal

Owner 2026-11-22: a hosted trial team was paid for, the owner account was never made, the team slept; the owner opened
the setup link (`https://<team>.trina.app/setup#token=…`) and the page said "Resuming your team… Waiting: 266 s" and kept
counting. The control plane got one wake request, the server was up 20 s later and healthy, the page never asked again.

Cause: the page reloads with `<meta http-equiv="refresh">`. When the address has a #fragment a browser treats that
reload as a jump inside the page (HTML "navigate to a fragment"), so no request is made. Checked in Chrome: a 1 s
refresh on `/setup#token=abc` loaded once; on `/plain` every second. The setup link and invite links carry their token
in the fragment, so the owner's first visit after a sleep never opened.

## Scope

In:
- The waking page and the no-room page reload a #fragment address from a tiny script after their own refresh time
  (`location.reload()` keeps the fragment). Without a fragment the meta tag does it, as before.
- The waking page: after 3 minutes the spinner gives way to "taking longer than usual … contact support" and a
  **Try again** button (6 languages). It keeps reloading by itself.
- The seconds counter starts over when the last count is older than a minute (a team page came in between), not only
  after 10 minutes.

Out: the control-plane side (a team without an owner account slept 10 min after every wake) is trina-cloud
`fix/setup-pending-wake`.

## Steps

1. pages.ts: `hashReload(sec)` script on team_waking and team_no_room; `lateBlock` + counter in `wakingScript`.
2. Tests: tests/unit/f2-relay-wake.test.ts (fragment reload, late answer, counter start-over).

## Decisions

none

## Risks

The relay pages have no CSP; the scripts hold no visitor text (only fixed strings, JSON-encoded). Six languages.
The relay is deployed on its own (relay.trina.app, relay-us.trina.app).

## Tests

`bun test tests/unit/f2-relay-wake.test.ts`; Chrome check of the reload with and without a fragment.

## Result

Done on the branch; Chrome reloads `/setup#token=…` every refresh period with the new page.
