# Shared chats show teammates when an answer waits for someone's confirmation

- Date (UTC): 2026-11-23 17:11
- Branch: `fix/shared-chat-waiting`
- Status: done
- Where: Team AX core, `server/src/chat`, `shared/src/api`, `web/src`. Why: chat and its permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in what a shared chat tells its members; one optional API field, no migration

## Goal

User feedback: only the asker sees a permission card, and teammates just read "[name]'s question is being answered".
While the AI is stopped on a card for person A, everyone else in a shared or project chat sees "Waiting for A to
confirm" within a couple of seconds, and the right state again once it is answered, times out or is cancelled.

## Root cause (reproduced with the fake engine, two accounts)

1. A question or safety card that outlives its answer (`open_questions`) has no running turn, so `shared.answering` is null: teammates see nothing.
2. A card for one desktop window is not counted by `waitsForPerson`, and its open and close are published to that window only.
3. The step line of a card tool (`ask_user`, a command, an address, a service) repeated the card's content to everyone.
4. `answering.waiting` asks "does anyone's card wait" but prints the runner's name, so a kept card of A under B's turn can name B.

## Scope

In: one server answer to "who does the AI wait for" for every card kind; the composer note; the history, sidebar and phone drawer marker (not counted as needing me); live update, reload, reconnect, two windows, offline.
Also in: other members read only the verb of a step line that repeats a card; file steps keep their existing path rule.
Out: who may answer a card; what a message sent meanwhile does to an open card (a teammate's message still closes an open AI question, as before).

## Steps

1. `ChatRuntime.waitingOn`: the person a live or saved card waits for, only someone still in the chat.
2. `Chat.waitsFor` (a name, never for that person), in chat views and marks; `answering.waiting` only when it is the runner.
3. Tell the other members when a one-window card opens or closes.
4. Composer note and a still, uncounted row marker.
5. Tests, including that no card content reaches other members; browser check with two accounts.

## Decisions

None beyond this plan: the name is the only thing told, as `shared.answering` already does.

## Result

`Chat.waitsFor` carries the name only. Checked with two accounts in a browser on a local server (live, reload, reconnect, asker offline, answer, 1440 and 390), and by tests for every card kind, timeout, stop, one-window cards and no card content reaching others.
