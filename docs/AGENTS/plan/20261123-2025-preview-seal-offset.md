# Word preview draws a seal on its line

- Date (UTC): 2026-11-23 20:25
- Branch: `fix/preview-seal-offset`
- Status: in progress
- Where: Team AX core (`web/src`). Why: the file preview is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a preview fix with no change to files

## Goal

The file panel draws a floating seal about 4 mm below its line, while LibreOffice centres it (QA TC-8358). A person checking
a stamped form sees the seal off its mark though the file is right.

## Scope

In: the preview's vertical position of floating, no-wrap pictures placed relative to their line.
Out: pictures placed from the page or paragraph, the Word file itself, other renderers.

## Steps

1. Read each no-wrap anchor's `relativeFrom` from the file's XML, which docx-preview drops.
2. Line up only the `relativeFrom="line"` boxes with the top of their line. If the renderer drew another number of
   pictures than the file has, move nothing.
3. Unit test, e2e on the real panel, before and after screenshots.

## Decisions

None.

## Risks

Uses docx-preview's `keepOrigin` and its private `_xmlDocument`, pinned at 0.4.1. If it is missing, the preview stays as it is.

## Tests

`bun run typecheck`, `bun run check:prepush` on Bun 1.3.12, web unit tests, the previews e2e.

## Result

Filled in at the end.
