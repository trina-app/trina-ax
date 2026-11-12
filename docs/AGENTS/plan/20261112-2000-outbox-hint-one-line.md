# Chat: the "next message" hint fits on one line on a phone

QA TC-407 (owner's iPhone): while an answer runs, the empty message box says "Type your next message — it goes when
the answer is done" (`outbox.placeholder`). Next to Stop and the mic the text has 225 px on a 390 px phone: the hint
wraps to 3 lines and the box grows from 42 to 98 px. The hint while a card waits for a choice
(`outbox.placeholderChoice`) wraps the same way.

## Plan
- Shorter `outbox.placeholder` and `outbox.placeholderChoice` in en (source), ko, id, ja and es, each measured in the
  real box at 390 px (Playwright), with room to spare: the plain hint still says the message goes after the answer;
  the choice hint says to choose first (a message typed then still waits, and its line under the conversation says
  "Sends when the answer is done").
- `send-queue.spec.ts` / `ask-answer.spec.ts`: the new Korean text.
- New `composer-hint-phone.spec.ts`: at 390 px, in every language, both hints are one line and the box keeps its
  idle height.
- Changelog fragment `changes/outbox-hint-one-line.md`.
