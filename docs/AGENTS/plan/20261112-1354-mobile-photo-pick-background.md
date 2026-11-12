# Android: a photo picked in the app's own picker never reaches the message box

- Date (UTC): 2026-11-12
- Branch: `fix/mobile-photo-pick-background`
- Status: in progress
- Where: trina-ax `web/` (common code). Why: the bridge's page side is shared by every edition, and a web fix reaches
  apps already built (iOS 1.0.5 build 9 is in TestFlight) (see docs/REPOSITORY-RULES.md).
- Version impact: patch: a bug fix in the phone attach sheet, no new behaviour.

## Goal

On the Android QA app 1.0.5 (photo-pick-v1, #607), 📎 → 사진 보관함 opens the system photo picker; after Done nothing is
attached, no message, no upload. The pick must survive the sheet closing and the app going to the background while the
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

Filled in at the end.
