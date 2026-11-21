# Japanese, Spanish, Indonesian: the project room uses each language's conversation word

- Date (UTC): 2026-11-21 06:20
- Branch: `fix/room-terms-ja-es-id`
- Status: in progress
- Where: web/src/i18n/{ja,es,id}.ts, server/src/chat/i18n.ts and server/src/onboarding/form-skill.ts (ja/es/id),
  docs/site/{ja,es,id}/use/chats-and-projects.md (the project-room section).
- Version impact: patch (wording only; no keys, no English, no behaviour)

## Goal

Follow-up to #192 (Korean 대화방). The project room still says チャットルーム / sala de chat / ruang obrolan, words used
nowhere else in those files. Each file already calls a conversation room トーク / conversación / percakapan (the
Conversations list, search, room info), and Slack's Japanese and Spanish help say 会話 / conversación for its
conversations (Slack ships no Indonesian). Use the file's own word everywhere.

## Steps

1. ja: チャットルーム, ルーム → トーク. es: sala de chat, sala → conversación. id: ruang obrolan, ruang → percakapan.
   Also the few generic "room" nouns in server/src/chat/i18n.ts (the everyone room, "everyone in this room", the
   several-matches question) and the form skill's save line.
2. zh stays: its glossary (scripts/check-i18n.ts, 0.5.10 translation review) says 聊天室 for rooms.
3. The project-room section of the ja/es/id help page, with the new button name.
4. check:i18n, typecheck, check:prepush, web unit tests that read these strings.
