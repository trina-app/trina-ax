# Waking page: Try again starts the count over (TC-8973)

- Date (UTC): 2026-11-24 18:30
- Branch: `fix/relay-wake-retry-timer`
- Status: done
- Where: relay/src/pages.ts. Why: the relay serves the team "waking" page and its inline script (see docs/REPOSITORY-RULES.md)
- Version impact: patch (relay): a bug fix in a page script, no new feature

## Goal

On the waking page, pressing **Try again** (shown after 3 minutes) should start the "Waiting: N s" count at 0. QA saw
196 s go on to 210 s. The relay holds the next page load about 2.5 s while it wakes the team; during that time the old
page's 1-second timer wrote the old start time back to sessionStorage, so the new page kept the old count.

## Scope

In: the button handler stops the 1-second timer and the #fragment reload timer, then removes the stored start time,
then reloads. A unit test that ticks the old page's timer after the click.
Out: the meta refresh (it reloads the same address; the start time is already gone by then).

## Steps

1. Keep the interval id; the #fragment reload keeps its timer id on `window`.
2. Try again: clearInterval, clearTimeout, removeItem, reload.
3. Test in tests/unit/f2-relay-wake.test.ts; run typecheck, check:prepush, f2-relay-wake and tests/relay/f-sleep.

## Decisions

None.

## Result

Try again now calls clearInterval and clearTimeout(window.mycelWakeReload) before it removes `mycelWakeSince` and
reloads. New unit test ticks the old page's timer after the click and checks the next page shows 0 s; it fails on the
old script. f2-relay-wake and tests/relay/f-sleep pass.
