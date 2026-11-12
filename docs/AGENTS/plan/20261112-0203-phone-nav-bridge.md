# The phone app's Back follows the app's screens (nav-v1)

- Date (UTC): 2026-11-12 02:03
- Branch: `feat/phone-nav-bridge`
- Status: in progress
- Where: Team AX core, `mobile/` (the Expo app) and `web/src/lib/`. Why: the phone app and its web bridge are core
  (docs/REPOSITORY-RULES.md: 휴대폰 goes to the core first); nothing here is Trina-only.
- Version impact: minor for the phone app (a new optional bridge capability, needs a store build); patch for the web
  app (it only adds messages and two events; older apps and older servers keep today's behaviour).

## Goal

QA TC-246 part 2 (the owner: Back is odd in the phone app). Today the app walks the WebView's raw history: the iOS edge
swipe is always on, Android's Back always calls `goBack()`, a tapped notification loads a new document
(`location.assign`, the app reloads), and the iOS pull-down reloads the page.

After this:

1. At a tab's root with nothing open, the iOS edge swipe does nothing; Android's Back goes to the start tab, then
   leaves the app.
2. A notification tapped while the app is open opens its screen in the app, without a reload, and Back returns to
   where the person was.
3. Pulling down at the top of a room does not reload the app.

## Scope

In:

- `nav-v1` capability (mobile/src/protocol.ts): the page sends `{type:'nav', canGoBack, home}` (envelope, nonce and
  generation like every bridge message) when the screen or the top overlay changes. `canGoBack`: an overlay is open,
  or the phone's stack (lib/screenHistory.ts `scr`) has entries under the one on show (on a computer-width page: the
  router's index is above 0). `home`: the stack's tab is the start tab (or the page is in no tab); Android's Back
  leaves the app only there.
- App events into the page: `mycel:open` `{path}` (cancelable; the page calls preventDefault when it navigates with
  the router, lib/nav.ts navigateTo) and `mycel:start-tab` (the start tab, as a tab tap: lib/screenHistory.ts
  switchTab).
- The app: `allowsBackForwardNavigationGestures={canGoBack}`; Android Back: canGoBack → goBack(); else not home →
  `mycel:start-tab`; else leave. A tapped push dispatches `mycel:open`; with no page listener (an older server)
  dispatchEvent returns true and the same script falls back to `location.assign`. Until the document on screen has
  sent `nav`, today's behaviour stays (gestures on, Back = goBack while the WebView can).
- `pullToRefreshEnabled` off (iOS only in react-native-webview 14; it reloads the whole app from inside a room).
- One event from lib/backCloses.ts when an overlay pushes its entry (`mycel:overlay-entry`), so the page knows Back
  now closes something (a tiny touch to the overlay-back file; nothing else there changes).

Out:

- Native photo picker for the attach sheet's 사진 보관함 (#439). Needs a new native dependency (expo-image-picker), a
  new app → page file transfer (the bridge only carries files page → app today) and #439's AttachSheet, which is not
  merged. Described in the PR; left for a follow-up.
- Whole-app pinch zoom (TC-246 part 1, PR #524). pageZoom is not touched.

## Steps

1. Protocol + receiver: `NAV_CAPABILITY`, the `nav` message, parse rules, `MobileReceiver` `nav` callback; pure
   helpers in mobile/src/nav.ts (Back decision, gesture flag, the two injected scripts). Tests in
   tests/unit/mobile-bridge.test.ts / mobile-security.test.ts.
2. Web: lib/mobile.ts `setAppNav` (latest wins, resent after a bridge-ready or a session reset, only to an app with
   nav-v1); lib/appNav.ts (state from the history entry, listeners, `mycel:open`, `mycel:start-tab`); one hook call in
   App.tsx Gate; the overlay event in backCloses. Unit tests in web/test/unit.
3. App.tsx: offer nav-v1, keep the page's nav per document, gestures, Back, push open, pull-to-refresh off.
4. README contract, changes/phone-nav-bridge.md, checks.

## Risks

- A wrong `canGoBack` would trap the person (no swipe) or leave the app too early: computed from the same `scr` and
  overlay marks the history uses; while the history steps (a tab switch) it waits for the end.
- Older app + new server: the page sends nothing without nav-v1. New app + older server: no `nav`, no listener →
  today's behaviour, and the push falls back to `location.assign`.
- Native behaviour (gestures, hardware Back, push taps) can't run in Playwright: device checks listed in the PR.
- No migration, no i18n strings, computers unchanged.

## Tests

`bun run typecheck`, `npm --prefix mobile run typecheck`, `bun test tests/unit/mobile-bridge.test.ts
tests/unit/mobile-security.test.ts`, web unit tests (the new nav tests and web/test/unit/mobile.test.ts), `bun run
check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web` once, and a phone e2e that drives the page's
side (the `nav` messages and `mycel:open`) through a fake bridge.

## Result

(filled in at the end)
