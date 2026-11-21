# Each person sorts their own Chats list into sections, as in Slack; team categories go

- Date: 2026-11-21
- Status: accepted
- Supersedes: [Chats are grouped by team categories that admins make](20261120-shared-chat-categories.md)
- Branch: plan/sidebar-categories-redo (the owner)

Plan: docs/AGENTS/plan/20261121-0114-sidebar-categories-redo.md.

- **Ask (owner, 2026-11-21):**
  - The report: a new category "Bots" said "아직 채널이 없어요" with no way to fill it, and the create button was hard
    to see.
  - Then the decision: "사람마다 자기 사이드바를 따로 정리하는 기능이어야해. 슬랙이랑 똑같이 가야해 우리는" ("It should be a
    feature where each person organizes their own sidebar. We have to go the same way as Slack.")
- **Rule (who and what):**
  - Everyone (guests too) sorts their own Chats list into **sections** ("섹션"). Nobody else, owners and admins
    included, sees, lists or counts them.
  - Channels, DMs and group DMs can all go in one. A conversation is in at most one of my sections.
  - A section never changes who is in a conversation.
- **Rule (making and filling):**
  - New section is in the Channels "+" menu and in every Move to section menu.
  - Right after creating a section, you can add conversations to it.
  - A conversation goes in by dragging (a computer with a mouse), or by Move to section. That item is in the row
    "⋯", the phone's long-press sheet and the conversation header "⋯". You can also use a section's Add conversations.
  - An empty section says how to fill it and has an Add conversations button.
- **Rule (managing):**
  - A section's "⋯" has Add conversations, Sort (A to Z, Recent activity), Rename, Move up / Move down and Delete.
  - Deleting a section sends its conversations back to Channels and Direct messages.
  - Sections fold like every other section (20261116-collapsible-chat-sections).
  - The list order is Pinned › my sections › Channels › Direct messages.
- **Data:**
  - Sections are the personal list folders of kind `rooms` (migration 289, hidden on 11-20), brought back. Migration
    431 adds `nav_folders.sort`.
  - At start, a one-time step turns each team category into a section for every member of one of its rooms, and for
    its maker even when it is empty. Then it empties `room_categories` and `rooms.category_id`.
  - The team-category API stays as a deprecated stub (an empty list; writes answer 410) until a later cleanup. No table
    is dropped (migrations stay additive).
- **Why:**
  - Team categories made one admin sort everyone's sidebar, and a member had no way to sort their own.
  - The flow was hidden: a small icon, no drag, nothing on the phone.
  - People who know Slack expect personal sections.
- **Left out:**
  - Slack's Priority sort and Active-only filter.
  - Emoji on sections.
  - Admins sharing a starter set of sections.
  - The Trina AI-chat folders, which are unchanged.
- **Tests:** tests/unit/b-sidebar-sections.test.ts, tests/unit/b-nav-folders.test.ts, web/test/unit/nav-folders.test.tsx,
  the web e2e for sections.
- **Version impact:** minor (a new feature, and an additive API field; the old endpoints are kept as stubs).
