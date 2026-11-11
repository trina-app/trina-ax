# Files: a "Load more" answer that arrives after another folder opened is dropped

- Date (UTC): 2026-11-11 12:06
- Branch: `fix/files-load-more-folder-switch`
- Status: done
- Where: trina-ax core (`web/src/pages/Files.tsx`, a web unit test). Why: the Files screen is core (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch, a wrong listing on a slow network is fixed; no API, data or wording change

## Goal

QA TC-240: on a slow network, pressing 더 보기 in a folder with more than 200 files and then opening a subfolder before
the next page arrives showed the subfolder's files plus the parent's next 200 rows (breadcrumb on the subfolder). Rows
in that list point at files of another folder, so a click, a selection or a bulk action works on what the person does
not expect. After this change the subfolder shows only its own files; a late page of the folder left behind is
dropped.

## Scope

In:
- `more()` in `web/src/pages/Files.tsx` adds its page only while the same listing is on screen: no other listing
  (`load()`, another folder, a reload after a change) started since, and the table still shows that folder.
- The 더 보기 button's busy state belongs to the listing that pressed it (a late answer does not leave the new
  folder's button busy, nor clear it while that folder's own page is loading).
- A web unit test: 더 보기, open a subfolder, the first folder's page arrives last; only the subfolder's rows.

Out: the server's listing and cursors (they are per folder already); the trash's own 더 보기 (one listing, no folders).

## Steps

1. Give `more()` the listing generation (`loads` ref) it started on, and drop its answer when it changed or when the
   table's path is not the same.
2. Unit test next to the other Files page tests.
3. Check on a local server with the QA script (a delayed `cursor=` request, then the subfolder).

## Risks

No migration, no permission change, no wording. A reload that lands while 더 보기 is loading now drops the second
page (the person presses 더 보기 again) instead of adding it to a first page that may have changed.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the files e2e spec.

## Result

Built as planned. `more()` in `web/src/pages/Files.tsx` remembers the listing it started on (the `loads` counter that
`load()` already uses to drop late first pages) and adds its page only while no other listing started since and the
table still shows the same folder; a failure toast shows only for that listing too. Its own counter keeps the 더 보기
button's busy state for the latest press, and opening another folder clears it.

Test: `web/test/unit/files-load-more.test.tsx` (400 files and a subfolder, the second page held until the subfolder is
on screen: 2 rows, none of the parent's; it failed with 202 rows before the fix), and 더 보기 without leaving still
adds the page. On a local server (401 entries, the `cursor=` request held 2.5 s, the QA script): the subfolder shows
its 3 files, no parent rows; without leaving, 더 보기 shows 400 rows and the button for the last one.
