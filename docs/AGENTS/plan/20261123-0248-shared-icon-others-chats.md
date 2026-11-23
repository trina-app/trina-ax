# Shared chats made by others show the people icon too

- Date (UTC): 2026-11-23 02:48
- Branch: `fix/shared-icon-others-chats`
- Status: in progress
- Where: web (history rows). Why: a chat someone else shared with me showed only its creator's face and no people icon (docs/REPOSITORY-RULES.md)
- Version impact: patch, a display fix with no API or data change

## Goal

Every chat shared with people shows the same people icon after its title, whoever made it. Today a shared chat someone
else wrote in has their faces at the row's end in place of the icon, so "my" shared chats have a group mark and the
others have none. The creator's face (and name on a project page) stays at the right.

## Scope

In: `ChatItem` (Home 트리나 기록, sidebar TrinaList, HistoryList, sections, phone drawer all draw it) and the project
page's `ProjectChatRow`. Same `SharedIcon` (aria "chat.sharedLabel"), no new wording.
Out: search dialog rows (faces only there, no icon for any chat), the API.

## Steps

1. Draw `SharedIcon` whenever the chat is shared, also when faces show.
2. Unit test that the two row components no longer hide the icon behind `faces`.
3. Screenshots at 1440 and 390, light and dark; typecheck; check:prepush.
4. changes/ note; QA sheet rows; PR into dev.
