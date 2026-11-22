# The intro deck's design pass and a proper example

- Date (UTC): 2026-11-22 00:12
- Branch: `feat/intro-deck-design`
- Status: done
- Where: server/src/intro-deck (layout2.ts, figures.ts, draw.ts), the example picture in web/public/skill-examples,
  its inputs in examples/data/soopteum. Why: the owner on the 회사 소개서 example: "too tacky and too plain".
- Version impact: patch. The decks the skill makes look different; no new input, output or setting.

## Goal

The owner sees the deck through 예시 on the onboarding skills step and through the decks it makes. Both should look
like a good modern startup or agency deck: strong type, one brand accent, whitespace, varied slides, and still good
with only a name and a one-liner. The example is made on a fictional, realistic company.

## Scope

In: the round-2 compositions and figures (cover, about, content header, grids, flow, quote, closing), the example
picture (ko, en) and its inputs, the viewer's line naming the invented company of the deck example.
Out: the skills list, other packs and their examples (another agent changes the list), the SKILL.md text (its
example hash stays), pictures and logos (the example company has none, as 예시커피 had none).

## Steps

1. Render before and after for the same slides (a scratch harness over layoutDeck2 + typst), look, iterate.
2. Flat grounds: no brand mesh, no glows. Content slides get an eyebrow ("02  회사 소개") and a plain footer.
3. Cover without a picture: the headline set at 152 px anchored low, the company and "회사 소개서" on top, the deck's
   contents beside the headline. Closing with no details mirrors it.
4. Figures: pains as large statements (no numbers: they have no order), what-we-do as tinted panels, process as numbered steps on one rule (no chevrons),
   bigger stat numbers, quote set in the middle.
5. Example: examples/data/soopteum (숲틈 / Soopteum), scripts/intro-deck-example.ts builds the artifact HTML, then
   web/scripts/skill-examples.ts takes the picture.
6. Tests, typecheck, check:prepush; changes/ and a decision file.

## Decisions

docs/decisions/20261122-intro-deck-design.md (flat grounds, eyebrow, the new cover, figure styles).

## Risks

The PowerPoint file stays editable: every new element is a native text box or shape from the same display list. The
review's contrast and ink checks run on the new slides (unit tests). Line fits: the title role keeps its size, the
cover's larger role only on the drawn cover without an accent.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/b-intro-deck*.test.ts (under Bun 1.3.12), web
test/unit/onb6-skills.test.tsx and i18n.test.ts.

## Result

As planned. The example's slides are filled by hand from the fictional intro in the tool's slots and checked by the
tool's schema and a number check (scripts/intro-deck-example.ts), instead of a live AI run.
