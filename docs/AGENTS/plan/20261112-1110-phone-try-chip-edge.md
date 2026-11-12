# Phones: "써 보기" keeps a margin at the end of Home's skill chip

Seen on the Android QA app (phone audit follow-up, Home = TC-253): in "팀에 준비된 것", a skill chip without an example
ends with its "써 보기" label touching the chip's right border. The chip (`SuggestionRow.tsx` `chip`) has no padding of
its own and the chip's button (`TeamPrepared.tsx`, `team-prepared-try`) pads only its left (`pl-3`).

## Plan
- `TeamPrepared.tsx`: the skill chip's button pads its right too (`pr-3`), so the label keeps the same space as the title
  on the left; a chip with 예시 keeps its hairline and 44px 예시 target after it.
- `team-prepared.spec.ts` (390): each row's "써 보기" ends at least 8px inside its button.
- Computers: the 1440 rows are a different layout (`team-prepared-rows`); unchanged.

## Result
`team-prepared.spec.ts` 10/10 (1440 and 390); the new check fails with `pl-3` alone (0px margin) and passes with `px-3`.
