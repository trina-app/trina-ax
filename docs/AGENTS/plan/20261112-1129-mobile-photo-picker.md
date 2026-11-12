# The phone app's own photo picker for 사진 보관함 (QA TC-251)

- Date (UTC): 2026-11-12 11:29
- Branch: `feat/mobile-photo-picker`
- Status: done
- Where: trina-ax `mobile/` and `web/` (common code, not `editions/trina/`). Why: the phone app and its bridge are
  shared by every edition, and the web attach sheet is the same in every message box (see docs/REPOSITORY-RULES.md).
- Version impact: minor for the web app (a new optional bridge capability the page uses when the app offers it; older
  apps keep the file input). The store app goes to 1.0.5 (`mobile/app.config.ts`).

## Goal

TC-251: every message box has one attach sheet (사진 보관함 / 사진 찍기 / 파일 / 팀 파일), and each row opens one picker,
with no second iOS menu. PR #439 made the sheet. On the iPhone, 사진 보관함 is `<input type=file accept=image/*,video/*>`,
and WebKit first shows its own small menu (Photo Library / Take Photo / Choose File) before the library. Only the app can
skip it: with this change the app opens the system photo picker itself (PHPicker on iOS, the Photo Picker on Android)
and hands the picked files to the page, which uploads them as if the input had given them.

## Scope

In:
- `expo-image-picker` 58.0.10 (the SDK 58 `bundledNativeModules.json` range `~58.0.10`).
- A new optional capability `photo-pick-v1` (not in the required `MOBILE_CAPABILITIES`, so `validConfig` keeps
  accepting older apps). Messages: `photo-pick` (limit) → the picked files' names, types and sizes, and the names of
  any left out for size; `photo-chunk` (sequential, one in flight) → base64 bytes; `photo-done` → the app deletes its
  copies. Cancelled = an empty list, no error.
- Limits: 50 MiB per file (the bridge's `MAX_FILE_BYTES`, also the room upload limit), 200 MiB per pick, at most 20 files
  (`MESSAGE_ATTACHMENTS_MAX`; the box asks for what it still has room for), 1 MiB per reply chunk (small for
  `injectJavaScript`), 60 s idle.
- Images and videos (the web input takes `image/*,video/*`). iOS: `preferredAssetRepresentationMode: compatible` turns
  HEIC into JPEG (and HEVC into H.264), and quality 0.9 re-encodes the JPEG (location and other metadata go). Android:
  the original bytes, as the file input gave them, so GIFs and WebPs stay intact.
- Fencing like file transfers: page navigation, a session reset or a team change drops the pick and deletes the copies;
  replies carry protocol, nonce, generation and id; the page checks each chunk's exact length.
- Web: `AttachSheet` calls the bridge for 사진 보관함 when `mobileApp()` offers `photo-pick-v1`, and passes the files to
  the same `onFiles` the input uses (AI chat, room, thread, side chat). Without it, nothing changes.
- `mobile/app.config.ts` version 1.0.5; README contract and "Before distribution, verify".

Out: the camera row (it already opens the camera with no menu), the 파일 row, the iPhone release build itself.

## Steps

1. `mobile/src/protocol.ts`: capability, messages, reply fields, limits, validation (`validPicks`, `pickChunk`).
2. `mobile/src/photos.ts` (pure): `PhotoPicks` (one pick, sequential chunk cursor, idle timer, cancel/fence, cleanup),
   names/types, base64 encoder. `mobile/src/photo-io.ts` (native): expo-image-picker + expo-file-system reads.
3. `mobile/src/bridge.ts`: `MobileReceiver` routes the photo messages; `disable()` and `session-reset` clear the pick.
4. `mobile/App.tsx`: offer `photo-pick-v1`, pass the IO; `app.config.ts` 1.0.5 and the plugin with our own strings.
5. `web/src/lib/mobile.ts`: `appPicksPhotos()`, `pickPhotosFromApp(limit)` (epoch/nonce/generation fenced).
6. `web/src/components/chat/AttachSheet.tsx`: the app's picker when offered, a busy icon while the bytes come, short
   messages for refused access, a failure or files left out; `limit` from each box.
7. i18n in 5 locales; README and docs; `changes/mobile-photo-picker.md`.

## Risks

- Memory: the page holds the picked bytes as Blobs (at most 200 MiB per pick); base64 replies are 1 MiB each.
- iOS PHPicker needs no permission; Android's photo picker neither. A refusal (an old Android picker) gets a short message.
- No migration. No change for computers or browsers. Five locales.

## Tests

- `tests/unit/mobile-bridge.test.ts`, `mobile-security.test.ts`: protocol validation, cancel, fencing, chunk cursor,
  size limits, cleanup, receiver routing and the optional capability.
- `web/test/unit/mobile.test.ts`: the adapter with and without the capability, chunk assembly and exact lengths,
  a reset during a pick.
- `web/test/e2e/phone-photo-picker.spec.ts`: an app stub answering `photo-pick-v1`; a picked photo lands in an AI chat's
  and a room's attachments; without the capability the input opens.
- `cd mobile && npx tsc --noEmit`, `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`,
  `bun run test:web`.

## Result

Built as planned in https://github.com/trina-app/trina-ax/pull/607.

- `photo-pick-v1`: `photo-pick` → names, types, sizes and `tooBig`; sequential `photo-chunk` (`seq`, `index`,
  `offset`) → exactly that many base64 bytes; `photo-done` → the app deletes its copies. `mobile/src/photos.ts`
  (pure, tested without Expo), `mobile/src/photo-io.ts` (expo-image-picker 58.0.10, expo-file-system reads), routed in
  `MobileReceiver` and fenced with the file transfers. Startup empties the picker's cache folder.
- Web: `pickPhotosFromApp` in `web/src/lib/mobile.ts`; `AttachSheet` uses it for 사진 보관함 when offered, with a
  spinner on the button while the bytes come and one short message for files left out, a refusal or a failure.
- Differences from the plan: the Android claim about location metadata was dropped (it sends the same bytes the file
  input did); SVG is refused as a picked type; the e2e also runs in WebKit, where Playwright's route shows no file part
  bytes, so the exact upload bytes are checked in Chromium and the size and type in both.
- An Android QA build (edition qa, versionName 1.0.5) built; no device was connected, so it was not installed.
