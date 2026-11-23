# Cards of one answer gather before they can be pressed

- Date: 2026-11-23
- Status: accepted
- Supersedes: none (completes docs/decisions/20261123-batch-cards.md on the real engine)
- Branch: fix/016-gate (AI gate on af66acab5: 3 skills gave 3 stacked cards, a retry 2)

- **Ask:** one card per answer per kind, also when the engine runs its write calls one after the other.
- **Rule:** every file-tool card carries its tool as the group key, and a skill save leads in plain words like a skill
  move (path and diff behind 자세히; a file that does not load or a taken name keeps its whole card). A group of cards
  that wait after the answer takes no press while the answer runs and its latest card is under 8 seconds old, so one
  press covers them all. A card a running call waits on is never held.
- **Why:** Claude Code runs write calls in order, so the cards of one answer arrive seconds apart. A press on the first
  would answer only that one.
- **Version impact:** patch.
