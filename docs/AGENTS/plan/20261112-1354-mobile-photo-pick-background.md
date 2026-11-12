# A photo picked in the phone app's own picker never reaches the message box (QA TC-251)

- Date (UTC): 2026-11-12
- Branch: `fix/mobile-photo-pick-background`
- Status: done (PR to dev; checked on the owner's iPhone and the Android QA app after merge)
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
  real app offers) attached the photo on dev. iOS: a WKWebView on this Mac (a Swift probe: an app:// page, pushState,
  history.go(-1)) asks no navigation policy and starts no provisional load for a step within the page, so
  react-native-webview's iOS `onLoadStart` does not fire for it. Android: expo-file-system's permission check and
  expo-image-picker's copy both use the canonical cache path, so the copy's size is read (no zero-size drop by itself).
- **The cause found in the code (Android).** The sheet closes as the item runs; its history back-off
  (`history.go(-1)`, lib/backCloses.ts) runs a microtask after the page posted `photo-pick`, while the system picker
  opens. react-native-webview 14 on Android reports every same-document history change as a load start
  (`doUpdateVisitedHistory`, `loading` = progress below 100), and the app fences its bridge on a load start that says
  loading (App.tsx `onLoadStart` → `clear()` → `PhotoPicks.clear()`; DECISIONS "Why no prompt" records such load
  starts after sign-in). The fence drops the pick (its answer is no one's, its copies go) and arms the 10 s stuck-load
  reinstall, which brings the bridge back with a new nonce: the page's `mycel:mobile-ready` rejects the pending pick
  with an AbortError, which `AttachSheet` treated as "moved on" and kept quiet. Nothing attached, no word, as reported.
  The new e2e makes the fake app do exactly that: on dev the sheet's entry is gone 1.2 s into a 2.5 s pick (the step
  the app fences on); with the fix it stays until the bytes are in, and the photo lands.
- **Web (ships with the server, no app build):** `holdHistory()` (lib/backCloses.ts): while the app's pick is on, no
  back-off of ours starts (Back and the router still go); `AttachSheet` holds it from the tap to the last byte (and
  lets go when it unmounts). A pick the page lost while its box is still there (an AbortError: the bridge came back, a
  session reset) now says 사진을 가져오지 못했어요 instead of nothing; a cancel is still an empty pick, quiet. Each box
  keys its sheet by what it writes to (the room and thread, the chat's draft, the side chat's), so a pick can only land
  in the box that started it.
- **Native (next app build):** Android `onLoadStart` at the address already on screen while a pick is on is the same
  document, no fence (`loadStartFences`, src/bridge.ts); a load end that follows such a start fences the pick first
  (`loaded`). A copy whose size reads as 0 takes the picker's own size (`assetSize`), so a file is never left out
  without a word (a wrong size then fails its chunk with a message).
- **Not done:** `ImagePicker.getPendingResultAsync()` for an Android activity killed behind the picker: a killed
  activity restarts the app and its page, so the result has no page to go to (the logcat shows only pause/resume).
  pagehide → abortPending is kept: in the app's WebView it comes only with a real navigation.
- **iOS is not explained by the code.** The same web fix covers any step of the history during the pick, and the
  AbortError now shows a message, so a remaining failure on the iPhone is no longer silent: the owner's check after
  merge tells which way it ends (message, spinner, or the photo).
- Tests: `web/test/unit/back-closes.test.ts` (2 new), `tests/unit/mobile-photos.test.ts` (3 new),
  `web/test/e2e/phone-photo-picker.spec.ts` (3 new: the delayed answer with the Android fence, the lost pick's
  message, another room opened during a pick), Chromium and WebKit.
