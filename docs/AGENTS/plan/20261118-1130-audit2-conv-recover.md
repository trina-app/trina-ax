# A full conversation goes on instead of ending the answer

- Date (UTC): 2026-11-18
- Branch: `fix/audit2-conv-recover`
- Status: done
- Where: trina-ax server/src/chat and server/src/engine (Team AX core). Why: how a turn runs its engine is core code.
- Version impact: patch

## Goal

Limits audit 2 #13 (QA TC-4925): when the engine said the conversation no longer fits ("Prompt is too long"), the
answer ended with "This conversation got too long. Please continue in a new chat." and the matcher took any error with
the word "context" for that. Claude Code compacts and goes on; so should we. Nobody should have to start a new chat.

## Scope

In: Claude Code: a context error starts a fresh session with the history window (and the summary of PR #1283 once
merged, through the same fresh prompt) and a note with what the answer already wrote and did; the same answer goes on
(at most 2 times). Codex: once more with the same note. API engine: older tool results are taken out and the round is
tried again (at most 3 times). Only the providers' "does not fit" errors count. The last error and the memory note no
longer send anyone to a new chat; a session that still does not fit is dropped so "continue" starts fresh.
Out: our own token counting before the call; changing Claude Code's own compaction.

## Steps

1. engine/claude-parse.ts CONTEXT_FULL; engine/api-agent.ts errorOf + shrinkToolResults.
2. chat/context-recover.ts; chat/turn.ts (Claude loop, runCodex, dropSession).
3. shared/src/api/errors.ts text, step label contextRecover, web chat.memory.tip.
4. tests/unit/b-context-recover.test.ts, fake engine contextFullOnce / contextFull.

## Decisions

docs/decisions/20261118-audit2-conv-recover.md
