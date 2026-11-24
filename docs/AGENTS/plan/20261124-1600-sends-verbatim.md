# A send with no card carries exactly the person's words

- Date (UTC): 2026-11-24 16:00
- Branch: `fix/sends-verbatim` (off `dev`, after #502)
- Status: in progress
- Where: server/src/chat (post-mentions, post-to-room), shared/src/api/entities.ts, web/src/components/chat/PostedCard.tsx. Why: QA of #502 on dev 2bfa9126.
- Version impact: patch: an AI-reworded text is no longer sent without the person seeing it.

## Goal

QA of #502, flow 2a: the request was "운영공지 방에 @전체 공지 올려줘: 내일 회의 10시". In 3 of 3 runs the AI added "(11월 25일)", "오전" and "📢" and reworded the text. One run posted to everyone with no card.

Cause: the no-card path checked the text only for own_words posts. A post of the AI's own text went with no card whenever the place and the request were the person's.

## Scope

In:
1. **Server, every send `post_to_room` makes (room, thread, 1:1, @everyone).** A send goes with no card only when its text, compared strictly (whitespace collapsed, the everyone mention taken out), equals words the person dictated: a quoted stretch, what follows a colon, or the lines after the first. A text that is only links to the files that go also qualifies. Anything else, added or changed, goes on the card. A "don't" inside the dictated words ("늦지마셈") no longer reads as the person taking the request back.
2. **Prompt (the post_to_room description).** Dictated words go exactly as written, typos included, with nothing added. A file with no words goes as its link alone. Pins re-recorded.
3. **Undo** names where the post went, a 1:1 chat's person too.

Out: Always allow (rule A) and a card the person already approved in this chat are unchanged. `share_with_person` carries no text.

## Decisions

[docs/decisions/20261124-sends-verbatim.md](../../decisions/20261124-sends-verbatim.md)

## Tests

do-then-undo (verbatim, typo, mention filled: no card; date, time word, emoji, fixed typo, reworded: card; 1:1), b-post-to-room, b-post-to-room-mentions, share-card (Undo names the place). Real check: 2a five runs per mode, a typo variant, one 1:1 send.

## Result

(after the recount)
