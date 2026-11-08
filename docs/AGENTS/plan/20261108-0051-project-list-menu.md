# Projects list "…" menu, and "Move to project…" from the chat rows

- Date (UTC): 2026-11-08 00:51
- Branch: `feat/project-list-menu`
- Status: done
- Where: trina-ax core (`web/src/pages/Projects.tsx`, `web/src/components/Sidebar.tsx`). Why: projects and chats are
  core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Two menu additions in the web app on the API that already exists; no API, rule or database
  change.

## Goal

The owner asked: "내 채팅을 프로젝트로 옮길 수 있을까? 그리고 프로젝트들 리스트에서 뭔가 삭제하거나 이름을 바꾸거나, 링크
복사하거나 하는 기능도 필요할 듯?"

- A chat moves to a project only from the title menu at the top of the chat. The chat rows in the sidebar's 트리나
  기록 (and its "모두 보기", the same list) have a "…" with rename and delete, but no move.
- The cards on the Projects page are plain links. Rename and delete are only inside a project, and there is no way to
  copy a project's link.

## Scope

In:
- A "…" on each project card (the row menu the rooms lists use, `components/rooms/MenuButton.tsx`: arrow keys, Esc,
  a bottom sheet on phones):
  - 이름 바꾸기 (people who may edit, `Project.canEdit`): the same small prompt as a chat's rename, then
    `PATCH /api/projects/:id {name}`;
  - 링크 복사 (everyone who sees the card): `<origin>/projects/<id>`, with the rooms' "링크를 복사했어요." toast;
  - 삭제 (people who may edit): the confirm from inside the project, shared by both places (same strings, the line
    with the number of shared chats that go with it), then `DELETE /api/projects/:id`.
- "프로젝트로 옮기기…" / "프로젝트 바꾸기…" in the sidebar chat row's "…", opening the move dialog the title menu uses
  (`MoveToProjectDialog`). Not for a shared chat (`sharedRights().canMove`): it stays in its project.
- Strings: only existing ones (`chat.rename`, `projects.name`, `rooms.menu.*`, `chat.project.*`, `projects.delete*`).

Out:
- The chat list on a project's page and the search dialog's chat rows (neither is named in the request; the project
  page rows have no menu at all).
- Drag and drop. Any server or mock change.

## Steps

1. `Projects.tsx`: `useDeleteProject()` (the confirm and the call) used by the project page and the cards;
   `ProjectCardMenu` on each card (the button in the card's top corner, the name line kept clear of it).
2. `Sidebar.tsx` `ChatItem`: the move item between rename and delete, the dialog, the list updated after a move; test
   ids on the row menu's items.
3. Web unit tests; e2e at 1440 and 390 with axe; a visual pass (light, dark, both widths); one CHANGELOG line.

## Risks

- Permissions: the menu shows rename and delete only with `canEdit`; the server checks again (403 otherwise).
- Shared project chats: unchanged. A shared chat gets no move item; moving a private chat into a sharing project keeps
  it private (the server's rule).
- Touch screens: the card's "…" is always shown there; below 768 px it opens a bottom sheet. With a mouse it shows on
  hover and keyboard focus.
- No migration; no new strings, so nothing to translate.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`,
`bun run prepare:hwp` and the full web e2e (chromium).

## Result

PR: https://github.com/trina-app/trina-ax/pull/182

Built as planned, plus what the review found:
- `Projects.tsx`: `ProjectCardMenu` on each card (`MenuButton`), and `useDeleteProject()` for the card and the project
  page. Delete reads the project again before the confirm, so the shared-chats line uses the server's count at that
  moment. A successful delete also clears the project from the person's private chats in the sidebar (the server does the
  same). A project that is not found any more (deleted by someone else, or no longer visible to this person) just
  leaves the list. After a delete, focus moves to the next card.
- `Sidebar.tsx` `ChatItem`: the move item and its dialog, which is rendered beside the row rather than inside it (React
  would otherwise send the dialog's pointer events to the row's hover peek). Esc now closes the row menu only. The "…"
  button is 24 px on a computer, because axe's WCAG 2.2 target-size check failed with the menu open.
- `account-settings.spec.ts` checked the old two-item row menu. It now expects the move item too.
- Not done: the chat rows on a project's page and in the search dialog, focus after a move while the history is grouped by
  project, a length check in the rename prompt (chat rename has none either), and project names that change while the
  history is grouped by project (they were already read only once).
