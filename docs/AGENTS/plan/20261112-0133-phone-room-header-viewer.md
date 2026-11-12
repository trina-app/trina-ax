# Phones: the room header shows only ‹, the name, ✦ and ⋯; the file viewer has its actions in a bottom bar

- Date (UTC): 2026-11-12 01:33
- Branch: `fix/phone-room-header-viewer`
- Status: done
- Where: trina-ax/web. Why: the room page and the file viewer are the web app's, which the phone app shows (no
  server change).
- Version impact: patch. Phone layout fixes only; computers are unchanged.

## Goal

QA TC-257 (phone audit 11-11): in a room with a long name the header holds up to four icons and leaves the name 158 of
344 px; the bell and ⋯ › 알림 설정 are the same thing; 이름 바꾸기 is both in ⋯ and in the room's info. The file
viewer's bar crams ‹ 2/3 › ⬇ ✦ 💬 ✕ beside the name, so a PDF's name shows as "트리나_…"; a PDF on a touch phone shows
zoom buttons and arrows although pinch and swipe work.

## Scope

In (phones, below 768 px; computers unchanged):

1. Room header (`pages/Room.tsx`): ‹, the name with the member count under it, ✦ and ⋯ only.
   - The bell is not in the header; ⋯ › 알림 설정 (one entry, with the level now after it) opens the same four
     choices as a sheet. A small crossed-out bell after the name says the room is muted.
   - The "new replies in threads" button moves into ⋯ (first entry, with the count), and ⋯ carries a dot while there
     are any.
   - ⋯ has no 이름 바꾸기 (the name opens the room's info, where the name is changed).
2. File viewer (`components/ImageViewer.tsx`):
   - Top: the file's name (up to two lines, breaking anywhere) and who sent it and when.
   - Bottom bar with 44 px targets: "2 / 3", download, ✦, 💬, ✕. 복사 and "원본을 새 탭에서" stay on computers.
   - No edge arrows on a touch phone (a swipe steps); a document's ‹ › only where a swipe cannot step (an HTML or
     SVG frame).
   - The PDF zoom toolbar stays hidden on a touch phone (already so on dev: `max-md:pointer-coarse:hidden`).
   - `data-own-zoom` stays on the picture stage: this branch merges #524 (`fix/phone-no-page-zoom`), which adds it
     in the same lines.
3. e2e: `phone-room-header.cases.ts` with the row's steps, in Chromium and WebKit at 390×844 with touch; existing
   phone specs that clicked the bell or the arrows follow the new layout.

Out: PDF/HTML preview pinch (TC-259, another session); the room's side chat and message box; the 💬 / ✦ sheet itself.

## Steps

1. Plan (this file).
2. Merge `origin/fix/phone-no-page-zoom` (#524) so the stage lines can change without a conflict.
3. Room header and ⋯ items (`RoomMenu.tsx` gets the phone header's options).
4. Viewer: top name block, bottom bar, arrows.
5. e2e (Chromium + WebKit), update the specs that used the bell or the phone arrows.
6. Checks; `changes/phone-room-header-viewer.md`; PR.

## Risks

- Desktop must stay as it is: the phone layout is chosen by `useMediaQuery('(min-width: 768px)')` (read at once,
  no flash) or `max-md:`; compare 1440 screenshots.
- The bell's menu still opens from ⋯ on phones with its button hidden (the same way a row's level menu does: `bare`).
- Back still closes the viewer (#452) and a sheet first; nothing changes in `lib/imageViewer.ts`.
- Stacked on #524 until it merges.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the
phone specs: `phone-room-header` (Chromium, WebKit), `room-file-viewer`, `image-viewer`, `phone-overlay-back`,
`room-leave-hide`, `phone-previews-fit`.

## Result

PR: https://github.com/trina-app/trina-ax/pull/533

Built as planned, phones only; 1440 screenshots of the room, its ⋯ menu, a picture and a PDF in the viewer are
pixel-identical to dev.

- Room header: the bell's menu stays mounted without a button on phones (`bare`, as a row's), so ⋯ › 알림 설정 opens
  it as a sheet and the keyboard goes back to ⋯. `RoomMenu` takes `phone` (no 이름 바꾸기, the level after 알림 설정,
  the threads entry first), `dot` and `buttonRef`; `MenuButton` takes `dot`.
- Viewer: one set of actions, in the top bar on computers and in the bottom bar below 768 px. A phone's document bar is
  4.25rem (two lines of name and the line under it); the stage sits between the two bars. The sender's picture shows on
  phones again (the bar has the room now).
- The PDF toolbar was already hidden on touch phones on dev (`max-md:pointer-coarse:hidden`); the e2e checks it.
- Stacked on #524 (merged into this branch) for the stage lines and `data-own-zoom`.
- e2e: `phone-room-header.cases.ts` (Chromium and WebKit, 390×844 touch); `phone-overlay-back.cases.ts`,
  `room-file-viewer.spec.ts`, `room-leave-hide.spec.ts` and `image-viewer.spec.ts` follow the new layout.
