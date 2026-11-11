# Files: rename, move and trash are off, with the reason, on folders the person may not change

- Date (UTC): 2026-11-11 12:20
- Branch: `fix/files-fixed-folder-actions`
- Status: done
- Where: trina-ax core (`server/src/team-files/service.ts`, `shared/src/api/entities.ts`, `web/src/pages/Files.tsx`,
  `web/src/lib/bulkFiles.ts`, the five locales, tests). Why: the file screen and its API are core (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch, an optional field on file listing entries and disabled menu items; older clients ignore the
  field, older servers do not send it (the menu works as before)

## Goal

QA TC-224: a member of the group `sales` who can write `groups/sales` is offered 이름 바꾸기, 옮기기 and 휴지통으로 on
that folder (row menu and selection bar, 1440 and 390 px). Each one ends with the toast "부서·프로젝트 폴더나 권한
규칙이 걸린 폴더(또는 그런 폴더가 든 폴더)는 관리자만 …". The same happens on `shared` at the team root and on the
person's own folder in `users` ("protectedFolder"). After this change those items are disabled, with one short line
saying why, and the selection bar leaves such folders out and says so; nothing is pressed only to be refused.

## Scope

In:
- `GET /api/files/tree`: a folder entry the caller may write but may not move, rename or trash carries
  `fixed: 'admin'` (a group, project or rule folder, `shared`, `skills`, or a folder holding one: the same
  `managedInside()` the move and trash checks use; never for the owner or an admin) or `fixed: 'always'` (what
  never moves: `users/<id>`, a folder holding a plugin's managed folder: the same test as `assertMovable()`).
  Looked up for the returned page only, like `downloadOnly`.
- `FileEntry.fixed` in `shared/src/api/entities.ts` (optional).
- Web: `canChange()` is false for a fixed entry (selection bar move and trash, dragging rows); the row menu's rename,
  move and trash are disabled with a short reason under them; the selection bar shows how many selected folders
  cannot be moved, and its toast and trash question count them apart from read-only items.
- Five locales; unit tests (server listing, web helpers and the row menu).

Out: the AI's file tools (they already explain the refusal to the person); other screens that list files.

## Steps

1. Server: a non-throwing form of `assertMovable()`; `fixed` on the tree page's folder entries.
2. Shared type; web `canChange`, row menu, bulk bar, messages.
3. Tests; check on a local server as a group member and as an admin (1440 and 390 px).

## Risks

Permissions: no rule changes; the server keeps refusing exactly as before. What a member learns: that a folder they
can write is admin-only to change. Pressing rename already told them the same (the refusal names the reason), so
nothing new is shown; an admin sees no mark. Cost: `managedInside()` per writable folder of the returned page (at most
200; a few small queries each). Five locales. Phone and computer use the same menu.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the file unit tests (`tests/unit/c-files*.test.ts`),
`bun run test:web`, the files e2e spec.

## Result

Built as planned. `TeamFiles.tree()` sets `fixed` on the returned page's folder entries the caller may write:
`'always'` from `unmovable()` (the test `assertMovable()` now uses too: a personal folder, root, `.system`, the top
`projects/` folder (dev's members-only zone guard, f1cd13b2b, moved into `unmovable()` on the rebase so it still
refuses), a folder holding a plugin's managed folder), `'admin'` from `managedInside()` for anyone but the owner or an admin. The web's
`canChange()` is false for a fixed entry, so the selection bar's 옮기기 and 휴지통으로 and dragging rows to move leave
it out; the bar shows "옮길 수 없는 폴더 N개" beside "읽기 전용 N개", and the skip toast and the trash question count the
two apart. The row menu's 이름 바꾸기, 옮기기 and 휴지통으로 are disabled with one line under them ("이 폴더는 관리자만
이름을 바꾸거나 옮기거나 지울 수 있어요." or "이 폴더는 이름을 바꾸거나 옮기거나 지울 수 없어요."), tied to them with
`aria-describedby`.

Tests: `tests/unit/c-files-fixed.test.ts` (a member's group folder, `shared`, a folder holding a project's folder:
'admin'; a plain folder and files: none; read-only and pass-through folders: none; a personal folder: 'always' for a
member and an admin; the owner and an admin: no 'admin'; every marked folder's rename is refused (403) and the plain
one's works; the top `projects/` is 'always' for the owner and an admin and its move is refused), `web/test/unit/bulk-files.test.ts` (canChange, isFixed, drag and drop), and
`web/test/unit/files-fixed-folder.test.tsx` (the row menu off with its reason and no request on a press; a plain folder
keeps the actions; the selection bar's count and buttons).

On a local server as a member of a group `sales` at 1440 and 390 px: the three items are off with the reason, a press
shows no toast, and selecting the folder shows "옮길 수 없는 폴더 1개" with 옮기기 and 휴지통으로 off; as an admin the
listing has no mark. `tests/unit/c-e2e.test.ts` fails in this worktree before and after (the launcher's socket path is
too long for this folder), unrelated.

Rebased onto dev 1ccf9a7f6 (2026-11-12): dev's `if (isProjectsTop(segs)) fileError(...)` in `assertMovable()` is now
`return 'protected'` in `unmovable()`, so `projects/` still never moves or is renamed, and the listing marks it.
`tests/security/project-members-only.test.ts`, `c-files-fixed` and `c-files`: 118 pass.
