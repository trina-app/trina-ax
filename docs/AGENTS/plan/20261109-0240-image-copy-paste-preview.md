# Copy a photo with a right-click in the desktop app; a pasted photo shows as a picture above the box

- Date (UTC): 2026-11-09 02:40
- Branch: `fix/image-copy-paste-preview`
- Status: done
- Where: trina-ax core (`desktop/src/`, `web/src/components/rooms/RoomComposer.tsx`, `web/src/components/chat/Composer.tsx`).
  Why: the desktop shell and the message boxes are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A context menu where there was none and a picture in the room box's file chip; no API, setting
  or data change.

## Goal

Two things the owner met in team rooms:

1. In the desktop app a right-click on a photo (or a link, or selected text) does nothing: Electron shows no menu unless
   the app builds one, and the app has no `context-menu` handler. In a browser the native menu works.
2. A photo pasted into a room's box shows as a file chip ("image.png" and a spinner), not as a picture. The AI chat's box
   already shows a small picture in its chip.

## Scope

In:
- Desktop: a small context menu on the team page, built from Electron's context-menu facts. A photo: 이미지 복사,
  이미지 저장…; a link: 링크 복사; selected text: 복사; a text field: 잘라내기 / 복사 / 붙여넣기 / 모두 선택. Nothing
  else (no Inspect, no "open link"). Strings in the five languages. The template is built by a pure function in
  `desktop/src/common/` and unit-tested.
- 이미지 저장… only for an image the team page itself serves (the team or office address, or a `blob:` / `data:` image of
  that page); an image from elsewhere (an artifact's) can be copied, not saved through the app.
- Web: check nothing swallows the browser's own menu on the message photo and the preview panel's photo (found nothing:
  the long press only blocks the menu right after a touch).
- Web: the room box's chip shows the picture at once for an image (the same small picture as the AI chat's chip, one
  component for both), while the upload runs, with its ✕. A picture the browser cannot draw (HEIC in Chrome) falls back
  to the file icon. A paste whose `clipboardData.files` is empty takes the files of `clipboardData.items`.

Out: the in-app browser pane's tabs keep no menu (the AI's browser, its own rules). The message's thumbnail copies and
saves the thumbnail (what it shows, as a browser does); the original is in the preview panel, which copies it.

## Steps

1. Reproduce the paste in Chromium (real clipboard: a screenshot, an image with HTML) in both boxes.
2. `desktop/src/common/context-menu.ts` (pure template) + `desktop/src/main/context-menu.ts` (wires it to the team view).
3. Strings in `desktop/src/common/i18n.ts` (ko, en, id, ja, es).
4. Shared `ChipThumb`; the room chip uses it; paste helper.
5. Unit tests (desktop template, paste helper), e2e: pasting shows the picture before the upload ends (both boxes).
6. CHANGELOG, DECISIONS, screenshots.

## Risks

- The menu runs in the main process on the team page's facts: no navigation, no window, no external open; saving only the
  page's own images; copying a link is text.
- Five languages for the new menu words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/e-desktop-*.test.ts`, `bun run test:web`,
`bun run build:web`, the rooms and chat composer e2e specs and the new paste spec.

## Result

Built as planned. What differs or was found:
- The text items call the right-clicked page's own `cut / copy / paste / selectAll` instead of Electron's edit roles: a
  role goes to whichever view of the window has the focus.
- Reproduced in Chromium: both boxes put a pasted picture in the row at once (nothing waited for the upload); the room's
  chip only showed a file icon and "image.png". The fix is that chip drawing the picture, as the AI chat's already did.
- Nothing in the web app blocked the browser's own menu on a photo; an e2e now guards it.
- Desktop e2e `context-menu.spec.ts` checks the menu in the real app (Electron 44), including the save of a `blob:` original.
- After review: the photo items only where the team page's top frame was right-clicked (an artifact frame could
  otherwise get a signed-in team address saved through the app); the app's own screens get the text and link items.
