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

## Result
Measured at 390 px: the text has 225 px beside the mic and Stop; the old hints took 2-3 lines (box 72-98 px instead of
46). New hints, all one line: en "Sends after this answer" / "Choose above first", ko "답이 끝나면 보낼 메시지" /
"먼저 위에서 골라 주세요", id "Dikirim setelah jawaban" / "Pilih di atas dulu", ja "回答後に送るメッセージ" /
"先に上で選んでください", es "Se envía tras la respuesta" / "Elija arriba primero". `composer-hint-phone`,
`send-queue`, `ask-answer`, `composer-align`, `composer-paste-preview` e2e 29/29 (Chromium); typecheck, check:i18n,
check:docs pass.
