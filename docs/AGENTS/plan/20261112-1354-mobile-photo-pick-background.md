# A photo picked in the phone app's own picker never reaches the message box (QA TC-251)

- Date (UTC): 2026-11-12
- Branch: `fix/mobile-photo-pick-background`
- Status: PR to dev (#625), not checked on a device yet; the owner's iPhone and the Android QA app check it after merge
- Where: trina-ax `web/` (common code). Why: the bridge's page side is shared by every edition, and a web fix reaches
  apps already built (iOS 1.0.5 build 9 is in TestFlight) (see docs/REPOSITORY-RULES.md).
- Version impact: patch: a bug fix in the phone attach sheet, no new behaviour.

## Goal

On the Android QA app 1.0.5 and the iPhone TestFlight 1.0.5 build 9 (photo-pick-v1, #607), 📎 → 사진 보관함 opens the
system photo picker; after Done nothing is attached, no message, no upload. The pick must survive the sheet closing and the app going to the background while the
system picker is open (and share-text-v1 the same, if it has the same problem).

## Scope

In: find the cause with evidence (the QA app on the Android emulator against the mock team server over
https://localhost, the page instrumented locally to report its lifecycle events and bridge replies); fix it on the page;
a test that simulates what Android does around a pending pick.
Out: native changes, unless the page cannot fix it (then say so: the iOS build would need a new number).

## Steps

1. Reproduce on the emulator; record which page events and bridge replies happen around the picker.
2. Fix on the page side (`web/src/lib/mobile.ts`, `web/src/components/chat/AttachSheet.tsx`, or the sheet's history).
3. Unit test in `web/test/unit/mobile.test.ts` and an e2e with the fake bridge in `phone-photo-picker.spec.ts`.

## Risks

Back and the overlay history (lib/backCloses.ts) on phones; the bridge fences (navigation, session reset).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test web/test/unit/mobile.test.ts
tests/unit/mobile-*.test.ts`, the phone e2e specs for the attach sheet and the photo picker (Chromium and WebKit).

## Result

Worked without a phone (none on this Mac for this task); the owner's iPhone and the Android QA app check after merge.

- **What does not explain it.** The handoff's first guess (the sheet unmounts the handler) is wrong: `AttachSheet`
  hosts the `MenuButton`, it is not inside the sheet, and stays mounted. The e2e with the fake app answering 3 s and 5 s
  later (also with `visibilitychange`/`blur`/`focus`/`mycel:mobile-foreground` around it, and every capability the
  real app offers) attached the photo on dev. Android: expo-file-system's permission check and expo-image-picker's copy
  both use the canonical cache path, so the copy's size is read (no zero-size drop by itself).
- **The cause on iOS (found by the independent review).** react-native-webview 14.0.1 injects a history shim at document
  start (apple/RNCWebViewImpl.m, `html5HistoryAPIShimSource`): every pushState, replaceState and popstate of the page
  posts to the app, which turns it into `onLoadingFinish` (`didReceiveScriptMessage`, with a `navigationType`) and so
  into JS `onLoadEnd` (src/WebViewShared.tsx). App.tsx `onLoadEnd` → `settle()` → `loaded()` installs the bridge again:
  a new nonce, `bootstrap(config, true)`, the page's `mycel:mobile-ready` → `abortPending()` cancels the pick, and
  `MobileReceiver` drops the picker's answer (its config changed). The sheet's back-off during the picker did that
  every time. (A WKWebView probe on this Mac had shown that a step within the page starts no navigation, so no
  `onLoadStart`; the end came from the shim.) The web fix below takes that step out of the pick, so it should fix
  TestFlight build 9 too; the native fix stops the reinstall for good in the next build. Left: a tap on 사진 보관함
  faster than the reinstall the sheet's own opening brings (its pushState): tens of milliseconds, not at a person's
  speed.
- **The cause on Android (found in the code).** The same back-off (`history.go(-1)`, lib/backCloses.ts) runs a
  microtask after the page posted `photo-pick`, while the system picker opens. react-native-webview 14 on Android
  reports every same-document history change as a load start (`doUpdateVisitedHistory`, `loading` = progress below
  100), and the app fences its bridge on a load start that says loading (App.tsx `onLoadStart` → `clear()` →
  `PhotoPicks.clear()`; DECISIONS "Why no prompt" records such load starts after sign-in). The fence drops the pick and
  arms the 10 s stuck-load reinstall, which brings the bridge back with a new nonce: the page's `mycel:mobile-ready`
  rejects the pending pick with an AbortError, which `AttachSheet` treated as "moved on" and kept quiet.
- **Repro.** The e2e makes the fake app do each: the Android fence on a history step, and the iOS shim's reinstall on
  every pushState / replaceState / popstate. On dev both fail (nothing attached); with the fix both pass.
- **Web (ships with the server, no app build):** `holdHistory()` (lib/backCloses.ts): while the app's pick is on, no
  back-off of ours starts (Back and the router still go); `AttachSheet` holds it from the tap while the picker is up,
  then at most 15 s + 1 s per MiB for the bytes (2 min cap, `bytesHoldMs`), and lets go when it unmounts. A pick the
  page lost while its box is still there (an AbortError: the bridge came back, a session reset) now says 사진을 가져오지
  못했어요 instead of nothing; a cancel is still an empty pick, quiet. Each box keys its sheet by what it writes to (the
  room and thread, the chat's draft, the side chat's), so a pick can only land in the box that started it.
- **Native (next app build):** a load end while the bridge is on asks the page first (`sameDocumentScript`,
  src/bridge.ts): the document with this bridge's nonce says nothing (a step within the page: the iOS shim's, or an
  Android one), a new document answers (`readNewDocument`) and only then is the bridge fenced and installed again.
  Android `onLoadStart` at the address already on screen while a pick is on is the same document, no fence
  (`loadStartFences`); if it was a new document after all, its load end finds no bridge and installs it. A copy whose
  size reads as 0 takes the picker's own size (`assetSize`), so a file is never left out without a word.
- **Not done:** `ImagePicker.getPendingResultAsync()` for an Android activity killed behind the picker: a killed
  activity restarts the app and its page, so the result has no page to go to (the logcat shows only pause/resume).
  pagehide → abortPending is kept: in the app's WebView it comes only with a real navigation.
- Tests: `web/test/unit/back-closes.test.ts` (2 new), `web/test/unit/attach-sheet-hold.test.ts`,
  `tests/unit/mobile-photos.test.ts` (4 new), `web/test/e2e/phone-photo-picker.spec.ts` (4 new: the delayed answer with
  the Android fence, the iOS shim's reinstall, the lost pick's message, another room opened during a pick), Chromium
  and WebKit.
