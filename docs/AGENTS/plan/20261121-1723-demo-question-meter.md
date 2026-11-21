# Free-roam demo: the question meter counts questions, not the cold start

- Date (UTC): 2026-11-21 17:23
- Branch: `fix/demo-question-meter`
- Status: in progress
- Where: server/ (the demo limit's count), shared/ (the weights), demo-gate/ (its per-visitor backstop). Why: the
  instance counts the visitor's limit, the gate keeps its own copy of that count (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to how the demo counts its limit, no new feature or API

## Goal

On demo.trina.app the bar says "About 8 questions left" and drops to "About 5" after one question. A fresh copy's first
question writes the system prompt and the tools to the prompt cache (about 90k counted tokens, 2.6 questions at 35k),
and an asset request such as a banner edit costs 2-3 questions. Visitors feel cheated. The meter should read as
questions: the first question and a typical one should each take about one off the count.

## Scope

In:
- The visitor's demo limit weighs a cache write like a cache read (0.1), on a free-roam server only
  (credentials/broker.ts `record`, new `DEMO_CACHE_WRITE_WEIGHT` next to `DEMO_CACHE_READ_WEIGHT`).
- demo-gate's per-visitor backstop (`inst.tokens` against `inst.cap`, the instance's limit × margin) counts in the same
  weights, or the gate would stop a visitor ("resting") while their bar still says questions are left.
- Re-check `DEMO_QUESTION_TOKENS` against what a question costs in the new weights.
- Tests: the demo-limit test (writes at 0.1), a first question with a big cache write leaves about 7, gate unit tests.
- The demo-limit test's 409 on a short checkout path (see Risks).

Out:
- The gate's daily cap (`dailyTokens` / `dailyWeightedTokens`), its stats, its `upstream usage` log lines and the
  rate-limit utilization stay on true weights (cache writes counted fully). The owner's subscription protection does
  not change.
- The demo limit (300k) and the landing's "about 8".

## Steps

1. shared/src/api/demo.ts: `DEMO_CACHE_WRITE_WEIGHT = 0.1`; the `DEMO_QUESTION_TOKENS` comment with the new numbers.
2. server/src/credentials/broker.ts: cache writes × the weight on a free-roam server.
3. demo-gate/src/model.ts `visitorWeighted`; upstream.ts counts the instance with it, the day with `weighted`.
4. Tests and a decision file; changes/demo-question-meter.md.

## Decisions

docs/decisions/20261121-demo-meter-cache-writes.md

## Risks

- A visitor can now use more true tokens than before (the cold start no longer counts). The daily cap still bounds the
  whole demo, and the rate-limit pause is unchanged.
- The demo-limit test sent a real message under the limit; on a checkout whose socket paths fit (not a long worktree
  path) the engine really starts, and the next send meets "an answer is still in progress" (409) before the limit.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/a-demo-free-roam.test.ts, demo-gate tests, web unit
demo-free-roam.

## Result

(filled in at the end)
