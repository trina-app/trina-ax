# A late answer to a card resumes the waiting call, as asked

- Date (UTC): 2026-11-22 16:14
- Branch: `fix/late-card-answer-resumes` (on `fix/always-allow-holds-everywhere`, PR #403, which holds
  `fix/connector-always-allow`)
- Status: in progress
- Where: server (`server/src/chat`, `server/src/integrations/connections`). Why: the card's wait and its replay are the
  server's (docs/decisions/20261119-safety-cards-wait.md).
- Version impact: patch. A late answer now does what the card said; no new screen or setting.

## Goal

QA of #403, shared chat: the first share card shows, the person presses it after the answer ended. The press starts
the next turn, which runs the saved call again (replayCalls). That turn's user message is the button's words ("이번만
허용"), and share_with_person checks "the file is named in the asker's own message" against that message: the share is
refused, and "항상 허용" on the card is never kept (the call stops before its card). The owner is angry about approving
twice.

The same holds on plain dev, for every waiting tool whose checks read the asking message or the asking turn:
share_with_person (named file, attached file, file made in this answer, the guest-chat Always rule), share_folder,
stop_sharing, post_to_room (once it waits) and fromAsker. And the cards of connectors (call_tool) and post_to_room do not
wait at all: they close after the admin's wait (10 min), the call goes on as "no answer", and the person must ask again
and approve a fresh card.

After this change a card answered at any time runs exactly the waiting call, with its arguments, as the asking turn saw
it, and the person's choice holds, Always allow included.

## Scope

In:
1. **The asking turn's context on replay.** A waiting call is saved with the turn that asked and its user message (a
   card re-raised during a replay keeps the first asking turn). While it runs again, the checks that read "the asker's
   own message" and "made in this answer" read those (`askerMessageId(exec)`, `madeHere(exec, …)`), not the answer
   message. Tools: share_with_person, share_folder, stop_sharing, post_to_room, who_can_open, shared-actions fromAsker,
   explicit-place, folder-access, remember.
2. **A no runs nothing.** A card answered with its no (its last option, a site's deny) or Skip: the call is not run
   again; the AI is told the person said no and nothing was done. (With the asking message on replay, a check that
   skips the card on an explicit ask could otherwise skip it and act on a no.)
3. **Chained cards.** A call with two cards (who to share with, then the share; the shared-connection card, then the
   write) keeps the answers already given with the call, so each card asked once is never asked again (before, the
   second replay met the first card again: asked again, for ever).
4. **Always allow is kept.** The kind of the card's Always allow is saved with the call. A replay whose card took the
   answer keeps it as before (withAlways); a replay that ended before that card (refused, or the card skipped) still
   keeps the person's Always allow for that kind (where it may be offered now: team switch, confidential, guest limit).
5. **More cards wait.** call_tool (connector writes, the shared-connection card, the unsure-tool card) and post_to_room,
   and the other tools whose cards come before any change (from the audit below), join CARD_LATER_TOOLS.
6. **A new message does not close a waiting call's card.** The person typed in the box ("허용해") instead of pressing:
   the card stays, pressable; the new turn's AI is told a card of its earlier call still waits and to point to it, never
   to call the tool again for the same thing. A later press starts its turn from the chat's newest answer (not a branch
   from the asking answer). The AI's own ask_user questions still close as before.
7. **Changed since the press.** A replay whose card reads differently now (a new reason, other people, another file) asks
   again with one line first: "Something changed since you answered. Please check again." That card waits the same way
   (one press). A card that only lost a reason line (fewer paragraphs, same rows and choices) is the same card.

Out: connect_service (its own wait), Slack questions and scheduled runs (wait inside the call), a sub-agent's calls, a
call holding a stored secret (waits inside the call, as before). No web change: the cards already show from the
database and answer through POST /api/turns/:id/answer.

## Steps

1. Migration 443: `open_questions.call_meta` (JSON: asking turn and message, Always kind, earlier answers of the call).
2. open-questions.ts: save and read the meta; closeChatQuestions keeps unanswered call cards (and answered siblings of
   one); `waitingCardsNote`; `declined`; sameCard tolerates a dropped reason paragraph.
3. always-allow.ts: AlwaysPlace.offering, so the card being raised carries its kind.
4. turn.ts: `askedIn` during replay, chained answers, no-replay of a no, the changed line, Always fallback; the
   waiting-card note in the engine message.
5. Tools: the asker's message and turn through the helpers; CARD_LATER_TOOLS grows.
6. routes/chats.ts answerLater: parent = the chat's newest answer.
7. Tests: tests/unit/b-late-card-answer.test.ts (shared chat share late answer with Always kept, connector write late
   answer, post_to_room late answer, a no runs nothing, a typed message keeps the card, a changed card asks again with
   the line, a chained card asked once); update b-safety-cards-wait.
8. Decision file docs/decisions/20261122-late-card-answer-resumes.md; changes/late-card-answer-resumes.md.

## Decisions

docs/decisions/20261122-late-card-answer-resumes.md (amends 20261119-safety-cards-wait.md: more tools, a no runs
nothing, a new message keeps the card, the asking turn's context).

## Risks

- Migration 443: 442 is the highest on #403 and dev's B range is 440; additive (reader 1).
- Security: the replay reads the asking message only for the call that message asked for, with the person's own press;
  every other check runs as the person is now. A no never runs. The explicit-ask skip can only skip a card for a yes.
- A card that stays open across new messages may be pressed much later: every check runs again then, and a card that
  reads differently asks again.
- Connector calls are replayed: the remote service is reached only after the card (audit).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit b-safety-cards-wait, b-late-card-answer, b-share-with-person,
b-post-to-room*, connector tests, always-allow tests, web unit tests; a real check on a private QA copy with claude-code.

## Result

(filled in at the end)
