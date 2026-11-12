# Phones: no whole-page zoom in the app; the picture viewer zooms on its own (QA TC-246, part 1)

- Date (UTC): 2026-11-12 01:04
- Branch: `fix/phone-no-page-zoom`
- Status: in progress
- Where: web/ (index.html, index.css, a new lib/pageZoom.ts, main.tsx, the image viewer's stage). Why: the phone app is
  one WebView showing the web app, so the fix is in the web app and needs no app release
- Version impact: patch, a bug fix with no new feature or API

## Goal

The owner, on his iPhone: "모바일 기기에서 그냥 줌인하면 어떤 페이지든지 그냥 줌인되어 버리는 것도 해결해. 그리고 사진 볼 때는
줌인하면 실제 그 뷰 안에서만 줌인되어야 하고." A pinch or a double tap on any page zoomed the whole app (his screenshot:
about 1.2×, the bar and ✕ pushed off the screen), because the page's zoom is not limited (`index.html` viewport).

Inside the app, a pinch or double tap no longer scales the page. A picture still zooms inside its viewer, and only there.

## Scope

In:
- Where the web app is an app: the phone app's WebView (`window.ReactNativeWebView`, and `window.mycelMobile` once the
  bridge is installed, lib/mobile.ts) and the installed web app (`display-mode: standalone` / iOS Home Screen,
  lib/pwa.ts). There, at runtime:
  - the viewport meta gets `maximum-scale=1, user-scalable=no` (iOS WKWebView and Android WebView honour it), keeping
    `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`;
  - `<html data-page-zoom="off">` and CSS `touch-action: pan-x pan-y` on the root (Safari and Chromium honour it; it also
    stops the double tap's zoom);
  - Safari's `gesturestart` / `gesturechange` on the document are cancelled (an iOS Home Screen app may ignore
    `user-scalable=no`).
  The decision is re-made when the app's bridge arrives (`mycel:mobile-ready`) and when display-mode changes.
- A plain mobile browser tab keeps the browser's own zoom (accessibility: people zoom pages there).
- Viewers: the opt-in is `data-own-zoom` on the zoomable surface. CSS gives it `touch-action: none`, so the whole gesture
  reaches the viewer's handlers and the browser does nothing there. The image viewer's stage (image mode) uses it; its
  pinch and double tap already scale the picture inside the stage (lib/zoom.ts), the bar stays where it is. A viewer
  that wants the browser to keep one-finger scrolling (the PDF viewer, lib/usePinch.ts) sets `touch-action: pan-x pan-y`
  on its element itself, as now. Since touch-action narrows down the tree, the root's `pan-x pan-y` never stops a
  viewer's own JS pinch: touch events still come, and `none` on the surface keeps pointer events from being cancelled.
- Inputs: on touch they are 16px already (index.css), and `maximum-scale=1` stops iOS's focus zoom anyway.

Out:
- PDF / HTML preview pinch (TC-259, another session): untouched; it keeps working with the root rule.
- The image viewer's bar (files agent).
- An app (native) change: none needed.

## Steps

1. `web/src/lib/pageZoom.ts`: `pageZoomOff({ app, standalone })` (pure), `viewportContent(base, off)` (pure),
   `holdPageZoom()` (applies it, listens for the bridge and display-mode). Called once from `main.tsx`.
2. `web/src/index.css`: `html[data-page-zoom='off'] { touch-action: pan-x pan-y }` and `[data-own-zoom] { touch-action:
   none }`.
3. `ImageViewer.tsx`: the stage in image mode gets `data-own-zoom` (in place of the `touch-none` class).
4. Tests: unit `test/unit/page-zoom.test.ts` (app WebView, bridge only, standalone, plain browser; the viewport string);
   e2e `phone-page-zoom.spec.ts` + `phone-page-zoom.webkit.spec.ts` at 390×844 (stubbed bridge: meta and root
   touch-action; standalone emulated; plain browser unchanged; the image viewer's stage `touch-action: none`, and a
   two-finger pinch zooms the picture and not the page in Chromium through CDP).

## Risks

- A real pinch cannot be made by Playwright in WebKit; the CDP two-finger touch in Chromium is synthetic. On a device:
  pinch and double tap on a few pages in the iPhone app and the Android app (no page zoom), pinch / double tap in the
  picture viewer (zooms the picture, the bar stays), a PDF preview's pinch, and a Home Screen web app on iOS.
- Accessibility inside the app: Settings › Profile › 글자 크기 (lib/textSize.ts) is the way to get larger text there.
- Desktop and a plain browser tab: unchanged (the meta and the root rule apply only in the app).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the two
new phone specs on MOCK_PORT=19381, plus `image-viewer.spec.ts` (the phone case).

## Result

(filled in at the end)
