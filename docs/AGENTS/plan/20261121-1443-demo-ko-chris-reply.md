# Demo Gmail search finds Chris's reply in Korean (QA TC-6712)

- Date (UTC): 2026-11-21 14:43
- Branch: `fix/demo-ko-chris-reply`
- Status: in progress
- Where: `server/src/demo/fakes/gmail.ts`. Why: the free-roam demo's fake Gmail answers the AI's searches
  (docs/decisions/20261119-demo-fakes.md)
- Version impact: patch, a fix to the demo's fake mailbox search; no product behaviour changes

## Goal

In the Korean free-roam demo the chip "크리스 답장 왔어?" ("Did Chris reply?") made Trina say there was no mail from
Chris, although the Korean mailbox holds his reply. The fake's search compared each query word as a raw substring of
the header, and ran every word as AND:

- `from:크리스님` (the chip says "크리스님이", the AI keeps the honorific) finds nothing: "크리스님" is not in
  "크리스 워커 <chris.walker@fieldnote.example>".
- `from:"Chris Walker"` finds nothing in Korean: the address is `chris.walker`, with a dot.
- `from:크리스 OR from:Chris`, `from:(크리스 OR Chris)`, `{from:크리스 from:Chris}` find nothing in either language:
  OR, brackets and braces were read as words to find.
- `from:me` / `to:me` find nothing.

## Scope

In: the fake's search reads Gmail's operators (OR, `|`, `( )`, `{ }`, `-` for not, `key:(...)`), compares words after
splitting names and addresses into words (so a name matches the display name in either script or the address), drops
a Korean honorific or particle at the end of a Hangul word when the word itself is not found ("크리스님" → "크리스"),
and knows `me`. Unit tests for the en and ko seeds with the queries an AI sends.

Out: transliterating Hangul to Latin letters (the ko seed already carries both: a Hangul display name and a Latin
address). The chip's prompt stays as it is.

## Steps

1. A small query parser and word matcher in `server/src/demo/fakes/gmail.ts`.
2. `tests/unit/demo-gmail-search.test.ts`: en and ko seeds from `scripts/demo/steepling/make.ts`, queries
   `from:크리스`, `from:크리스님`, `from:Chris`, `크리스`, `chris.walker@fieldnote.example`, `from:"Chris Walker"`,
   OR / brackets / braces / negation, `from:me`, and that unrelated words still find nothing.
3. `changes/demo-ko-chris-reply.md`.

## Decisions

none

## Risks

Demo only. A looser search may return more mail for a vague word; tests check that a word in no mail still finds
nothing and that AND still narrows.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/demo-fakes.test.ts`, `tests/unit/demo-free-roam.test.ts`,
`tests/unit/a-demo-free-roam.test.ts`, the new test.

## Result

Filled in at the end.
