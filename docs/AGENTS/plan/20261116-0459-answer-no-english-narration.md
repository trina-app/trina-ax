# English status lines between tool calls stay out of Korean, Japanese and Chinese answers

- Date (UTC): 2026-11-16 04:59
- Branch: `fix/answer-no-english-narration`
- Status: in progress
- Where: server/src/chat. Why: the answer text is put together from the engine's events in chat/turn.ts.
- Version impact: patch, a fix in how the answer text is kept; no API or data change

## Goal

The AI scenario check (2026-11-16, report root cause #8) found English lines such as "Only one thread exists; check
it." and "Let me check that the seal printed correctly." at the top of Korean answers (ROOM-03, EDIT-04, ORG-01,
FLOW-01). They are the model's own short text written just before a tool call; the server keeps every text piece in
the answer. The prompt rule (LANGUAGE_RULE) already forbids them and did not hold.

## Scope

In: a hold in front of the answer text (chat/narration.ts): for a ko/ja/zh answer, a short text piece that comes
right before a tool call and has Latin letters and none of the answer's own script is not kept (not streamed, not
saved). The last piece (after the last tool call) is always kept; code blocks, quotes, links, tables and longer text
are kept; a message that asks for English or a translation turns the hold off. All engines (Claude Code, Codex, the
API engine) go through it, since they share Turn.onEvent.
Out: other answer languages with the Latin script (en, id, es): there is no way to tell narration from the answer by
script there.

## Steps

1. chat/narration.ts: NarrationHold (push / toolStart / flush / clear / held) and narrationScript(locale, message).
2. chat/turn.ts: answer text goes through the hold before the redactor; tool_start decides the held piece.
3. A few words in LANGUAGE_RULE.
4. Unit tests; decision file; changelog fragment; scenario re-run ROOM-03, EDIT-04, ORG-01, ROOM-02 (twice each).

## Decisions

docs/decisions/20261116-answer-no-english-narration.md

## Risks

A short English line the person asked for, written just before a tool call (e.g. an English sentence then a
post to a room) in a Korean chat without saying "English": dropped. The message guard (영어/English/translate …)
covers the common way to ask for it. While a piece is undecided (at most 200 characters) it is not streamed yet.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run changelog:check`, tests/unit/narration-hold.test.ts and the turn
tests, under Bun 1.3.12 too.

## Result

(filled in at the end)
