# Question cards wait as long as it takes; a to-do card like Claude Code's TodoWrite

- Date (UTC): 2026-11-18 22:00
- Branch: `feat/questions-wait-and-todo-card`
- Status: done
- Where: Team AX core (server/src/chat, shared/src/api, web/src/components/chat). Why: chat and the AI's tools are core.
- Version impact: minor (a new table, a new tool, a new card)

## Goal

QA TC-5005 and TC-5007 (limits audit items 15 and 19). Claude Code is the floor:

- Its AskUserQuestion waits for the answer as long as it takes. Ours (ask_user) waits 10 minutes inside the tool call
  (the engine process stays up meanwhile), then the card closes and the AI goes on with `{"skipped": true}`; an answer
  after that gets "This question was already answered or has expired."
- Its TodoWrite keeps a live checklist the person sees. Ours denies TodoWrite and has no plan tool.

## Scope

In:

- ask_user of the main AI in a chat a person watches: the card is saved (new table `open_questions`), the tool returns
  at once telling the AI to end its answer, the turn ends, nothing is held (no slot, no engine). The card stays under
  the answer with no time limit, after a reload and after a server restart. The answer (card or message box), even
  hours later, starts a new turn in the same chat whose user message is the answer; Claude resumes its session there
  (the session ends on the asking answer), the other engines get the history; the engine message says which question
  it answers. Several questions of one answer: the turn starts when the last one is answered. Any other message sent in
  the chat closes the open questions.
- `todo_write { todos: [{ content, status, activeForm? }] }`, our own tool on every engine (the same input as Claude
  Code's TodoWrite, which stays denied in the lockdown: one tool, one card everywhere). No step per call: one todo
  step per answer, replaced in place on each call, kept with the answer. The web shows it as a checklist card.

Out:

- The server's own safety cards (delete, share, save where more people see it, browser site, connect_service) still
  wait inside their tool call with the admin's time limit: their answer decides what that same call does.
- A question asked from Slack and a scheduled run keep today's behaviour (Slack: the answer must go back to Slack from
  the same turn; scheduled: nobody watches, no card).

## Steps

1. Migration 423: `open_questions` (request JSON, chat, answer message, turn, user, created_at, answers so far).
2. `server/src/chat/open-questions.ts`: save, list, answer, close on another send, the engine-message note.
3. ask_user (chat/tools.ts): the deferred path; routes/chats.ts list and answer; runtime waitsForPerson and the push.
4. `todo_write` in chat/tools.ts, Step.todos in shared, a hidden step per call, one todo step per answer.
5. Web: TodoCard (shared components), Steps skips it; screenshots 1440/390 light/dark.
6. Tests: deferral, answer hours later (no live turn), restart, several questions, superseded, todo card in place.

## Decisions

docs/decisions/20261118-questions-wait-and-todo-card.md.

## Risks

Many tests answer an ask_user card inside the same turn: they move to the new flow. Shared chats keep the wait inside
the call (see Result).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, b-chat, b-session-markers, b-shared-chats, the new
open-questions and todo tests.

## Result

Built as planned, with two changes found on the way:

- Shared chats (project or people-shared) keep the wait inside the call: there the answer would become a user message
  everyone reads, where a card's answer has stayed with the person who gave it (tested by b-shared-chats).
- An answer given while the asking answer is still writing its last line is taken (not "an answer is in progress"):
  the runtime starts the next turn when that answer ends (ChatRuntime.startAnswered).
- Skip on the card goes on as "(Skipped the question)", the AI reading `"skipped": true` as before.

Real AI on a copy of the QA team: the question card stayed open after the answer ended (14 s), survived a server
restart, and the answer "Casual" started the next turn that saved the note; a 5-file job kept one to-do card that
ended with all five done.
