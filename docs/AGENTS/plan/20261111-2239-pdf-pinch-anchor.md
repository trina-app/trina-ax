# PDF pinch keeps the point under the fingers (QA TC-259)

- Date (UTC): 2026-11-11 22:39
- Branch: `fix/pdf-pinch-anchor`
- Status: done
- Where: web/ (components/viewers/PdfView.tsx, lib/pdfPages.ts). Why: the PDF viewer's own pinch zoom
- Version impact: patch, a bug fix with no new feature or API

## Goal

A pinch on a PDF on a phone zooms around the fingers: the line under them stays under them (it landed ~500 px lower at
2x, ~1,000 px at 2.5x; the double tap was right).

## Cause

At the pinch's end, zoomTo measured the place under the fingers with viewOf(), which read the holder's
getBoundingClientRect() while the live `transform: scale(k)` was still on it: the anchor was k times too far down the
page. The transform is cleared later, in the layout effect (not before: a frame at the old size would show).

## Steps

1. lib/pdfPages.ts layoutTop(): the holder's layout top from its drawn top, the transform's origin and scale (unit tested).
2. PdfView keeps the live transform's origin and scale; viewOf() measures the layout top through it, so zoomTo's anchor
   (and the lazy page window during a pinch) is in the layout's coordinates. The transform is not cleared by a layout
   pass while the fingers are still down.
3. Tests: unit (the pinch end's anchor math, 2x / 2.5x / zoom out; the drawn-box measure lands ~half a page off), e2e
   phone-previews-fit.spec.ts with CDP two-finger touch events on a 3-page PDF at 390×844 (2x, 2.5x, and the double tap).

## Result

Done as planned. The e2e fails on origin/dev (502 px off at 2x) and passes with the fix.
