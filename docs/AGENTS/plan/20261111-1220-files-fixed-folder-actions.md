# Files: rename, move and trash are off, with the reason, on folders the person may not change

- Date (UTC): 2026-11-11 12:20
- Branch: `fix/files-fixed-folder-actions`
- Status: in progress
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

(filled in at the end)
