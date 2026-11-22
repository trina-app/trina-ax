# "Finished" notice only at the real end of a request

- Date (UTC): 2026-11-22 01:03
- Branch: `fix/finished-notice-real-end`
- Status: in progress
- Where: server (devenv jobs, chat turn end, notifications), shared (inbox schema), web (Activity text). Why: a live bug
  the owner reported on potenlab.trina.app (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a wrong notice is fixed; no new setting or API break (one optional inbox field)

## Goal

On potenlab.trina.app (11-22, chat "트리숲 홍보영상 제작", claude-code engine) Activity said "‘트리숲 홍보영상 제작’에서
부탁한 작업을 트리나가 마쳤어요." at 00:55:14Z while the answer was still running (turn `01a200ad-7ec7…` status `running`, no
final answer). The data: the AI started a background job `hf_render` with box_shell `job: true`; it exited 0 at
00:55:14Z, and `endRun` (server/src/devenv/jobs.ts) sent the "finished" notice for the job. The AI read the result at
00:55:51Z and went on (a second job `hf_render2` still running, the AI polling it with `sleep 110`). A background step of
the answer ending is not the request ending. Engine-independent: the API engine's box_shell jobs end the same way.

## Scope

In:
- A job that ends while its person still has an answer queued or running in its chat says nothing then (no toast, no
  Activity row). Its result goes to the AI as before (runResultsForAI).
- When that chat's last answer ends (turn end, and the job tracker's poll as a backstop for a restart), one Activity
  notice for the request, from the answer's real outcome: "…마쳤어요." only when the answer finished; else "…멈췄어요 —
  <reason>" (a limit, an error, a stop, a server restart, or Trina waits for an answer).
- A job that ends after the answer ended (the AI ended its answer while the job ran) keeps today's job notice.
Out: the narration leak, raw commands in steps, shared-chat notifications, server/src/engine/api-honest.ts.

## Steps

1. jobs.ts: `heldByAnswer` in endRun; `tellHeldJobs(ctx, chatId?)` sends the request notice (source `turn-<turnId>` in
   dev_env_notices, so one per answer, no migration) or, with no ended answer to tie to, the job's own notice.
2. turn.ts finish: call tellHeldJobs for the chat; the job tracker's tick calls it for all chats.
3. notifications/service.ts devEnvOut: a `turn-` source shows `devEnv.request` (outcome, reason, chat title).
4. shared schema `devEnv.request`; web Activity text; i18n in six languages.
5. Tests: tests/unit for hold, release at turn end, outcome words, backstop, job after answer end.

## Decisions

none (keeps docs/DECISIONS.md "Dev environment: disk floor, jobs, CPU as activity": the person hears the result;
now the result of the request, not of one step inside it)

## Risks

No migration. A job notice is held only while an answer of the same person in the same chat is queued or running.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (devenv, notifications), web unit, tests/security, and a real
check on a private QA copy with the claude-code engine.

## Result

(filled in at the end)
