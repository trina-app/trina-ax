# Trina history sections hold every chat my history shows

- Date (UTC): 2026-11-22 10:12
- Branch: `feat/history-sections-all-chats` (on top of `feat/history-sections`)
- Status: done
- Where: server (`chat/history-list.ts` new, `chat/nav-folders.ts`, `chat/chat-groups.ts`, `chat/store.ts`,
  `chat/shared.ts`, `routes/chats.ts`), shared (`api/nav-folders.ts` text), web (`nav/SidebarSections.tsx`,
  `nav/ChatItem.tsx`, `store/navFolders.ts`, i18n), tests. No migration.
- Version impact: minor (more chats can go in a section; a new refusal reason `folder_not_in_history` replaces
  `folder_project_chat` and `folder_shared_chat`).

## Goal

The owner (2026-11-22): any chat that is visible in my Trina history (my own chats, project and team-project chats,
chats shared with me by people, groups or through a project) can go in my section. A section shows a chat only while it
passes the same visibility check as the history list itself, and moving a chat into a project no longer removes it.

## Scope

- One rule for the history: the SQL of `GET /api/chats` without filters moves to `chat/history-list.ts`
  (`historyWhere`, plus `inHistory` per row: a shared chat only while I see it). The list, the groups
  (`myList`) and the sections (`visibleChatItems`, `chatInHistory`, `ChatStore.folderOf` + `chatView`) use it.
- `setChatFolder`: every chat that passes; 409 `folder_not_in_history` for one I can open but my history does not show.
- `updateChat` no longer drops section rows on a project move; the trash still does.
- Web: `chatSectionBlock` is only 'side'; the off item with a reason goes.

## Steps

1. `history-list.ts`; GET /api/chats and `myList` use it.
2. `nav-folders.ts`: visibility in TS over the rule; counts, top rows, `?folderId=`, make-room, `chatChanged`.
3. `Chat.folderId` per viewer: `ChatStore.folderOf` (SQL part), `chatView` (per-row part).
4. Web, mock, i18n, tests, docs.

## Decisions

- A shared project chat I never wrote in is not in my history, so it cannot be filed (409), as the brief's rule says.
- A row of a chat I lost stays and is filtered on read; it comes back with access.

## Risks

- Leaking a folder id to another person: every `Chat` is built per viewer (`chatView(rt, viewer, …)`), the row read is
  the viewer's own; tests check the creator's and a reader's copies, lists, groups and `chat.updated` frames.

## Tests

- `tests/unit/b-nav-folders.test.ts` (new cases), `tests/security` matrix, chat-groups, shared-chat suites, web unit
  and `web/test/e2e/history-sections.spec.ts`.

## Result

See the PR.
