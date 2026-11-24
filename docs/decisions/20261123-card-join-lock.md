# A press covers only the cards that were on screen long enough

- Date: 2026-11-23
- Status: accepted
- Supersedes: none (narrows docs/decisions/20261123-cards-gather.md)
- Branch: fix/016-gate-lock (review of #475: a card that joined at the click was approved by it)

- **Ask:** one press must never approve a card the person did not see.
- **Rule:** when any card joins a group, the buttons wait 1.5 seconds. A press sends only the cards on screen for at
  least that long; one that just joined stays open. Cards that keep arriving lock the buttons for 4 seconds at most, so
  a card with a time limit can still be answered.
- **Why:** the group grows while the person is reaching for the button, and the click lands on a different question.
- **Version impact:** patch.
