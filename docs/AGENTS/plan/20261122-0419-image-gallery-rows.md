# Several pictures in one message: an even gallery, like Slack

- Date (UTC): 2026-11-22 04:19
- Branch: `feat/image-gallery-rows`
- Status: in progress
- Where: `web/src/components/rooms/`. Why: how a room message draws its pictures is web UI (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A display fix in the message list; no API, data or setting changes.

## Goal

A message with several pictures (three screenshots, a wide one and a tall one) shows each at its own shape and size
today: different heights, wide empty gaps, one picture alone on a second line. The owner asked for Slack's look: the
pictures of a message in rows of one height, cropped to fill, with even gaps and both edges lined up.

## Scope

In:
- Rooms, DMs, groups, project rooms and threads (one `Files` component in `RoomMessages.tsx` draws them all).
- 1 picture: unchanged (its own shape, at most 320 × 240).
- 2 or more: rows of 2 or 3 (2 → one row of 2, 3 → one row of 3, 4 → 2 + 2, 5 → 3 + 2, 7 → 3 + 2 + 2, at most 10
  per message, ROOM_FILES_MAX), each row as wide as the gallery (at most 480 px, the column's width on a phone).
  In a row every tile has the same height; widths follow each picture's shape, kept between tall (0.6) and wide (1.9),
  then widened or narrowed together so the row is between 120 and 240 px high at 480 px. The picture fills its tile
  (`object-fit: cover`), rounded corners, 4 px gaps.
- The space is held from the stored width and height before the thumbnails load (CSS `aspect-ratio`; no measuring in
  script). A picture without a stored size counts as square.
- Click, keyboard, the menu (right-click, long press), the viewer with the uncropped original and ← → through the
  pictures stay as they are: each tile is the same button the single picture uses.
- Files that are not pictures stay chips under the gallery.

Out:
- "N files · Download all" header: we have no one-step download of several room files; several separate downloads are
  blocked by browsers. Not added (lean UI).
- The AI chat (Trina chat) attachments: they already sit in one fixed box each (`h-24 w-36`, cropped), the same size as
  file cards, so they do not look ragged. Unchanged.

## Steps

1. `galleryRows(files)` in `web/src/lib/imageGallery.ts`: the rows and each tile's ratio (pure, unit tested).
2. `Files` in `RoomMessages.tsx`: 2+ pictures go to a `PictureGallery`; each tile reuses the picture's button, menu and
   viewer item.
3. Unit tests for the rows and for the rendered gallery; screenshots of 1–5 pictures at 1440 and 390, light and dark.

## Decisions

None new. Tiles keep the picture's border and the menu of the single picture. "Only in this conversation" shows once
under the gallery when every picture in it is kept in the room; a mix keeps it in each tile's label.

## Risks

Phone width: the gallery is `width: 100%` up to 480 px, so it never scrolls sideways. A transparent picture in a tile
loses the soft box once it loads, like the single picture.

## Tests

`bun run typecheck`, `bun run check:prepush`, `web/test/unit/room-messages.test.tsx`, a new unit test for the rows,
the room e2e specs that open pictures (`image-viewer`, `room-files-open`, `file-menu`, `room-transparent-image`).

## Result

(to fill in)
