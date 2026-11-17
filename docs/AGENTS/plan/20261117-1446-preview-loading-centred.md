# File preview: the loading wait in the middle

- Date (UTC): 2026-11-17 14:46
- Branch: `fix/preview-loading-centred`
- Status: done
- Where: web/ (the shared UI components). Why: one shared wait for every file preview (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a visual fix only

## Goal

While a file opens, the spinner and "Loading…" sat in the top-left corner of the big page (QA TC-4751). They go in the
middle of the preview area, in every place a file preview loads, and the page keeps its size when the file appears.

## Scope

In: one shared `PreviewLoading` block in `components/ui.tsx` (fills its scroll box, centres spinner and words); used by
`FileBody` (the side panel, the Files screen, the full-page room file viewer, a shared link, chat files all draw through
it), its Suspense fallbacks, the PDF and Office viewers' own waits and the artifact panel's.
Out: other lists' small spinners; the text and the spinner stay as they were.

## Steps

1. Add `PreviewLoading` (`h-full`, `min-h-40`, flex centre; spinner 14 px, same text token).
2. Replace the four `p-6` paragraphs in `FileBody`, `PdfView`, `OfficeView` and `ArtifactPanel`.
3. A unit test in `file-body.test.tsx`; a `changes/` note.

## Decisions

none

## Risks

None for data or permissions. The block only fills the scroll box it is in; the paper column's size is not changed, so
nothing moves when the file appears. Reduced motion is handled globally in `index.css`.

## Tests

`bun run typecheck`, web unit tests of the touched components, screenshots at 1440 and 390, light and dark.

## Result

Built as planned.
