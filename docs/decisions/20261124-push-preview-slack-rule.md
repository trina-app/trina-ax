# Phone notifications show who, where and the message by default

- Date: 2026-11-24
- Status: accepted
- Supersedes: none
- Branch: fix/push-preview-slack-rule (the owner, 2026-11-24)

- **Ask:** the owner's phone sometimes showed only "새 메시지가 왔어요" with no content: "그냥 다 보여주면 안되냐…
  슬랙룰 따라가자." The common messenger rule: a notification says who sent it, where, and a preview of the text; each
  person can turn the preview off.
- **Rule:** a phone notification of a person's message (a room or DM, a chat shared with people, a project chat, a
  reply in a chat thread, an @mention) has the title "<who> · <where>" ("민준 · #마케팅 › 스레드", "민준 · Launch plan",
  a DM "민준") and, while the reader's **Show message preview in notifications** is on (the default, migration 275's
  `message_preview`), the message as one plain line of at most 200 characters (every line of it, not only the first).
  A message with only files says what was sent: "Sent a photo", "Sent 3 photos", "Sent a file: report.pdf",
  "Sent 2 files". Preview off: who and where only, never the text or a file's name.
- **How, with no gateway deploy or store release.** The phones that are out there already ask their own team for the
  words of every `room.*` push (the iPhone's notification extension since 1.0.1, Android's label service with
  push-label-v1). The team server now sends a person's message in a chat as `room.chat_message` and a chat thread reply
  as `room.chat_thread` (push-native.ts `nativeCode`), and the label route answers them. The gateway, Apple and Google
  still see only ids, a code and the generic words; the text goes from the team server to the person's own phone over
  https. The phone's own lock-screen setting (iPhone "Show Previews", Android "sensitive notifications") decides
  whether a locked screen shows it, as for every messenger.
- **Never a secret.** No text when it looks like a password, an API key or token, a card number or a one-time code
  (the same detector the AI's memory uses, chat/auto-memory.ts `secretIn`), or holds a stored connection secret of the
  writer or the reader (the redactor fails closed). The generic line shows instead. A chat title that looks like a
  secret is left out of the title. A file in the team folder is never named (each person sees those by their own
  access). A scheduled answer is checked again at the ask: hidden from the reader now (a place it read they no longer
  may), no words at all.
- **Confidential chats.** A confidential conversation (safe operations 1A) is never shared with people, so it makes no
  message push; its own "Trina answered" push stays generic. As a guard, a chat marked confidential never sends text. While the team runs safe operations (`MYCEL_SAFE_OPS_1A`,
  every conversation confidential), no notification carries text: who and where only. Why: a team that turned that
  mode on asked for the strictest handling, and a lock screen is outside the team server.
- **Left out on purpose:** the own-AI-chat notice (`chat.answer_done`, a status line, not someone's message), file
  shares and access requests (they name no message), browser and desktop notifications (unchanged), a private room
  message shown to one person (unchanged: no text).
- **Still generic, and why (not fixable on the server):** the phone could not ask in time (5 s on the iPhone, 4 s on
  Android, and Android skips asking for a minute after a team did not answer); a team address that is not https (a
  self-hosted team on a local http address: the apps ask only https); an Android app without push-label-v1 (1.0.10 and
  older); the iPhone before its first unlock after a restart; more than 30 asks a minute from one phone.
- **Older phone apps:** an iPhone app without the extension or an Android app without push-label-v1 shows the
  gateway's "You have a new message" for a chat thread reply, where it said "Someone replied in a thread".
- Tests: `tests/unit/push-preview-slack-rule.test.ts`, `tests/security/push-preview.test.ts`, the wire code in
  `tests/unit/b-shared-chat-message-push.test.ts` and `b-shared-chat-main-mention.test.ts`.
- Version impact: **minor** (what phone notifications show; no migration, no new API field).
