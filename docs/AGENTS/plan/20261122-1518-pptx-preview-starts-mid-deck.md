# A PowerPoint preview shows every slide, from slide 1

- Date (UTC): 2026-11-22 15:18
- Branch: `fix/pptx-preview-starts-mid-deck`
- Status: in progress
- Where: web/src/components/viewers/OfficeView.tsx. Why: the Word and PowerPoint previews are drawn in the page there
  (docs/REPOSITORY-RULES.md).
- Version impact: patch: a preview bug fix, no new feature or setting.

## Goal

The owner opened a 12-slide deck in a project chat's file panel and the preview began at slide 9 (in the Files view at
slide 5). The file has slides 1-12, none hidden; the view was at the top. The first slides were not drawn at all.

Cause: `useRender` draws every run of a preview into the same element. The PowerPoint viewer
(`@aiden0z/pptx-renderer`) adds the slides in batches of 4 and its `destroy()` empties its container. When the
preview draws again while the last drawing is still on its way (the panel width settles, the bytes are read again), the
old viewer is destroyed when its `open` finishes, after the new viewer has added its first batch or two: the old
viewer's `destroy()` empties the shared element and only the new viewer's later batches stay. Slide 5 and slide 9 are
exactly the batch boundaries.

## Scope

- In: each drawing of a Word or PowerPoint preview gets an element of its own (a stale drawing can only empty its own,
  already removed, element) and a stale PowerPoint drawing is stopped (`signal`).
- Out: the renderer library itself; PDF, sheet and Hangul previews (they do not share an element this way).

## Steps

1. `useRender`: a new child host per run, plus an AbortSignal aborted on cleanup; the render gets both.
2. `PptxView`: open the viewer on that host with the signal; `data-start-slide` set only for a link with a slide.
3. Unit test of `useRender`'s host rule; e2e test that resizes the panel while the deck draws and expects slides 1-12.
4. Screenshots at 1440 and 390 in the shots folder.

## Decisions

- A fresh host per run rather than a lock or a delay: it does not depend on timing and covers Word too.
- Scroll restore is untouched: the view was at the top, nothing to change there; a link with `&slide=N` still opens at N.

## Risks

- CSS that styles the host's direct children: `.docx-host` rules use descendant selectors, so the extra element does
  not change them.

## Tests

- `bun run typecheck`, `bun run check:prepush`, web unit tests, `previews` and `answer-sources` e2e.

## Result

(filled in when done)
