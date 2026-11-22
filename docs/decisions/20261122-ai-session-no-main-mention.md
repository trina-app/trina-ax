# An AI chat's main box mentions nobody; people are mentioned in threads on AI answers

- Date: 2026-11-22
- Status: accepted
- Supersedes: [20261122-main-box-mentions-listed.md](20261122-main-box-mentions-listed.md), and the main-box mention part
  ("Mentions", the mute line "A message that mentions them still reaches them") of
  [20261122-shared-chat-new-message-notices.md](20261122-shared-chat-new-message-notices.md)
- Branch: fix/ai-session-no-main-mention (the owner, 2026-11-22: "Shouldn't mention be disabled in shared projects and
  shared sessions? In a shared project session it should only be possible in the threads on AI answers.")

- **Ask:** in a chat shared with people and in a project's shared chat, "@" in the main box opened the member list. A
  test user sent "@dion ㅎㅇ" and the AI answered it, as the main box is where people talk to the AI.
- **Rule:** the main box of an AI chat (any chat with the AI model picker: mine, shared with people, a project's) has no
  "@" member list and sends no mentions. The server ignores `mentions` on a main message (still accepted, so an older
  page's send does not fail): no mention notice, no row under Mentions, no "@" on the chat row, no "mentioned you" in the
  desktop notice, and a muted chat tells nothing (no mute bypass). A person is mentioned in a thread under an AI answer
  (docs/decisions/20261118-chat-thread-mentions.md, docs/decisions/20261122-project-chat-notices-threads-mention-only.md):
  that reply notifies them as before and never starts an AI answer.
- **Kept:** a main message's plain new-message notice for everyone who sees the chat (unread number, push, desktop
  notice, Mute), as decided for shared and project chats ("notify like a Slack channel"). Project chat rooms (대화방) keep
  their own "@" and notices. Messages with "@" written before stay as they are; older notice rows keep their `mention`
  column, which nothing reads now (no migration). GET …/audience keeps `mentionable` (the Files screen's restore confirm
  names those people).
- **Tests:** tests/unit/b-shared-chat-main-mention.test.ts, tests/unit/b-shared-chat-message-notices.test.ts,
  tests/unit/b-project-chat-message-notices.test.ts, web/test/unit/composer-no-main-mention.test.tsx.
- **Version impact:** minor (a visible change in the message box and in Activity).
