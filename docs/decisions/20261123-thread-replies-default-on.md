# "Replies in threads I'm part of" is on by default, as in Slack

- Date: 2026-11-23
- Status: accepted
- Supersedes: the default "off" of "Replies in threads I'm part of" in
  [20261122-project-chat-notices-threads-mention-only.md](20261122-project-chat-notices-threads-mention-only.md)
  ("Rule (threads, everywhere)"); the rest of that decision stands
- Branch: fix/thread-replies-default-on (the owner, 2026-11-23, asked directly: "슬랙처럼 기본 켜기")

- **Ask:** after a root "@depras …" with six replies got depras nothing
  ([20261123-thread-follow-root-mention.md](20261123-thread-follow-root-mention.md)), the owner chose Slack's default:
  a reply in a thread I follow notifies me.
- **Rule:** "Replies in threads I'm part of" (notification_preferences.room_thread_replies) is on by default, in rooms
  and in chat threads. A reply in a thread I follow (I wrote the root, replied, or was mentioned in the root or in a
  reply) is a notice that rings: push, desktop notice, sound. Turned off, such a reply is a quiet row in Mentions &
  threads (rooms) or an unrung notice (chat threads), and only a mention rings. Who follows is unchanged: people who
  follow nothing get nothing, "@everyone" in a root makes nobody follow.
- **Data:** migration 449 turns the switch on for everyone, undoing migration 437's turn-off. The table keeps no time
  of a save, so a person who turned it off on purpose after 437 cannot be told apart: they are turned on too and can
  turn it off again. A person with no saved settings reads it as on (server and web).
- **Tests:** tests/unit/b-rooms-thread-root-mention.test.ts, b-rooms-notify, b-project-chat-message-notices,
  b-chat-thread-mentions; web/test/unit/room-notify.test.tsx.
- **Version impact:** minor (a changed default and a data migration).
