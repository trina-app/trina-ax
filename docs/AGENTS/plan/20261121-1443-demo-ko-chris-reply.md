# Demo Gmail search finds Chris's reply in Korean (QA TC-6712)

- Date (UTC): 2026-11-21 14:43
- Branch: `fix/demo-ko-chris-reply`
- Status: done
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
- `chris OR 크리스` (what the failing answer says it searched), `from:크리스 OR from:Chris`, `from:(크리스 OR Chris)`,
  `{from:크리스 from:Chris}` find nothing in either language:
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

Built as planned. The search in `gmail.ts` now parses the query (`parseQuery`) and matches terms word by word with the
Korean-ending fallback; unknown `key:` words are searched as plain text, Gmail keys the demo does not keep (filename:,
size:, ...) do not narrow. `tests/unit/demo-gmail-search.test.ts` runs 53 cases on the en and ko seeds; before the fix
`from:크리스님`, `from:"Chris Walker"` (ko), OR, brackets, braces and `to:me` found nothing.

Review follow-up: Japanese honorifics (さん, 様, 氏, くん, ちゃん, also with から/の … after them) are dropped like the
Korean endings. Keys and values the demo does not keep (dates, category:, has:drive, is:snoozed, in:snoozed …) are
now taken out of the query (`pruneQuery`) instead of counting as true, so `-category:promotions` no longer removes
every mail and `a OR older_than:30d` is `a`. `in:drafts` is read from the parsed query, so it works at the start, in
brackets and in any case, and `-in:drafts` searches the other mail.
