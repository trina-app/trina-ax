# A failed step the AI got past is not red

- Date (UTC): 2026-11-07 09:34
- Branch: `fix/steps-recovered-errors`
- Status: done
- Where: Team AX core, `web/src/components/chat/Steps.tsx`. Why: the step list under an AI answer is core chat UI (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a visible UI change (the red marks on recovered steps go away); no API or data change

## Goal

The steps list under an answer shows a red ⓘ on every step that ended in an error, and the folded header ("작업 N단계")
gets a red mark when any step failed. Most of these are the AI's own trial and error that it fixed in the same answer:
it guessed a file name that does not exist and then found the right file, or a tool call failed and the next one
worked. The product owner: "뭔가 오류 나니깐 우리 잘못 같아". Red reads as the product failing. Consumer AI apps do not
alarm on that.

After this change a failed step the AI got past gets a quiet neutral mark that says, in its tooltip and to screen
readers, that the AI went on another way; red stays for what did not get done.

## Scope

In:
- The rule, as one pure function in `Steps.tsx`: a step with `status: 'error'` (not paused, not stopped) is red only
  when the answer's status is `error` (this includes an interrupted answer, which ends as `error`). While the answer
  runs, and once it is done or stopped by the person, it is neutral. When a running answer then fails, its failed steps
  turn red.
- The neutral mark: a muted icon, the shared Tooltip and aria-label saying the AI went on another way (finished) or is
  trying another way (still running), in all five languages (see Result for the final icon and words).
- The folded header: the red "some steps failed" mark only for a failed answer.
- Expanding a step shows its detail as before.
- `Messages.tsx` passes whether the answer failed.
- Unit tests for the rule; existing tests and e2e updated; a mock scenario ("wrong-guess") for e2e and screenshots.

Out:
- A person-action distinction per step: `Step` carries no error code (only `status`, and a free-text `detail` on a few
  tools); connections needed go through the connect card, and usage limits end the answer as an error. So the rule is
  "red only when the answer failed".
- Rooms: the room's AI status (`RoomAiStatus.tsx`, also in the thread panel) shows only the current step in words and no
  step marks, and room answers show no steps, so nothing changes there. The phone layout uses the same `Steps`.
- A scheduled run's outcome ("problems" when any step failed, `server/src/chat/schedule-outcome.ts`) is server-side and
  stays as it is.

## Steps

1. Plan (this file).
2. Mock scenario "wrong-guess" (a failed read of a wrong file name, then the right file) for e2e and screenshots; before
   screenshots at 1440 and 390, light and dark.
3. `Steps.tsx`: `stepMark()` / `showsFailures()` rule, neutral mark with Tooltip, header rule; `Messages.tsx` passes
   `failed`.
4. i18n keys in five languages.
5. Unit tests (rule and render), e2e in `chat.spec.ts`, update the old expectations.
6. After screenshots, independent UX review, fixes.
7. CHANGELOG, DECISIONS line, checks.

## Risks

- Hiding a failure that matters: a failed write the AI did not redo. The answer then says what happened, the row stays
  in the list with its mark, and a failed answer keeps the red. The independent review checks this.
- No migration, no API change. Five languages. Phone: the tooltip does not show on touch; the mark is neutral, the
  aria-label stays.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run --cwd web build`, web unit suite in Docker
(bun 1.3.12), the related e2e specs (`chat.spec.ts`, `answer-limit.spec.ts`, `steps` specs).

## Result

Built as planned, with the rule refined after the independent review (two rounds):

- A failed step is quiet (grey `CircleMinus`, tooltip and name "안 됐지만 {ai}가 다른 방법으로 이어 갔어요") when the
  AI got past it: for a look-up, any later step of the same agent or the main AI that worked, or its finished
  sub-task; for a step that would have changed something, a later call of the same kind that worked (the save tools
  are one kind). It is quiet in finished, stopped and failed answers, while the answer runs ("…찾고 있어요" until
  something after it works), and for a failed look-up under an answer that did not fail.
- Red stays for a failure nothing got past (a save, a send, a change; the step a failing answer ended on) and for a
  dev environment command that did not run because it was full. A cancelled command gets a muted stop mark.
- Differs from the plan: "red only when the answer failed" became "red when nothing got past it", because the first
  version hid a failed save under a finished answer and pointed at a recovered step in a failed one. The read-only tool
  list moved to `shared` (`READ_ONLY_TOOLS`, also the Explore helper's tools). A row with nothing to open is now a
  plain row, not a disabled button, so the mark's tooltip gets the pointer. The icon is `CircleMinus`, not
  `CornerDownRight` (which read as a nested step on phones).
- Follow-ups for the owner: a scheduled run's outcome still counts every failed step; a declined confirmation is still
  a plain error step (red when nothing of its kind worked after it).
