# The image viewer copies the picture: 복사 in its bar and ⌘C / Ctrl+C

- Date (UTC): 2026-11-09 10:50
- Branch: `feat/viewer-copy-image`
- Status: done
- Where: trina-ax core (`web/src/lib/copyImage.ts`, `web/src/components/ImageViewer.tsx`). Why: the image viewer is
  core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. One button and one shortcut in the viewer; no API, setting or data change.

## Goal

The owner: "이미지 copy 기능도 있어야해". The full-window image viewer (#246) has download, the original in a new tab and
✕, but no copy. Today a picture copies only by a right-click: the browser's own Copy Image, or the desktop app's 이미지
복사 (#234). The viewer gets a **복사** button and ⌘C / Ctrl+C, as Slack's viewer has.

## Scope

In:
- A **복사** button (copy icon) in the viewer's bar, next to the download, with its tooltip and name in five languages.
- ⌘C / Ctrl+C in the viewer does the same when no text in the viewer is selected.
- It copies the original the viewer drew (no new request, no new address): a PNG as it is when we have its bytes,
  anything else (JPEG, WebP, GIF, the server's JPEG of a HEIC) drawn on a canvas and copied as PNG, transparency kept.
  While the original is still loading, the copy waits for it.
- A picture over the 20 MB preview limit (or whose original failed to load) shows its thumbnail: that picture is copied,
  and the toast says it is the small one.
- `navigator.clipboard.write([new ClipboardItem({ 'image/png': … })])`, the item made inside the click (Safari).
- The button shows only where it works: a secure page with ClipboardItem and image/png. Not in an Android WebView (the
  phone app's, an in-app browser's): it puts no picture on the clipboard (Chromium's image clipboard needs Chrome's file
  provider), so the button would do nothing. The iPhone app's WebView and iOS Safari have it.
- A short toast: 이미지를 복사했어요, or 이미지를 복사하지 못했어요 with the reason.

Out:
- No preload bridge in the desktop app: its team page may already write the clipboard (`clipboard-sanitized-write` for
  the team origin, `desktop/src/main/security.ts`), and its team address is https or this machine, a secure page. A
  desktop e2e case checks that an image/png write lands on the clipboard.
- The room message's ⋮ menu and long-press sheet act on the message (copy text, edit, delete); they have no item per
  attachment, so no 이미지 복사 is added there.

## Steps

1. `web/src/lib/copyImage.ts`: the support check and the copy (pick the drawn picture, PNG as is or through a canvas,
   the clipboard write, the outcome with its reason). Unit tests.
2. ImageViewer: the button, ⌘C / Ctrl+C, the toast. Five languages.
3. e2e: click 복사 and ⌘C, read the clipboard back as image/png in Chromium (clipboard permissions); JPEG and WebP with
   transparency come back as PNG. Desktop e2e: image/png from the team page.
4. CHANGELOG, DECISIONS, screenshots.

## Risks

- Canvas size limits (iOS Safari): a canvas too big to make is retried at a smaller size, and the toast says so.
- A copy writes the clipboard: tests use the browser's own clipboard in Chromium; the desktop case puts back what was on
  the computer's clipboard.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the
image-viewer e2e spec, the desktop clipboard e2e spec and the desktop unit tests.

## Result

Built as planned: `web/src/lib/copyImage.ts` (the support check, the copy, the ⌘C key) and the viewer's 복사, ⌘C /
Ctrl+C and toast, in five languages. The desktop e2e was run on a Mac: a PNG with a transparent half written from the
team page came back from the system clipboard with its transparency, so the desktop app needs no bridge.

Added after the review: a copy still waiting for its original is given up by the next copy and when the viewer closes
(it writes nothing, so it never lands over something copied since); the wait is 15 s at most, then the thumbnail; every
Android WebView is left out (in-app browsers too), not only the phone app's; the result is also said inside the dialog
for screen readers; an SVG without a size of its own is drawn at its size on screen; the retry for a picture too big for
a canvas keeps within a 16384 px side as well.

Not done: a Safari (WebKit) e2e, since Playwright's WebKit may write the computer's own clipboard; ⌘C through the real
viewer in the desktop app (its e2e team page is a fake one). Details: docs/DECISIONS.md "The image viewer's 복사".
PR: https://github.com/trina-app/trina-ax/pull/258
