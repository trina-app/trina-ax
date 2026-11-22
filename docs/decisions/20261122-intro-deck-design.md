# The intro deck: flat grounds, an eyebrow, a big drawn cover, numbered figures

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: feat/intro-deck-design (the owner, on the 회사 소개서 example)

- **Ask:** "If we keep the intro deck, the example has to be done properly. Right now it's too tacky and too plain."
- **Rule:** every ground is one flat colour: no brand mesh and no glows (the mesh colours are still computed, so a
  later change can bring them back). Content slides carry an eyebrow in the top margin, the slide number in the accent
  and the section name ("02  회사 소개"); the running footer is the company and "NN / TT". The drawn cover (no
  picture, no accent) sets the headline at 152 px (one notch down to 128), anchored low, with the company and the
  deck's label on one row at the top and the deck's contents (the middle slides' section names) beside the headline
  when it leaves room; the deck's pattern stays in the top right corner. A closing with no contact details mirrors the
  cover. Figures: a grid of pains (`needs`, up to four, no tags) is set as statements: the icon, a short rule, the head large and a
  line, with no numbers (pains have no order; numerals stay only where order is real: the process and the slide
  numbers); a grid
  of offers or products is tinted panels with the icon on a tile and the words at the panel's foot; a flow is numbered
  steps on one rule (the chevrons are gone); stat numbers go up to 184 px (three in a row); a quote sits in the middle
  of the slide with the speaker after a short rule.
- **Why:** the glows and the mesh read as stock gradients, the chevrons as a 2010 template, and the content slides as
  the same bullet slide with a different title. Type, one accent and whitespace carry a modern deck.
- **The example:** made on the invented office plant subscription 숲틈 / Soopteum (examples/data/soopteum), whose
  intro has services, numbers, a process and a quote; the slides are filled in the tool's slots from that intro and
  laid out by the server's own code (scripts/intro-deck-example.ts). The other examples stay on 예시커피. The viewer
  names the deck's company (SkillExampleViewer.tsx `EXAMPLE_COMPANY_BY_SKILL`).
- **Left out:** pictures and logos in the example (the company has none); the SKILL.md text (unchanged, so its
  example hash stays).
- **Tests:** tests/unit/b-intro-deck-figures.test.ts (the eyebrow and the footer; one key per flow), the review and
  build tests unchanged; web onb6-skills (the deck's invented company).
- **Version impact:** patch (the decks look different; nothing new to set).
