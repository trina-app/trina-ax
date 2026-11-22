# A new message in a chat shared with people tells the others, like a group chat

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: fix/shared-chat-new-message-notices (scenario QA TC-7406, TC-r2b-07, TC-r2a-01, TC-r2d-05)

- **Ask:** in a chat shared with people, nobody was told about a new message (only thread replies notified). People
  expect what Slack does for a DM or group DM. Also: "@" a person in the chat's main message box.
- **Rule:** a person's message there gives every other person who sees the chat now (its creator, its people and
  groups; someone added later too; never the sender) a notice of their own (`chat_message_notices`, migration 436): the
  unread number on the chat's row (`Chat.unreadCount`), the one count n (it counts messages, as a group chat in a room),
  a push (`chat.message`) and, in the desktop app, a notification and the room sound. Every message its own notice and
  push, as rooms since TC-5585 (docs/decisions/20261120-push-every-message.md); the desktop notification is one per
  chat. The push follows the room default (Settings › Notifications: "nothing" is off), quiet hours (made inside: never
  pushed) and the away rule, and checks again that the chat is still theirs to see. Not a scheduled run's message, the
  answer to the AI's card or a question asked from Slack.
- **Trina's answers:** the asker keeps the "finished" notice (chat-answers.ts). The others get the unread number only
  (`kind='answer'`): never pushed, rung or told on the desktop, so the chat is not noisy.
- **Mute:** "Mute this chat" (`chat_mutes`) in the row's ··· menu, per person. Muted: no notices at all, no grey count
  (unlike a room at 끄기: lean). A message that mentions them still reaches them.
- **Mentions:** the main box lists everyone who sees the chat but me (a group's people only for the creator and admins
  and for my own groups: S8, never who is in someone else's group), with the rooms' mention box ("@"; no "@everyone":
  every message tells everyone anyway). Picked ids go with the message (`mentions`); the server keeps only those who see the
  chat. A mention's notice reaches a muted chat, the desktop says "mentioned you", the row shows "@".
- **Reading:** opening the chat (POST /api/chats/:id/seen, any viewer) or writing in it reads that person's notices and
  cancels pushes that still wait. Someone taken out by the creator loses their notices and mute; someone who loses the
  chat another way (a group change) keeps their unread notices, made while they saw it, and sees them again if they get
  it back (no push meanwhile: the push checks who sees the chat).
- **Left out:** an Activity row per message (a room's DM message has none either: the chat row shows it), the message's
  text or the sender's name on the phone (the gateway asks the team for words only for room codes and chat.shared: a
  gateway and phone app change), a push delay for a window that has the chat on screen (rooms push at once too; the away
  rule cancels the phone push while the person is at the computer), project-shared chats.
- **Tests:** tests/unit/b-shared-chat-message-notices.test.ts; web/test/unit/session-markers.test.tsx (the number).
- **Version impact:** minor (a new notice kind, a menu item, a migration; additive).
