# A video in a room shows a frame, and the player keeps the width on a phone turned sideways (QA TC-7239)

- Date (UTC): 2026-11-22 00:35
- Branch: `fix/shux-c`
- Status: done
- Where: web (rooms timeline, file viewer column). Why: a room's video was a bare file chip and, in landscape on a
  phone, the viewer's thread column left the player about 160 px (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a UI fix with no API or data change

## Goal

A video posted in a room looks like a video in the timeline (a frame with a play mark, sized like a photo's
thumbnail), and on a short screen (844 × 390) the viewer's player has the whole width.

## Scope

In: `RoomVideo` in components/rooms/RoomMessages.tsx (the browser's own frame at 0.1 s, `preload="metadata"`, click
opens the existing player; a video the browser cannot decode stays the file chip). The viewer column starts hidden when
the screen is under 500 px high (its toggle, ✦ and the thread still show it). One new word, `rooms.playVideo`.
Out: a server-made poster (the server makes thumbnails for pictures only; ffmpeg is there, but a poster for every
video, and for the ones already sent, is a bigger change). Thread replies and the AI chat's attachments.

## Steps

1. RoomVideo + roomVideoFrame in RoomMessages.tsx.
2. useViewerColumn: `open` null until asked, then columnShown(asked, short).
3. Unit tests: web/test/unit/room-video-frame.test.tsx.

## Decisions

None.

## Risks

Each video in view reads its first parts (metadata) from the room's address, with the same member check as the player.
Five app languages: one key in each.

## Tests

`bun run typecheck`, `bun run check:i18n`, the rooms unit tests, `bun run check:prepush`.

## Result

As planned.
