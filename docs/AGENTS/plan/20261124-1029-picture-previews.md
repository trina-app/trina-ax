# Previews show placed pictures right: Hangul text flow, Excel drawings

- Date (UTC): 2026-11-24 10:29
- Branch: `fix/picture-previews`
- Status: in progress
- Where: Trina-ax core, `server/src/files/` (HWP preview driver and its isolated worker) and `web/src/` (sheet
  preview). Why: both previews are core file viewers (docs/REPOSITORY-RULES.md).
- Version impact: patch: two preview bugs fixed, no new feature, no API or data change.

## Goal

QA after #512 (general picture placement):

1. TC-8832: a seal placed at 갑 (인) in a .hwpx draws the 갑 line and the 을 line on top of each other in the preview.
   The file is right (Hangul's model: a picture behind the text never moves text); the renderer is not.
2. TC-8833: the .xlsx preview shows only cells; a picture anchored in the sheet is not shown.

## Root causes (measured before writing code)

1. rhwp 0.8.7 (the pinned HWP Preview renderer, a third-party binary we do not patch) lays out a body paragraph that
   holds a floating picture placed from the paragraph (`vertRelTo="PARA"`) wrongly: behind the text
   (`textWrap="BEHIND_TEXT"`) the paragraph is zero lines tall and the next one is drawn on top of it; a paragraph that
   holds only such a picture (behind or in front) is laid out a line lower, so its picture lands a line too low.
   Measured over a matrix: every offset (0, positive, negative, signed or as Hangul writes it), horizontal reference,
   alignment, size, z-order and run position does it, with or without Hangul's stored layout; a place from the paper or
   page, or a wrapping picture (square, top and bottom) do not. What placement writes is valid OWPML and what Hangul
   writes itself (OWPML: behind/in front never moves text), so the fix is in the preview, not in placement.
2. SheetJS (community) reads cells only; the preview never read the sheet's drawing part.

## Scope

In:
- HWP preview (render and layout, so a second placement measures the right page too): before rhwp draws a .hwpx, the
  isolated worker writes a probe without the pictures that float behind or in front of the text placed from their
  paragraph (they move no text, so the probe has Hangul's flow); the renderer lays the probe out; the worker places
  each picture from the paper at its paragraph's top plus its own offset, keeping its layer. Documents without such
  pictures take exactly the path they take today.
- Sheet preview: pictures of the sheet's drawing part (two-cell, one-cell and absolute anchors, pictures in groups)
  drawn over the cells where they are anchored; external links, hidden pictures and formats a browser cannot draw are
  skipped.
- Tests: a regression set for each (several anchors and offsets, not only the QA file).

Out: .hwp (binary) files (placement there writes from the paper: Hangul stores line layout in every .hwp); pictures
inside tables, text boxes or groups in a Hangul document; charts and shapes in a sheet (pictures only).

## Steps

1. `server/src/files/hwpx-float.ts`: the probe (pictures left out) and the pin (placed from the paper); run in the
   preflight worker only.
2. `hwp-engine.ts` job(): probe → export-render-tree + dump-pages → paragraph tops → pin → the body draws the pinned file.
3. Tests with the pinned renderer: negative/zero/positive offsets, two pictures in one paragraph, behind + in front,
   small and large, the page-setup paragraph, a picture alone in an empty paragraph, stored layout; drop the old
   "uncached is drawn too high" skip in hwp-picture.test.ts.
4. `web/src/lib/sheetPictures.ts` + SheetView overlay; web unit tests for each anchor kind and the skips.
5. QA rows TC-8832/TC-8833, typecheck, tests, check:prepush, PR into dev.

## Decisions

none (a renderer workaround inside the existing preview driver; no product decision).

## Risks

- The probe adds one render-tree and one dump-pages run only for documents that have such pictures (preview time,
  same limits and isolation). The worker parses the untrusted zip, never the server process.
- Sheet pictures come from the file the person may already read; drawn as `blob:` images (CSP allows `blob:`), never
  fetched from a link.

## Tests

`bun run typecheck`, `tests/unit/hwp-picture.test.ts` + new hwp float tests (Bun 1.3.12), web unit sheet tests,
`bun run check:prepush`.

## Result

(at the end)
