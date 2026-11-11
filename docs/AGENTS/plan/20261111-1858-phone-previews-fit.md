# Phone previews fit the screen: HTML fitted to the width, pinch inside the viewer

- Date (UTC): 2026-11-11 18:58
- Branch: `fix/phone-previews-fit`
- Status: in progress
- Where: trina-ax `web/` (file previews: FileBody, SandboxFrame, PdfView, FilePanel). Why: file previews are Team AX
  core (docs/REPOSITORY-RULES.md: files, phones).
- Version impact: patch: previews show the same files better on phones; no API, data or migration change.

## Goal

QA TC-259 (phone audit FILES-09, FILES-10, FILES-26). On an iPhone a quotation drawn as a fixed 794 px page is cut
on the right in a 390 px preview; a pinch or double-tap zooms the whole app, not the document (only the image viewer
has a pinch); PDFs have only zoom buttons; and the preview header offers the raw-source editor for .html / .csv /
.svg / .xml files, which nobody can use on a phone keyboard.

## Scope

In:
- `lib/usePinch.ts`: one touch helper for document viewers: a two-finger pinch (scale and centre) and a double tap,
  with the browser's own page zoom held back on that element (non-passive touch listeners, WebKit `gesture*` events,
  `touch-action: pan-x pan-y`).
- PDF (`viewers/PdfView`): pinch zooms the pages (live as a transform, then the pages are drawn at the new width,
  the point under the fingers stays put); a double tap goes between the width and 200 %. The toolbar's zoom buttons
  are hidden on phones (`max-md`); computers keep them.
- HTML file previews (`FileBody` → `SandboxFrame` / `StaticFrame`): a page wider than the frame is fitted to its width
  (CSS `zoom` on the page's root, measured inside the frame); a bar above it says so and toggles "실제 크기" / "화면
  에 맞추기". A pinch or double tap inside the page zooms it (between the fitted size and 400 %), not the app. The
  fitting code is one function (`lib/pageFit.ts`), run inside the script frame and from the host for the static
  frame (no scripts there; the host reaches its same-origin document).
- Edit on phones: only Markdown and .txt files offer edit, from the header's ⋯ sheet (the pencil stays on computers
  for every editable kind).

Out: artifacts in chat (same frame, not a file preview: later), the app-wide viewport (pinch elsewhere stays the
browser's: accessibility), HWP pages (pictures with `max-w-full`: they already fit).

## Steps

1. `lib/usePinch.ts` + unit tests of its math (distance, centre, double tap).
2. PdfView: continuous scale, pinch / double tap, toolbar zoom buttons `max-md:hidden`.
3. `lib/pageFit.ts` (fit + pinch inside a page, the messages to the host), `wrapHtml(..., { fit })`,
   SandboxFrame/StaticFrame `fit` props and the toggle bar in FileBody; unit tests (happy-dom window).
4. FilePanel: phone edit only for .md / .txt, in the ⋯ menu.
5. i18n (five locales), `changes/phone-previews-fit.md`.

## Risks

- The frame's messages: the host takes only `{ type: 'fit', wide, zoom }` from its own frame (event.source), plain
  values; the frame takes `zoom` only from its parent. Nothing else of the sandbox changes (CSP, receiver).
- PdfView keeps the place being read (anchor) and the lazy window; a pinch must not fight it.
- The room viewer's sideways swipe (ViewerDocument useSwipe) takes one finger only: a pinch is not a step.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests (file-body, artifacts, the new ones),
e2e `artifacts`, `frame-files`, `sandbox-exfil`, Playwright WebKit 390×844 and 1440 screenshots (HTML quotation
from Files and a room, a PDF pinch, a .md / .html header).

## Result

(at the end)
