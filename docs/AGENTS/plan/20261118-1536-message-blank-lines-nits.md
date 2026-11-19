# Blank lines in messages: three review follow-ups

- Date (UTC): 2026-11-18 15:36
- Branch: `fix/message-blank-lines-nits`
- Status: done
- Where: web/src/lib/messageMarkdown.ts, web/src/lib/blankLines.ts, web/src/components/Markdown.tsx. Why: the same
  shared renderer and helper as PR #1310.
- Version impact: patch, display fixes

## Goal

QA TC-4967, the review nits on PR #1310 (QA TC-4964, people's messages keep their blank lines as typed):

1. A link definition (`[r]: https://…`, not shown) added an extra empty line: the blank lines on both sides of it were
   counted twice, and one after a definition at the end of a message was an empty line under the words.
2. A code block, table, heading, rule or quote after empty lines kept its own top margin, so the gap was larger than
   what was typed.
3. A line of only U+3000 (ideographic space) or NBSP looks empty but did not count as a blank line: it escaped the cap
   of 5 empty lines in a row.

## Scope

In: the three fixes, their unit tests, the room e2e spec. Out: anything else.

## Steps

1. keepBlankLines: a link definition is not a neighbour. The blank lines before and after one hidden definition merge
   (the larger run). Nothing is added before the first shown block or after the last.
2. PersonMarkdown: the block after a `[data-blank-lines]` spacer has no top margin.
3. A line of only spaces, tabs, U+3000 or NBSP is blank: capBlankLines cuts those runs, keepBlankLines counts a
   paragraph of only such lines as its lines, and a run of them inside a paragraph is cut at 5.

## Decisions

Updates docs/decisions/20261118-message-blank-lines.md (same day, same topic).

## Risks

None beyond display; no server, migration or i18n change.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, web/test/e2e/room-markdown.spec.ts.

## Result

Built as planned, plus one step: the block before a spacer also has no bottom margin (`:has`), else a code block
followed by blank lines still left 12px more than typed. Measured on a local QA team copy at 1440 and 390, light and
dark: every gap equals its lines (code, quote, link, a definition merged to 1, a run of U+3000/NBSP lines capped at 5).
