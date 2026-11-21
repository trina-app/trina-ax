# Korean: the project room is 대화방, never 채팅방

- Date (UTC): 2026-11-21 02:22
- Branch: `fix/ko-daehwabang-wording`
- Status: in progress
- Where: web/src/i18n/ko.ts, server/src/chat/i18n.ts (ko), docs/site/ko/use/chats-and-projects.md, Microsoft Store ko listing, one unit test.
- Version impact: patch (Korean wording only, no keys or English changed)

## Goal

#182, #188 and #190 wrote the project room as 채팅방 in Korean. The settled rule (memory naming-decisions, trina-team-chat-project):
no bare 채팅 for people's rooms; people side is 대화 / 대화방. AI chats stay 채팅.

## Steps

1. Replace 채팅방 with 대화방 in the project-room strings (ko.ts, server ko text, ko docs page, store listing).
2. Update the unit test that asserts the word.
3. Report (not change) ja チャットルーム, es sala de chat, id ruang obrolan.
