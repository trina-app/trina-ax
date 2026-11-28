# A new message closes the asker's waiting approval cards, like Claude Code

- Date (UTC): 2026-11-28 18:50
- Branch: `fix/stale-approval-cards`
- Status: done
- Where: server/src/chat (open-questions, runtime, turn, tools), server/src/integrations/connections, shared/src/api,
  web/src (steps). Why: the approval cards and the turn start live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a typed message no longer leaves an earlier approval card open; no new API, table or setting

## Goal

The owner (shared project chat): a Gmail send card was not answered and a new message was typed. The card stayed
open and pressable above the new turn, the chat row kept its "?" mark, and the AI kept saying "cancel the two Gmail
cards above". Anyone pressing 보내기 by mistake later would send a mail nobody meant to send. The card also showed the
attachment as a raw `team-file:projects/…pdf` handle.

Claude Code: typing a new message instead of answering a permission prompt rejects that tool call, and the message is
the reply. Trina should do the same.

## Scope

In:
- The person's own new message (web, desktop, phone) closes their waiting approval cards in that chat (every card kept
  with its call, `open_questions.call_tool`: send, write, share, delete, post, connector, site, schedule, remember …)
  as not done. Their steps say "답하지 않고 넘어가서 하지 않았어요" (Step.outcome.end `moved_on`), the "?" mark goes, and the
  new turn's engine message gets a `<cards_closed>` block: each call declined because the person moved on.
- Shared chats: only the asker's own message closes the asker's cards; another person's message leaves them (decision).
- The AI is no longer told to point at old cards; the waiting note and the tool's waiting result say an unwanted card
  closes by itself when the person writes again.
- A connector card shows an attached team file by its name and place on every line, never `team-file:<path>`.

Out:
- Cards that wait inside a running answer (connect_service's sign-in, a write over 1 MB, a sub-agent's call, Slack
  and scheduled runs): the answer is still running; a typed message waits under it as before, and Stop closes them.
- The AI's own ask_user questions: unchanged (any turn closes them; another person's message names the asker).

## Steps

1. open-questions.ts closeChatQuestions: a `movedOnBy` person; that person's waiting call cards on the branch close
   (answered siblings of the same answer too: nothing of that answer ran). Return the tool and asking message.
2. runtime.ts createTurn: `movedOnBy` only for a person's own typed message in an app they watch (not an answer to a
   card, a scheduled run, Slack or a server turn); settle each closed card's waiting step (`moved_on`), tell the apps,
   pass the closed calls to the turn (TurnSpec.movedOn).
3. turn.ts: the `<cards_closed>` note; waitingCardsNote and CARD_LATER_NOTE reworded (no "press the card above").
4. shared StepOutcome `moved_on`; web Steps words in six languages.
5. connections/tools.ts: card lines whose value is an attached file's handle show the file's name and place.
6. Decision file, changes note, tests.

## Decisions

docs/decisions/20261128-stale-approval-cards.md. Changes "A new message keeps the card" in
docs/decisions/20261122-late-card-answer-resumes.md.

## Risks

No migration. A race between a press and the new message: both run synchronously against SQLite (recordAnswer and
createTurn are transactions), so one wins whole: the press first starts its turn (the message waits, 409/queued), the
message first deletes the card (the press gets 409 "already answered"). A pressed card whose call runs again is in a
running turn, which no new message can start beside.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`; tests/unit/b-late-card-answer (new message closes,
declined result, the badge, the race, a running approved call, Stop), b-shared-chat-opposite-requests (another person's
message keeps the card), b-safety-cards-wait, b-open-questions, the connector card's file line; web unit; a chat e2e at
1440 and 390. Under Bun 1.3.12.

## Result

Built as planned. Two additions: the web shows a moved-on step with the quiet "not answered" mark (a dashed circle, not
a check), and the web mock scripts the flow ("latecard") for an e2e at 1440 and 390. The words are neutral ("the chat
moved on without an answer") because the others in a shared chat see the step too. The exact call behind 자세히 on a
connector card still shows the handle as sent; every labelled line names the file. PR: see the branch's PR into dev.
