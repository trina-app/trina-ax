# The intro deck: pictures where the brand has them, colour blocks and big type where it doesn't

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: feat/intro-deck-design (the owner, on the 회사 소개서 example)

- **Ask:** "If we keep the intro deck, the example has to be done properly. Right now it's too tacky and too plain."
  The reviewers added: real imagery, larger body text, no slide more than half empty, a rhythm of dark and light
  slides, and a deck that still looks designed with no pictures at all.
- **Rule, grounds:** every ground is one flat colour. No brand mesh and no glows (the mesh colours are still
  computed). Over a photo the scrim is neutral near-black, never a brand wash.
- **Rule, pictures:** the AI still places the cover's (and an opening's) picture. Noted brand pictures that no slide
  uses become *spare pictures*. They never include a picture the outline planned for a slide (`DeckDoc2.planned`), one
  with lettering, a cut-out or the logo. The layout places them in a fixed order:
  1. Behind the numbers (`figures` only; a wide picture; dark ones first), under a 76 % veil with white type.
  2. Beside the about, as the right half (light ones first).
  3. Beside the closing, as the right half.
  A spare picture on the closing replaces the AI's accent there. The deck says nothing about what a picture shows, so
  no fact is implied.
- **Rule, no pictures:** the drawn cover sets the headline at 152 px (one step down to 128) from the top left. The
  company's first letter, set at 1,000 px in a 10 % tint, bleeds off the bottom-right corner as a graphic (text role
  `graphic`, which the review does not read as type). A closing without a picture mirrors it.
- **Rule, slides:**
  - **Pains** (`needs` grid, up to four, no tags): the title in white on a block of the feature colour on the left,
    the pains as rows on the right (icon, a 48 px head, a 30 px line). There are no numbers, because pains have no
    order.
  - **About:** with facts, two columns: the statement at 68 px on the left, the facts as a ledger with 52 px values
    on the right. Without facts, the statement at 100 px in the middle.
  - **Offers and products** (`grid`): open columns with no boxes. Each has the icon on a tinted tile, a rule, a
    48 px name and a 32 px line, in two columns for four items.
  - **Process:** numbered steps on one rule (120 px numerals, 44 px heads, 30 px lines). The chevrons are gone.
  - **Quote:** on the feature ground. When the next slide is the dark closing, it goes on the content ground with a
    feature-colour block on the left that carries a large quote mark.
  - **Customer names:** set as big words (44–60 px).
  - **Titles:** 72 px (one step down to 60) in a 1,560 px box.
  - There is no label over a title, and the footer stays "company · section" and "NN / TT".
- **Why:** the glows read as stock gradients, the chevrons as a 2010 template, and the white slides with small type
  as plain. A real company deck carries the company's own pictures. Without them, colour blocks and one large letter
  in the brand's colour give the deck a face, with no clip-art.
- **The example:** made on the invented office-plant subscription 숲틈 / Soopteum (examples/data/soopteum). Its intro
  has services, numbers, a process and a quote. Four photos from Wikimedia Commons (three CC0, one CC BY 2.0, listed
  in images/SOURCES.md and NOTICE) stand in for its own brand pictures. The slides are filled in the tool's slots
  from the intro and laid out by the server's own code (scripts/intro-deck-example.ts). The picture shows the cover,
  the about and the numbers. The other examples stay on 예시커피, and the viewer names the deck's company
  (SkillExampleViewer.tsx `EXAMPLE_COMPANY_BY_SKILL`).
- **Left out:** customer logo rows. The `proof` slide carries names only; logos would need a new slot in the tool's
  schema and SKILL.md, so they are left for a later change. The SKILL.md text is unchanged, so its example hash stays.
- **Tests:** tests/unit/b-intro-deck-figures.test.ts covers the spare pictures, the cover box and the closing; the
  review, build and file tests are unchanged.
- **Version impact:** patch. The decks look different; there is nothing new to set.
