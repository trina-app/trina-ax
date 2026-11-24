# Apps on the computer: a Connect pressed after a Settings check stopped makes the page check again

- Date (UTC): 2026-11-24 07:00
- Branch: `fix/local-app-late-confirm-recheck`
- Status: done
- Where: server (`server/src/integrations/connections/local.ts`). Why: the server sets the deadline of each local call.
- Version impact: patch (a bug fix; no new interface)

## Goal

QA on 2026-11-24 (Aside, Windows desktop app 0.16.0, Mac and Linux servers): a person pressed Add Aside, and the desktop
app showed "Connect this program?". They pressed Connect after about 4 minutes. The connection stayed at
"The service didn't answer in time", and the page did not check again. Check again then worked at once.

Recorded frames (CDP, the page's WebSocket):

- 06:31:33 the check starts; `local.call` initialize reaches the window, and the confirm opens
- 06:33:03 the check stops at its own deadline (`MCP_LIST_TIMEOUT_MS`, 90 s): `list_timeout`
- 06:35:23 Connect: initialize answers; no `refresh` follows
- 06:35:51 Check again: tools/list answers in 0.1 s, Connected

Cause: two deadlines. A check gives up after 90 s, but the local transport gave the check's initialize
`CONFIRM_WAIT_MS` (5 minutes). The desktop app counts a confirm as late only at that call's deadline
(`askUntil`, less `CONFIRM_EARLY_MS`), and only a late Connect calls `onConfirmed`, which makes the page check again.
A Connect between 90 s and 5 minutes was neither in time nor late.

## Change

- `localTransport`: a Settings check's initialize (`via.turnId === null`, no `long`) gets `CHECK_CONFIRM_WAIT_MS`
  (`MCP_LIST_TIMEOUT_MS` less 2 s). A turn's initialize keeps `CONFIRM_WAIT_MS`.
- Result: at about 88 s the desktop app answers `unconfirmed`. The check shows "Waiting for you to confirm in the
  desktop app" (`local_confirm`) instead of a timeout, and a later Connect calls `onConfirmed`, so the page checks
  again by itself.

## Tests

- `tests/unit/c-local-relay.test.ts`: a check's initialize deadline is `CHECK_CONFIRM_WAIT_MS`, under 90 s.
- `tests/unit/e-local-apps.test.ts` (unchanged): a late Connect is told; one in time is not.
- `tests/unit/c-local-apps.test.ts` fails on this machine before and after the change (harness WebSocket "Mismatch
  client protocol"); CI runs it.
