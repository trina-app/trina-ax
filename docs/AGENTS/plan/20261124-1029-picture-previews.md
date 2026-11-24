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
   has no stored layout (no `hp:linesegarray`, as every writer but Hangul saves) and holds a floating object with
   `textWrap="BEHIND_TEXT"` and `vertRelTo="PARA"` as zero lines tall: the next paragraph is drawn on top of it.
   Measured over a matrix: every offset (0, positive, negative, signed or as Hangul writes it), every horizontal
   reference, alignment, size, z-order and run position does it; `IN_FRONT_OF_TEXT`, `SQUARE`, `PAPER`/`PAGE`, or a
   paragraph with Hangul's stored layout do not. What placement writes is valid OWPML and what Hangul writes itself.
2. SheetJS (community) reads cells only; the preview never read the sheet's drawing part.

## Scope

In:
- HWP preview (render and layout, so a second placement measures the right page too): before rhwp draws a .hwpx, the
  isolated worker finds every behind-text object anchored to an unlaid-out body paragraph; the renderer lays out a
  probe copy where those objects are in front (same flow, measured equal), reads where each object is drawn, and the
  worker pins each one to the paper at that spot (still behind the text). Text flow is then as Hangul's, whatever the
  offset or anchor. Documents without such objects take exactly the path they take today.
- Sheet preview: pictures of the sheet's drawing part (two-cell, one-cell and absolute anchors, pictures in groups)
  drawn over the cells where they are anchored; external links, hidden pictures and formats a browser cannot draw are
  skipped.
- Tests: a regression set for each (several anchors and offsets, not only the QA file).

Out: .hwp (binary) files: Hangul always stores line layout there; a placed picture in a cell-anchored paragraph;
charts and shapes in the sheet (pictures only).

## Steps

1. `server/src/files/hwpx-float.ts`: find the objects (probe file) and pin them (fixed file); run in the preflight
   worker only.
2. `hwp-engine.ts` job(): probe → export-render-tree + dump-pages → pin → hand the fixed file to the body.
3. Tests with the pinned renderer: the QA document, positive/negative/zero offsets, two objects in one paragraph,
   front + behind together, a cached document untouched; drop the old "uncached is drawn too high" skip.
4. `web/src/lib/sheetPictures.ts` + SheetView overlay; web unit tests for each anchor kind and the skips.
5. QA rows TC-8832/TC-8833, typecheck, tests, check:prepush, PR into dev.

## Decisions

none (a renderer workaround inside the existing preview driver; no product decision).

## Risks

- The probe adds one render-tree run only for documents that have such objects (preview time, same limits and
  isolation). The worker parses the untrusted zip, never the server process.
- Sheet pictures come from the file the person may already read; drawn as `blob:` images (CSP allows `blob:`), never
  fetched from a link.

## Tests

`bun run typecheck`, `tests/unit/hwp-picture.test.ts` + new hwp float tests (Bun 1.3.12), web unit sheet tests,
`bun run check:prepush`.

## Result

(at the end)
