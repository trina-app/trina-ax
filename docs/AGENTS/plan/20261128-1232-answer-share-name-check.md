# Answer-share test: names are checked without the random confirmKey

- Date (UTC): 2026-11-28 12:32
- Branch: `test/answer-share-name-check`
- Status: done
- Where: tests/unit. Why: a flake stopped the v0.20.4 release run (see docs/REPOSITORY-RULES.md)
- Version impact: none (test only)

## Goal

`tests/unit/b-answer-share.test.ts` checks that no member's name is in the share answer by searching the whole
response text. The response carries `confirmKey`, a random base64url value, so a name like "Gus" or "Bob" can appear
in it by chance: release run 46142076130 (v0.20.4) failed on `…iG2GGus5Ti…`.

## Scope

In: the four whole-text name checks read the response without `confirmKey` (helper `shown()`); the key itself is
still checked as a string where it was. Out: no server change; the answer never named anyone.

## Steps

1. Add `shown(r)`: the response JSON with `confirmKey` removed, stringified.
2. Use it in the four `not.toContain(name)` checks.

## Decisions

None.

## Risks

None: test only. The check still covers every other field of the answer.

## Tests

`bun test tests/unit/b-answer-share.test.ts`, `bun run check:docs`.
