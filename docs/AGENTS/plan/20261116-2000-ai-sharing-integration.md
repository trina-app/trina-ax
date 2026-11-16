# AI sharing: integrating the four packages

- Date (UTC): 2026-11-16 20:00
- Branch: `integrate/ai-sharing`
- Status: done (not merged: lands after 0.5.10 is pinned and #1109 merges)
- Where: Team AX core, `server/src/chat/`, `server/src/files/share-fixes.ts`, `shared/src/api/`, web chat components.
- Version impact: minor (with the four packages).

## Goal

Join `feat/ai-share-words` (B1), `feat/ai-share-card-and-stop-clean` (B2), `feat/ai-share-who-can-open` (B3) and
`feat/ai-screen-and-shared-tools` (B4) on top of `batch/prompts-1116`, `batch/1116c` and `dev`, keeping every
behaviour, check and test, and join the seams between them.

## Steps

1. Merge the batches and dev, then B1, B2, B3, B4 in that order; resolve each conflict by reading both sides.
2. One next-step mechanism: the refusal card's button is the step's stored offer (`ShareCardNext.fixId`); not shown
   twice.
3. One `ask_admin` kind with a reason (`folder`, `switch`); the switch case sends the admins the person's own message.
4. Refusal words follow the buttons; one "why it asks" line (`ShareCardAsk.why`).
5. "Already open" on the result record (`StepShared.already`).
6. `fromLook` for stop_sharing.
7. The same-name rule per the owner's decision (TC-4091).
8. Translated user docs; checks; real-AI run on a private QA copy; QA rows.

## Result

See docs/decisions/20261116-ai-sharing-integration.md.
