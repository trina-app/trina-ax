# API engine: the team's tool rounds per answer, not a fixed 30

- Date (UTC): 2026-11-18 17:30
- Branch: `fix/audit1-api-engine`
- Status: done
- Where: Team AX core (`server/src/chat/turn.ts`, `server/src/engine/api-agent.ts`). Why: the engines' answer loop is core.
- Version impact: patch (an existing setting now also applies to the API engine)

## Goal

Limits audit 1 #31. The API engine (OpenAI-compatible models) stopped every answer after 30 tool rounds, while Claude
Code gets the team's `answerStepLimit` (default 150, 10-500). Long jobs on that engine paused and the person had to
press Continue five times as often.

## Scope

In: the chat turn passes `rt.maxEngineTurns` as `maxSteps`; the admin hint says the setting applies to the API engine
too (all locales that have the key).
Out: pictures for vision-capable API models (needs a per-model switch, see the PR's open items). When #1284 (per-answer
caps, `answerStepCap`) is on dev, the API engine should take that cap too (unattended runs at most 150).

## Steps

1. `maxSteps: rt.maxEngineTurns` in the API engine's call (chat/turn.ts).
2. Comments and the admin hint.
3. Test: api-engine-step-limit (35 rounds under a limit of 40 finish; a limit of 10 pauses with tool_limit after 10
   list calls). Both fail on the old code.

## Decisions

docs/decisions/20261119-audit1-api-engine-rounds.md
