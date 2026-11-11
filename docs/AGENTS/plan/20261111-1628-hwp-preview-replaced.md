# HWP preview: a replaced document starts again from its first page, and says so

- Date (UTC): 2026-11-11 16:28
- Branch: `fix/hwp-preview-replaced`
- Status: in progress
- Where: trina-ax core (`web/src/components/viewers/HwpView.tsx`, the five locales, a web unit test). Why: the file
  preview is core (see docs/REPOSITORY-RULES.md).
- Version impact: patch, the preview no longer mixes two versions of a document; no API, data or migration change

## Goal

QA TC-226 (from TC-048): A has `shared/Docs/plan.hwpx` open in the HWP preview on page 2; B replaces it with a 5-page
version; A presses 다음 and sees the NEW file's page 3 ("3 / 5쪽") right after the OLD page 2, with no notice.
`HwpView` keeps only the page number and asks for each page by path; every page the server sends carries the
`sourceHash` of the document it was drawn from, and nothing compared it.

After this change the preview remembers the document it shows. A page from another document (the file was replaced)
is not shown in its place: the preview goes back to page 1 of the new version and says "문서가 바뀌어서 첫 쪽부터 다시
보여 드려요."

## Scope

In: `HwpView` compares each page's `sourceHash` with the one it showed so far (per file); on a difference it shows page
1 of the new version with a one-line notice (role status) that stays until the person turns a page. A web unit test.
Five locales.

Out: the server (it already sends `sourceHash` per page and checks a changed file during a render); a live refresh of
an open preview when nobody turns a page (the page on screen stays the one that was read; the next page asked for
tells).

## Steps

1. `HwpView`: the document's hash, the check, page 1 again, the notice.
2. Unit test with a fake server that replaces the document between two pages.
3. Check on a local server with the HWP Preview plugin if it can be installed here (a 14 MB package from the update
   server); otherwise the unit test.

## Risks

No migration, no permission change. Five locales. A room file (its own address) works the same way.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new test and the HWP web tests.

## Result

(filled in at the end)
