# Skill edits: a line with bold text is not read as copied from the skill's own read

- Date (UTC): 2026-11-25 20:10
- Branch: `fix/skill-edit-markdown-own-words`
- Status: in progress
- Where: server/src/chat/auto-memory.ts. Why: the copy check that personal skills and auto memory share (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a bug fix in an existing check

## Goal

In the real-AI QA of batch #609, "다음 주 할 일은 5개로 해줘, 앞으로도." changed the skill's rule line. The step line
`2. 보고서 **맨 아래**에 "다음 주 할 일"을 **딱 3개** 적는다.` was refused as "come from tool output", so the skill
said both 3 and 5. #606 counts the skill's own text as the person's words, but the copy check cleans markdown out of
the text it checks and out of the tool output (`**맨 아래**에` reads `맨 아래에`), and not out of the person's own words
(`맨 아래 에`). A line with bold or code marks inside a word could never match its own old line.

## Scope

In: `copiedFrom` cleans the person's own words in the same way as the other two texts.
Out: the daily cap of 6 skill changes (see Risks).

## Steps

1. Clean `own` with `cleanOutside` before folding, in both the word-run and the CJK character-run checks.
2. Tests: a pure case in tests/unit/auto-memory.test.ts, and a QA-shaped edit with bold text in
   tests/unit/personal-skill-edits.test.ts.

## Decisions

none

## Risks

None for security: cleaning only makes the person's own words read like the text they are compared with. Tool output
and the new text are cleaned the same way as before.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/auto-memory*.test.ts, personal-skill*.test.ts, and the memory
tests under Bun 1.3.12.

## Result

Filled in at the end.
