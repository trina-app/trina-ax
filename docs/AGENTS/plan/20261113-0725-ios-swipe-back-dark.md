# iPhone: swiping back in dark mode shows no white flash

- Date (UTC): 2026-11-13 07:25
- Branch: `fix/ios-swipe-back-dark`
- Status: in progress
- Where: `mobile/` (phone app) and `web/index.html` + `web/public/` (team web app). Why: the flash comes from the
  phone app's WebView and from the page's first paint, both core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a visual fix

## Goal

On the iPhone app in dark mode, swiping back from the left edge shows a white screen for a moment before the previous
screen. Swiping back should show the previous screen (or at least the dark page colour), never white.

## Cause

- WebKit's edge swipe (`allowsBackForwardNavigationGestures`) slides the page away over a picture of the screen it goes
  back to. That picture is taken when the person leaves the screen. When the screen has no picture, WebKit puts a
  plain **white** view there (WebKit `ViewGestureControllerIOS.mm` `beginSwipeGesture`: `[UIColor whiteColor]`, or the
  picture's page colour when there is one) until the page has drawn the screen again.
- WebKit takes these pictures only while the swipe is on (`setAllowsBackForwardNavigationGestures:` also sets
  `setShouldRecordNavigationSnapshots`). Since nav-v1 the app turns the swipe off at a tab's root, so the root never gets
  a picture: every swipe back to a tab's root (the most common swipe) shows the white view.
- The page itself: its background comes from the CSS bundle. A person who chose Dark while the phone is light gets a
  light first paint until the bundle has loaded (the same on a full reload behind a swipe).

## Scope

In:
- Web (ships with the server update): `web/public/theme-boot.js`, a small classic script in `<head>` (the app's CSP has
  no inline scripts, so it is a file) that sets the saved look (`mycel.theme`, lib/theme.ts) on `<html>` before the
  first paint; an inline style gives `<html>` the canvas colour of that look. lib/theme.ts stays the one place that
  applies the look after load.
- Native (next store build): a small local Expo module `mobile/modules/edge-swipe` (iOS) that turns WebKit's edge-swipe
  gesture recognizers on or off. The app keeps `allowsBackForwardNavigationGestures` on, so WebKit keeps taking the
  pictures, and turns the swipe off at a tab's root through the module. Without the module (Android, an older build) or
  when it finds no web view, the app gates the swipe with the prop as before.
- The WebView's background: already the page colour (Fabric: the WKWebView is transparent over the component's
  canvas-coloured view); react-native-webview 14 has no `underPageBackgroundColor` prop, and WebKit's default follows the
  page's own background. The app has no native navigation stack; every native screen is drawn on the canvas colour.

Out: a store build or upload (the owner batches store builds).

## Steps

1. `web/public/theme-boot.js` + `web/index.html` (script and style in `<head>`), unit test that it gives the same look
   as lib/theme.ts for every saved theme × phone look.
2. `mobile/modules/edge-swipe` (Swift, Expo module), `mobile/src/nav.ts` `swipeGate` (pure, tested), App.tsx uses it.
3. changes fragment, checks.

## Risks

- iOS only; cannot be run here without a store-like build. The module only toggles public `UIScreenEdgePanGestureRecognizer`
  objects on the WKWebView; if a future iOS has none, the app falls back to the prop (old behaviour, white flash only).
- The boot script is parser-blocking but tiny and `no-cache` like the other files in `web/public`.

## Tests

`bun run typecheck`, `bun run test:unit` (theme boot, mobile nav), `bun run check:i18n`, `bun run check:docs`.

## Result

(filled in at the end)
