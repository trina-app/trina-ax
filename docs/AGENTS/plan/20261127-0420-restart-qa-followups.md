# Restart follow-ups from QA: limits count real restarts, interrupted chats say so, dialog and row words

- Date (UTC): 2026-11-27 04:20
- Branch: `fix/restart-qa-followups`
- Status: done
- Where: server/src/system/restart.ts, server/src/chat/store.ts, shared/src/api, web (Admin › System, session
  markers). Why: three minor QA findings on the restart feature (#674) on qa.trina.app.
- Version impact: patch, fixes to a shipped feature's wording and limits; no new feature, no migration.

## Goal

1. A called-off "when answers finish" restart no longer counts towards the 2-minute gap and 5-an-hour limit, and the
   row never says "it was just restarted" when nothing restarted.
2. A chat whose answer a restart (or an update) cut shows "Interrupted by a restart" (an update: "by an update") in the
   sidebar and every list that shows the marker's words, not "Stopped: an error".
3. The restart dialog says it waits for running answers only when some run; the row shows the new last restart right
   after an "AI only" restart instead of the previous one.

## Scope

In:
- The limit counts `system.restarted` audit rows (restarts that ran: the AI's at once, the server's at its next start),
  not `system.restart_requested`.
- `Chat.lastStop` ('restart' | 'update', optional, next to `lastOutcome: 'error'`): from the answer's error reason
  (`interrupted`, `updating`, `updating_step`). Session markers get reasons `restart` and `update` with their own
  words in six languages; old clients ignore the new field.
- RestartService.status reads the launcher first, then the audit log and the waiting state in one go.
- The dialog's wait note only with running answers.

Out: the watchdog's own restarts (not in the audit log, as before).

## Steps

1. Server limit + status order; tests in tests/unit/g-restart.test.ts.
2. lastStop in store.answerState, ChatMark, markerOf; labels; tests (shared markerOf, store, web session markers).
3. Dialog note; web test.

## Decisions

none (docs/decisions/20261127-restart.md already says the limit is on restarts; this makes the code match).

## Risks

A server restart whose mark could not be written leaves no `system.restarted` row: that restart does not count. The
watchdog and update restarts never counted. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/g-restart.test.ts and the chat store/marker tests under Bun
1.3.12, web unit tests for System and session markers.

## Result

As planned. The limit counts `system.restarted`; an "AI only" restart the launcher did not answer does not count
either (it shows as failed). `Chat.lastStop` comes from `messages.error` params.reason (store.serverStopOf); the marker
reasons `restart` / `update` reach every surface that uses `reasonText` (sidebar rows and peek, history groups and
dates, search, desktop notifications and toasts). The decision file's Limit line now says restarts that ran.
