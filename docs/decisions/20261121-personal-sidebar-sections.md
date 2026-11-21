# Each person sorts their own Chats list into sections, as in Slack; team categories leave the UI

- Date: 2026-11-21
- Status: accepted
- Supersedes: [Chats are grouped by team categories that admins make](20261120-shared-chat-categories.md)
- Branch: plan/sidebar-categories-redo (the owner)

Plan: docs/AGENTS/plan/20261121-0114-sidebar-categories-redo.md.

- **Ask (owner, 2026-11-21):**
  - After a team category "Bots" said "아직 채널이 없어요" with no way to fill it: "사람마다 자기 사이드바를 따로 정리하는
    기능이어야해. 슬랙이랑 똑같이 가야해 우리는" (each person organizes their own sidebar, the same way as Slack).
  - Then: "그냥 라카꺼를 빼고 UI만 바꾸면 될 것 같은데?" (take out the team categories and change only the UI).
- **Rule:**
  - Everyone, guests too, sorts their own Chats list into **sections** ("섹션"). These are the personal conversation
    folders (kind `rooms`, migration 289), shown again. Nobody else, owners and admins included, sees them.
  - Channels, DMs and group DMs can go in. A section never changes who is in a conversation.
  - **Create:** New section is in the Channels "+" menu, and New section… is in every Move to section menu. You can add
    conversations right after creating a section.
  - **Fill:** a conversation goes in by dragging with a mouse (in, between sections, and out onto the Channels or Direct
    messages header). It also goes in by Move to section in the row "⋯", the phone long-press sheet and the
    conversation header "⋯", or by the section's Add conversations.
  - **Empty:** an empty section says how to fill it and has a button.
  - **Manage:** a section's "⋯" has Add conversations, Rename, Move up / Move down and Delete. Delete sends its
    conversations back to Channels and Direct messages.
  - **Layout:** each section is a top-level header between Pinned and Channels, and folds like the others
    (20261116-collapsible-chat-sections).
- **Team categories:**
  - Removed from the web, with no conversion: an existing category is made again as a section.
  - The server keeps their routes and tables unused until a later cleanup (migrations stay additive).
- **Why:**
  - People expect Slack's personal sections.
  - The team categories needed an admin, hid the way to fill them, had no drag and did nothing on a phone.
  - The personal folders already worked per person on the server.
- **Left out:**
  - Sort per section (it needs a migration; later, if asked).
  - Emoji.
  - Admin-shared starter sections.
  - The Trina AI-chat folders, which are unchanged.
- **Tests:** web/test/unit/sidebar-sections.test.tsx, web/test/unit/nav-folders.test.tsx, the web e2e sidebar-sections.spec.ts, tests/unit/b-nav-folders.test.ts
  (unchanged).
- **Version impact:** minor (a feature comes back with new ways to use it; no API change).
