# A mention in a shared chat's main box is a row under Mentions

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "Left out" line of docs/decisions/20261122-shared-chat-new-message-notices.md, for mentions only
- Branch: fix/f3-mention-share-narration (final rerun QA TC-f3-02)

- **Ask:** an @mention picked in a shared chat's main message box was pushed and marked the chat row with "@", but the
  person's Mentions tab stayed empty, while a thread reply's mention is listed there.
- **Rule:** a person's message that mentions me (chat_message_notices, kind 'message', mention 1) is a conversation row
  on 대화's 멘션·스레드 under Mentions (and All), like a thread reply that mentions me: who mentioned me and the chat's title
  while I see the chat and the message is there (else "You can't see this anymore."), opening the chat at the message.
  It counts with the conversation rows (roomUnreadCount), never with 활동's own notices. Reading it (the row, Mark all as
  read on All or Mentions) reads that notice and cancels its waiting push; opening the chat reads it as before.
- **Left out:** plain messages (no mention) stay unlisted: the chat row's number shows them.
- **Tests:** tests/unit/b-shared-chat-main-mention.test.ts.
- **Version impact:** patch (a fix; an optional field on the notice, no migration).
