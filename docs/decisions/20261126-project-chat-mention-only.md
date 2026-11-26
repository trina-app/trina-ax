# Project chats tell nobody of others' messages; only a mention notifies

- Date: 2026-11-26
- Status: accepted
- Supersedes: the "Rule (project chats)" and "Known difference" parts of
  [20261122-project-chat-notices-threads-mention-only.md](20261122-project-chat-notices-threads-mention-only.md); the
  "Kept" project-chat part of [20261122-ai-session-no-main-mention.md](20261122-ai-session-no-main-mention.md); the
  project part of the scheduled-answer rule in [20261123-ab4-asks-left.md](20261123-ab4-asks-left.md) (AB4)
- Branch: fix/project-chat-mention-only (the owner, 2026-11-26, after a notice for a teammate's new AI chat in a shared
  project: "안읽음 표시 안해도 될거 같고, 나를 멘션했을때만 가면 될듯? 내 세션을 이어서하는것도 아니고.. 이어서 해도
  표시는 안해도 될 것 같은데")

- **Ask:** a teammate starting or continuing an AI chat in a shared project is not my conversation; it should not mark
  anything unread or notify me. Only a mention of me should.
- **Rule:** in a team project's shared AI chat, someone else's message (a new chat, a chat I wrote in, Trina's answer,
  a scheduled run's answer) gives nobody a notice: no unread number or mark on the row, the project page or the Projects
  rail, no app-icon count, no push, desktop notice, sound or Activity row (`chat/message-notices.ts`
  `isConversationRow` is now a chat shared with people only). What still reaches me there is a thread under an AI
  answer: an @mention of me (docs/decisions/20261118-chat-thread-mentions.md) rings, pushes and shows in Mentions &
  threads as before, and so does a reply in a thread I follow while my thread switch is on ("Unchanged" below). The
  asker keeps their own "answer ready" notice (notifications/chat-answers.ts).
- **Mute:** "Mute this chat" is not offered in project chats any more (nothing to mute); a stored mute there is
  harmless and stays.
- **Old data:** the row, the unread list (`GET /api/chats?unread=1`), the push badge and the realtime fan-out read unread
  numbers only for chats shared with people, and a push checks the chat kind before it goes, so no old project number
  shows. Migration 457 marks old unread project-chat notices read and cancels their waiting pushes.
- **Unchanged:** chats shared with people (#339), team chat rooms (a project's linked room too), DMs and every thread
  rule: "Replies in threads I'm part of" keeps its default, on since
  [20261123-thread-replies-default-on.md](20261123-thread-replies-default-on.md), so a reply in a thread I follow (I
  wrote its root, replied or was mentioned) still rings me; turned off, only a mention does.
- **Tests:** tests/unit/b-project-chat-message-notices.test.ts (rewritten), b-shared-chat-message-notices.test.ts and
  the room notice tests unchanged; web/test/unit/project-chat-row-menu.test.tsx, nav-menus.test.tsx.
- **Version impact:** minor (a changed notice rule, a menu item removed, a data migration).
