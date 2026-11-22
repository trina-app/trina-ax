# A mention read in the Inbox updates the chat row; make_file says "moved" before the wider-audience card

- Date (UTC): 2026-11-22 08:17
- Branch: `fix/mention-read-chat-updated` (off `batch/20261122-i` cc98820f1)
- Status: done
- Where: server/src/notifications, server/src/chat, server/src/tools/make-file.ts. Why: two should-fix items of the batch 2 re-review.
- Version impact: patch (fixes)

## Goal

1. Reading a main-box mention in the Inbox (#364) drops the chat row's unread number and "@" at once.
2. make_file (HTML→PDF and the other converted outputs) at a moved file's old place says so before the wider-audience
   card, so the person never approves a card and then hears "Nothing was saved".

## Steps

1. notifications/service.ts read() and readAll(): after a chat_message_notices mention is read, chat.updated to the
   reader for its chat (message-notices.ts tellChatsRead, as POST /api/chats/:id/seen does).
2. make-file.ts: movedFirst before each checkWidening of the converted outputs (markdown, HTML→PDF, deck→PDF, SVG→PNG);
   placeProduced's own check then lets the second call through (told once per answer and place).

## Decisions

none

## Tests

tests/unit/b-shared-chat-main-mention.test.ts (chat.updated on both reads), tests/unit/moved-files.test.ts (no card
before the moved fact; one card on the second call).

## Result

As planned.
