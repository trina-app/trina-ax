# Final rerun fixes: main-box mentions in Mentions, Share waits for the check, no step narration in the answer

- Date (UTC): 2026-11-22 07:37
- Branch: `fix/f3-mention-share-narration` (off `batch/20261122-i`)
- Status: done
- Where: server/src/notifications, server/src/chat, shared/src/api, web/src. Why: three P2 findings of the final rerun
  of batch 2 (QA TC-f3-02, TC-f3-03, TC-f3-05).
- Version impact: patch (fixes; one optional field added to a notice, no migration)

## Goal

1. TC-f3-02: an @mention in a shared chat's main box reaches the person's Mentions tab (it was pushed and marked the chat
   row, but never listed).
2. TC-f3-03: Share in the share dialog never goes without the files the dialog ticks by default.
3. TC-f3-05: a Korean answer does not start with the English line the AI wrote before a dev-environment command.

## Scope

In: list main-box mention notices (chat_message_notices with mention=1) as conversation rows under Mentions; a test of
the dialog's slow check; the "copied into the call" exemption of interim text skips calls that deliver no words.
Out: listing plain (no mention) shared-chat messages in Activity (still the chat row's number only).

## Steps

1. Root causes: (1) chat_message_notices were "never listed" by design (#339): the mention notice was made with
   mention=1 but the Inbox's LISTED union left the table out. (2) Code reading and the QA screenshots: Share is disabled
   while the check runs and the click came after it; the box was unticked by #355's own rule (files made by answers that
   ran dev-environment commands are marked, a dev answer is a warning). A test pins the order. (3) The line was before a
   box_shell call whose `description` and command share its words: the "piece copied into the call's arguments is
   content" exemption (80% of words) kept it.
2. Server: LISTED takes chat_message_notices WHERE kind='message' AND mention=1; conversation-row filter, counts,
   read by id and Mark all as read (All, Mentions) include them; the notice says who and which chat (chatMessage
   name/byId/title/mention/gone).
3. Web: the row is drawn as a chat conversation row (photo, "@", "{name} mentioned you in …"), opens /c/<chat>/m/<message>,
   counts on 대화; six languages.
4. turn.ts: deliveredArgs: box_shell, Bash and Agent/Task deliver no words, so a piece before them is never "copied into
   the call".

## Decisions

docs/decisions/20261122-main-box-mentions-listed.md (changes the "Left out" line of
docs/decisions/20261122-shared-chat-new-message-notices.md for mentions).

## Risks

No migration. Mention rows add to roomUnreadCount (대화's part), never to noticeUnreadCount; the push badge counts chats
separately (unchanged).

## Tests

tests/unit/b-shared-chat-main-mention.test.ts (main-box mention → Mentions row, push, read), tests/unit/narration-hold.test.ts
(TC-f3-05 turn and deliveredArgs), web/test/unit/chat-share-dialog.test.tsx (slow check); typecheck, check:prepush.

## Result

As planned, plus:
- Review fixes: reading, muting or losing a chat tells the Inbox when an unread mention row goes; the Inbox reads only
  listed chat notices; a command that holds the piece word for word (a heredoc) still keeps it as content; Share's
  retry after a server update keeps the files choice (it went without the files).
- TC-f1c-01 (coordinator, same area): a ✦ side chat question quotes the room message with the app's English labels
  ("(file_id … in this room)"); the answer language now follows the person's own words (no "> " lines):
  languageSwitchNote compares own words and quoteLanguageNote tells the AI.
- TC-f3-03: Share already waits for the check (screenshot and code); the default tick was off by #355's rule (files
  made by answers that ran dev-environment commands are marked). A test pins the order; the retry path was the real gap.
- TC-v2g-03: no change: the raw "chat:files/…" is the stored label (API, logs); the screen's step line already reads
  "이 채팅 › …" (stepPlace).
