# Chats are grouped by team categories that admins make, not by personal folders

- Date: 2026-11-20
- Status: superseded by [Each person sorts their own Chats list into sections](20261121-personal-sidebar-sections.md)
- Supersedes: the room kind of [List folders](../DECISIONS.md) on screen (the personal "Conversation folders")
- Branch: feat/shared-chat-categories (the owner)

- **Ask:** "remove the folder features … admin can create the category and it's showed for all users".
- **Rule:** the team has one list of conversation categories. Admins and the owner make, rename, order and delete them
  and put channels in them (a channel's "⋯" → Move to category). Everyone sees the same categories in the same order,
  between Pinned and Channels, each holding the channels of it they are in; a category with none of their channels is
  not shown to them (an admin sees it, empty, to fill it). Only channels go in a category (the everyone room, team rooms,
  named private channels); a 1:1 or an unnamed group chat stays personal (409 room_category_personal). Deleting a
  category only takes its channels back to Channels. A category never changes who is in a channel.
- **Why:** each person sorting the same channels alone repeated the work and gave every teammate a different sidebar.
- **Left out:** the personal room folders are hidden, not deleted (their API and rows stay until a cleanup); Trina's own
  AI-chat folders are unchanged; DMs in categories.
- **Tests:** tests/unit/b-room-categories.test.ts, web/test/unit/nav-folders.test.tsx.
- **Version impact:** minor (a new feature).
