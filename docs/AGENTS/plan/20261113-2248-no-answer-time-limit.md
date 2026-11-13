# No time limit on one answer; only a stall guard

- Date (UTC): 2026-11-13 22:48
- Branch: `feat/no-answer-time-limit`
- Status: done
- Where: Team AX core, `server/src/chat/` (turn, runtime, queue). Why: the per-answer time limits live in the chat
  runtime that every engine, scheduled task and template run goes through (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a limit is removed and one error text is added; no API or database change

## Goal

Owner decision (2026-11-14): long jobs must be able to finish. Today an answer stops after 20 active minutes (time
waiting for a person not counted) or 45 minutes in total, whatever the AI is doing. Spend stays bounded by the budgets
and the tool rounds per answer (150 by default, an admin setting), which stay as they are.

## Scope

In:
- Remove the 20 active minutes (`TURN_TIMEOUT_MS`, `tick`'s active clock) and the 45 minutes in total (wall clock,
  `wall_deadline_at` written at dispatch, the launch's `timeoutMs` cut to the remaining wall time) for every engine
  (Claude Code, Codex, API engine), chat turns, scheduled tasks and template runs.
- What else ends a turn that is really stuck, checked first: the Stop button; the engine's exit; the launcher stops the
  engine when the server's connection goes (crash, restart); a restart's recovery ends or requeues running rows; the
  launcher backstop (3 h, only a stuck server). Nothing ends an engine that is alive but silent (a hung model stream, a
  hung engine) before the backstop, and it holds a queue slot all that time. So a **stall guard** stays: the turn ends
  when the engine has produced nothing for 15 minutes. Any engine output counts (every launcher stdout/stderr line,
  including partial-message and tool-input stream lines; API engine stream chunks), and also steps and their progress,
  model-proxy events and card answers. The clock is paused while the turn waits for a person or a slot, while one of
  our own tools runs (box_shell may run 30 minutes, a transcription longer), and while it waits for the launcher.
  Why 15 minutes: longer than any single silent stretch of a working engine (Claude Code's own Bash tool stops at
  10 minutes; a model stream sends bytes every few seconds) and shorter than the old 20-minute cap, so a hung turn frees
  its slot no later than before.
- A stall ends the answer as an error `stalled` ("The AI stopped responding for 15 minutes, so the answer was ended."),
  the text so far kept, retry offered. Not a pause: nothing was cut at a limit.
- Launcher backstop 3 h -> 12 h (it was never reached while the 45 minutes cut every launch). It only catches a
  server that is alive but stuck; a quarantined slot (engine end unconfirmed) is released at the launch's own end
  instead of the old wall deadline.
- Keep `time_limit`: the enum, the database CHECK, the readers, the continuation note and the "paused" text, for answers
  stored before. `timeout` / `wall_timeout` error texts stay for old rows.
- Text: the team setting's hint (5 languages), for-admins (en, ko), docs/site agents/runtime.md, code comments,
  DECISIONS (new entry), `changes/no-answer-time-limit.md`.
- Tests: the old limit tests become stall tests; the queue and turn-deadline tests drop the wall deadline.

Out: a per-answer cost cap (budgets do that), Codex/API-engine round caps (unchanged), a migration to drop
`turns.wall_deadline_at` (left unused; old builds still read it).

## Steps

1. Plan (this file).
2. turn.ts / runtime.ts / queue-store.ts / fair-queue.ts: remove the time limits, add the stall guard; protocol.ts:
   count our tool calls in flight; api-agent.ts: report stream activity.
3. shared errors + web i18n: `stalled`.
4. Text and docs, DECISIONS, changes fragment.
5. Tests; `bun run typecheck`, `check:i18n`, affected unit tests under Bun 1.3.12; a real long answer on a local dev
   server in the QA team.

## Risks

- A legit silent stretch over 15 minutes would now end as an error instead of being cut at 20 minutes anyway: no
  answer is worse off than before.
- An answer can now hold its queue slot as long as it works. Budgets and the tool rounds bound the spend; Stop ends it.
- No migration: `wall_deadline_at` stays NULL for new rows. Older builds that read it after a roll-back treat NULL as no
  persisted deadline (they use their own 45 minutes).

## Result

- Done as planned. Review (one independent reviewer, no must-fix) added three things: the model proxy sends a
  throttled `activity` turn event while a model answer streams (Codex and Claude sub-agents print nothing until a call
  ends); one of our tool calls pauses the guard at most 2 hours; a quarantined slot waits at most 45 minutes past the
  stop (not the 12 h backstop). A stalled scheduled run is `failed`.
- Checks: `bun run typecheck`, `check:i18n`, `check:docs`; under Bun 1.3.12 the 31 chat/queue/proxy test files
  (428 pass, 0 fail) and web `chat-error-words`; a 181-file run had only the known environment failures on this Mac
  (HWP engine, g-subscription socket path).
- Real server (a copy of the QA-Acme team, scripted engine): a 23-minute answer ended `done`; a silent engine ended
  `stalled` after 15.3 minutes.
