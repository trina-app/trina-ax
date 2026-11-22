# Text a tool call follows is narration, not the answer (Korean, Japanese, Chinese answers)

- Date (UTC): 2026-11-22 04:30
- Branch: `fix/interim-text-not-answer` (stacked on `fix/ai-honesty-qa-1122`, #316)
- Status: done
- Where: server/src/chat/turn.ts, server/src/chat/narration.ts. Why: the answer text the server saves and streams.
- Version impact: patch: what is saved as the answer changes; no API or schema change.

## Goal

English working notes between tool calls kept leaking into Korean answers (owner live examples; QA TC-r2u-01/06/16/29)
while a word-pattern filter chased each wording. Decide by position: a piece a call follows is interim.

## Scope

In: decision docs/decisions/20261122-interim-text-not-answer.md; endPiece / endInterimFallback in chat/turn.ts; tests.
Out: English answers (unchanged, as in Claude Code); a dim live narration line in the web app (the piece is a thinking
step's detail; the app shows thinking steps already).

## Steps

1. Interim pieces out of the answer at a call (reset delta), into a thinking step; fallback when the final reply is empty.
2. Only where narrationScript is set; bookkeeping calls and pieces copied into the call keep the text.
3. Tests; independent review; area tests.

## Decisions

docs/decisions/20261122-interim-text-not-answer.md.

## Risks

Tests that read fake-engine text before a call in a Korean-language turn (one moved: b-onboarding-draft).

## Tests

tests/unit/narration-hold.test.ts and the area tests of turn text (b-chat, b-browser, b-chat-titles, b-context-recover,
b-chat-file-placement, b-onboarding-draft, b-review, connect-continue, api-engine*, b-answer-share, b-side-chat).

## Result

Built as planned with the review's fixes (bookkeeping calls, copied pieces, retry reset, card positions, no re-stream).
