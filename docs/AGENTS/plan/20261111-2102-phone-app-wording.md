# Phone app wording: no browser or desktop words inside the phone app (QA TC-264)

- Date (UTC): 2026-11-11 21:02
- Branch: `fix/phone-app-wording`
- Status: done
- Where: web/ (copy and the two message boxes). Why: the phone app is a wrapper around the web app, so the fix is in the web UI's wording choice (see docs/REPOSITORY-RULES.md)
- Version impact: patch, wording fixes with no new feature or API

## Goal

Inside the phone app, people are not told about "the browser" or "a new tab".

## Scope

In:
- Mic blocked (voice.denied): inside the phone app, point to the phone's Settings (iPhone: Settings › {product} › Microphone; Android: app settings › Permissions › Microphone), and a "Open Settings" button when the app bridge can open its Settings page (push-permission-v1, lib/mobile.ts openAppSettings). A browser keeps the browser wording.
- An answer's outside image (md.externalImageHint): in the app "Tap to open it in your browser" (it leaves the app); desktop and browser keep "new tab".
- A folder's ⋯ menu: "Start a chat with this folder" instead of "…this file", in every locale (files.chatWith → files.chatWithFolder).

Out: ConnectorsView (PR #399), the empty folder wording (TC-207), other "new tab" strings.

## Steps

1. lib/appWording.ts: pure key choices (app/platform → key), unit tested.
2. useVoiceInput returns the denied text when Settings can be opened; Composer and RoomComposer show the button beside it.
3. Markdown ExternalImage and Files menu use the new keys. en first, then ko, ja, es, id.

## Result

Done as planned, one change: the iPhone/Android choice reads the app bridge's own `platform` (lib/mobile.ts mobileApp), not the user agent. Unit test web/test/unit/phone-app-wording.test.tsx; Playwright web/test/e2e/phone-app-wording.spec.ts at 1440 and 390×844 (browser vs app mic note, the Settings button sends `open-settings`, folder vs file menu).
