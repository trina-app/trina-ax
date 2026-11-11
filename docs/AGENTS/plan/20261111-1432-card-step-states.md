# Card steps show their real state (waiting for a yes, not answered)

- Date (UTC): 2026-11-11 14:32
- Branch: `fix/card-step-states`
- Status: in progress
- Where: `server/src/chat/tools.ts`, `shared/src/step-labels.ts`, `web/src/components/chat/Steps.tsx`. Why: chat
  steps are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a display fix with no new behaviour

## Goal

QA TC-214. Two step lines under an answer did not match what was happening:

1. In a chat that read team files, `remember` asks the person first ("기억할까요?"). Its step already said
   "기억함: …" while the card was still waiting, and changed only after the answer.
2. A question card nobody answered (it ran out after the wait) left its step with a green check. "답하지 않음" showed
   only when the step was opened.

After this change the step says "기억할지 묻는 중: …" while the card waits. A card that ran out shows a quiet mark with
"답하지 않음" next to the line, not a success check.

## Scope

In:
- `remember`: the step's label while the card waits (new step text `rememberAsking`, five languages). The step says
  "답하지 않음" only when there was no answer, not after a "no".
- A shared `unansweredStep` check (the detail is "not answered" in any language, on `ask_user` or `remember`).
- `Steps.tsx`: a mark `unanswered` (grey dashed circle, the words beside the line); such a row no longer opens just
  to repeat those words.

Out: other cards' steps (delete_files, post_to_room and the like keep their own words); the label a running
`remember` shows in a clean chat (it is replaced right away).

## Steps

1. `server/src/chat/tools.ts` remember: when a card is needed, patch the step to `rememberAsking` before waiting. The
   final words go onto the same step by its id (`patchToolStep` patches a step only once), or with the queued patch
   when the step has not started yet. Also on an error while waiting (a stopped turn): "not remembered".
2. `shared/src/step-labels.ts`: `rememberAsking` in `STEP_TEXT`, in `localizeStep`'s remember templates;
   `unansweredStep()`. `server/src/chat/i18n.ts`: the key.
3. `web/src/components/chat/Steps.tsx`: `stepMark` returns `unanswered`; the row shows it.
4. Tests: `tests/unit/b-chat.test.ts` (the step's words while waiting, after yes, after no; ask_user ran out), a web
   unit test for the mark, step-labels tests for the new template.

## Risks

No migration. Older chats: their stored steps keep their words; an old ask_user step with "답하지 않음" gets the new
mark too (that is the fix). Five languages for the new text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/b-chat.test.ts
tests/unit/step-labels-*.test.ts`, `bun run test:web`.

## Result

