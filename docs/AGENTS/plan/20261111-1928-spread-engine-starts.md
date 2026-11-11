# Spread engine launches (3 per 200 ms) and chunk file-name find checks

- Date (UTC): 2026-11-11 19:28
- Branch: `fix/spread-engine-starts`
- Status: in progress
- Where: server (`server/src/chat/runtime.ts`, `server/src/team-files/find.ts`). Why: server-side queue and file search (see docs/REPOSITORY-RULES.md)
- Version impact: patch — performance fix, no API or setting change

## Goal

QA TC-277: on a 2-core server with a raised concurrency, 15 answers starting in one instant froze every request for
0.5-1.3 s, and one broad file-name search on 23k files stalled everyone for 60-400 ms. Redo of #463, whose spread held
turns in the queue and so changed the round-robin tickets (fairness, per-person limits) with 2+ people, and conflicts
with #442 (turns waiting for a person hold no slot; liveCap).

## Scope

In: a start gate for the engine launch only (`TurnExec.run`): at most 3 launches per 200 ms, first in first out. The
claim, `running`, the ticket, `slotsInUse`/`liveCap` and every limit stay exactly as on dev, so queue order,
fairness, `queuePosition` and the web "queued" display match dev by construction. A turn stopped in the gate (Stop,
shutdown, budget) leaves it and ends at once without an engine; shutdown clears the timer; drain waits for gated turns
like for any running one. File-name find: `visiblePath` in chunks of 100 with `setImmediate` between, a file hit cap of
1,000 (2,000 candidate names); folder find (`findFolders`, TC-230) keeps its own cap (5,000), `siblingVisible` and
`scanCut` unchanged.
Out: no web change (the #463 `useQueueShown` delay is not needed: nothing new shows "queued").

## Steps

1. `ChatRuntime.launch` / `launchGated` / `ungate` in runtime.ts; `schedule()` calls `launch(exec)` where it called `exec.run()`.
2. find.ts: candidates in the rg callback, checks in chunks after it.
3. Tests: `tests/unit/start-gate.test.ts` (incl. the 2-person fixed-order repro), `tests/unit/find-files-cap.test.ts`.

## Risks

A turn in the gate is "running" without an engine for up to ~1 s in a burst of 15; every stop path goes through
`turnEngineEnding`, which ungates it. Permission checks for find are the same function, rules and principal.

## Tests

typecheck, check:i18n, check:docs; start-gate, find-files-cap, fair-queue(-runtime), turn-slot-leaks,
turn-waiting-slots, queue-recovery-launcher, schedule tests, attach-team-files, access-tree-api; a random differential
of queue outcomes vs no gate; the TC-277 load scripts at concurrency 15 on 2 cores.

## Result

(filled in at the end)
