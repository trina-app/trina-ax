# A project's row in the 프로젝트 panel opens its chats in place, with a count of unread mentions

- Date: 2026-11-20
- Status: accepted
- Supersedes: the "No chats in this list" part of [Projects: a place of their own](../DECISIONS.md) (the note on top of
  web/src/components/panels/ProjectsPanel.tsx)
- Branch: feat/project-chat-accordion (the owner's team, 2026-11-20)

- **Ask:** "make the accordion refer to chat history, and when someone is mentioning on that make a bubble 1 or 2 that
  refers to who is mentioning."
- **Rule:** each project row of the 프로젝트 panel (not one in the trash, not one I only manage, not for a guest with no
  AI) has a ▸ in the section's indent, left of its icon. It opens the project's newest chats I can open (the project
  page's own GET /api/chats?projectId, at most 8; "All chats" opens the page for the rest) under the row; the row itself
  still opens the project page. Folded at first, and kept per person with the lists' other folds (`project:<id>`,
  panels/folds.ts). A round count (the Chats list's CountPill) sits at the end of a project row and of a chat row while
  unread mentions of me wait there: my unread Inbox notices `chat.thread_reply` with `chatThread.mention`, one per
  thread (the Inbox's newest 100 are read). On hover and for a screen reader it says how many and who mentioned me. A
  chat with mentions is listed first and in bold. Reading the notice (or the thread) clears the count, live.
- **Why:** people check a project's recent chats and where they were mentioned many times a day; opening each
  project's page for it was a click and a page change each time.
- **Left out:** mentions in a project's linked channel (a room: the Chats list counts those already); a server count
  per project (the client groups the notices it reads).
- **Tests:** web/test/unit/chat-mentions.test.ts, web/test/e2e/project-chat-accordion.spec.ts.
- **Version impact:** minor (a new visible feature).
