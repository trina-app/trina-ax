# A picture attached in a message box shows as a 64 px square, not a 32 px dot in a chip

- Date (UTC): 2026-11-09 06:19
- Branch: `fix/bigger-paste-preview`
- Status: done
- Where: trina-ax core (`web/src/components/ChipThumb.tsx`, `web/src/components/rooms/RoomComposer.tsx`,
  `web/src/components/chat/Composer.tsx`). Why: the message boxes are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bigger picture above the box; no API, setting or data change.

## Goal

Since #234 a pasted or picked picture shows as itself in its chip above the box, in a room and in the AI chat. The
picture is 32 px: too small to tell which screenshot it is. The owner: at least 64.

## Scope

In:
- A picture (a local image file, or a room photo the server gave back) shows as a 64 × 64 square of the picture
  (`object-cover`, rounded), as Slack and iMessage show one before it is sent: no chip around it. Its ✕ sits on the
  corner, easy to hit (44 px on phones). While it uploads a spinner sits over it (the AI chat's percent under it when
  known). A failed upload gets a red edge and its reason beside it. The name is the picture's tip (hover) and alt text;
  the size and status stay for screen readers.
- In the AI chat a click on the picture opens it, as a click on its name did.
- Three pictures fit one row at 390 px; a non-image file keeps its compact chip, centred on the row beside them.
- A picture the browser cannot draw (HEIC in Chrome) shows a 64 px square with a picture icon.

Out: the sent message's pictures (unchanged), other file chips.

## Steps

1. `ChipThumb.tsx`: the 64 px picture and one `PictureTile` (picture, spinner, ✕) for both boxes.
2. Room and AI chat boxes: a picture renders as a tile; the row centres its items.
3. e2e: `composer-paste-preview.spec.ts` checks the 64 px square and three pictures in one row at 390 px.
4. CHANGELOG, DECISIONS, screenshots (room 1440 light, AI chat with three pictures 390 light).

## Risks

- Mixed rows (pictures and files) must not stretch the file chips.
- The ✕ must stay reachable on phones and by keyboard; no new strings (the existing ✕ and status words are reused).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the composer
e2e specs (`composer-paste-preview`, `chat`, `upload-progress`, `room-mention-all`, `room-mentions`, `chat-look`).

## Result

Built as planned. What differs or was found:
- The spinner sits on a small dark pill over a picture a shade darker: a white spinner on a plain dark wash was lost on
  the light parts of a picture. The AI chat's percent shows in the pill when it is known; its "준비 중" / "마무리 중"
  do not (too wide for 64 px in some languages). Screen readers hear "첨부하는 중" as before.
- The ✕ dot stands 6 px out of the corner; the row item keeps that room so it touches neither the box's edge nor the
  next picture. Its tap area is an `::after` (36 px, 44 px on phones), reaching further out to the right than over the
  picture, not `touch-hit`, which sets `position: relative` on phones.
- After review: the AI chat's empty alert line no longer adds a gap after each picture (14 px between pictures in both
  boxes), a picture that cannot be drawn keeps its name for screen readers, and the spec checks a file chip on a
  picture's row and which picture a ✕ took out.
- Screenshots: the room's box with one pasted picture at 1440 light, the AI chat's box with three at 390 light; also
  checked dark at 390, a failed upload and a HEIC fallback.
