# Drop a file anywhere in a room

- Date (UTC): 2026-11-10 04:35
- Branch: `feat/room-drop-anywhere`
- Status: in progress
- Where: trina-ax core, web only (`web/src/components/chat/ComposerFiles.tsx` useFileDrop, a new
  `web/src/components/FileDropZone.tsx`, the room page, thread panel, side chat, the AI chat page, `web/src/main.tsx`).
  Why: the room's message box and the AI chat box are core chat features (docs/REPOSITORY-RULES.md).
- Version impact: minor. A visible UX change; no API or data change.

## Goal

A teammate asked that a screenshot dragged into a room attaches by itself. Today a file attaches only when it lands on
the room's message box. After this, a file dropped anywhere over the room's column (header, messages, box) goes into
that room's box, as if it was dropped on the box.

## Scope

In:
- The drop hook (`useFileDrop`): reacts only to drags that carry `Files` (or, where asked, a team file), never to text,
  links or the app's own drags; a drag counter plus `relatedTarget` so moving over child elements does not flicker; off
  on drop, dragleave, dragend and Escape; the nearest zone wins (an event a nearer zone took is left alone); events from
  a portal (a dialog over the page) are not the zone's.
- `FileDropZone`: a zone around a column that routes a drop to the message box inside it (the box registers itself)
  and draws one light overlay with a dashed border and one line, "여기에 놓으면 첨부돼요" (five languages), in the
  app's existing drop look (`bg-accent-soft/70`, dashed `accent/55`, as the skills sheets).
- The room column, the thread panel and the ✦ side chat are each a zone; the nearest one wins.
- Same rules as the box: count (`ROOM_FILES_MAX`, `MESSAGE_ATTACHMENTS_MAX`), size (checked on drop by the box, as
  today), a shared chat's team-files-only rule, and no box at all (a thread that takes no reply, a chat in the trash, a
  read-only shared chat). Where the box would refuse everything, the overlay says why and the drop does nothing.
- The full AI chat page (`pages/Chat.tsx`) took drops on its box only: its column becomes a zone too. Team files
  dragged from the file screen still go on the box only.
- A page-wide guard: a file dropped outside every zone is not opened by the browser in place of the app (only
  `preventDefault` on file drags that nobody took).

Out: phones (no change), paste (unchanged), Home's new-chat box (keeps its own drop on the box).

## Steps

1. Plan (this file).
2. Extend `useFileDrop` (options object) and add `FileDropZone` + `useDropTarget` + the overlay.
3. Room page, thread panel, side chat, Chat page; RoomComposer and Composer register with the zone around them and
   keep their own box drop when outside one.
4. `guardFileDrops` in `web/src/main.tsx`.
5. Strings in ko, en, es, id, ja.
6. Unit tests, e2e spec with screenshots, CHANGELOG.

## Risks

No migration. The five languages. Desktop app: a file dropped outside a zone used to navigate the window to `file://`,
which the desktop's navigation guard opened outside the app; now nothing happens. Other drop targets (Files screen,
onboarding, skills sheets) call `preventDefault` themselves, so the guard leaves them alone.

## Tests

`bun run typecheck`, `bun run check:i18n`, web unit tests (the hook, the overlay on and off without flicker, routing to
room / thread / side chat, non-file drags ignored), e2e: drop an image on the message list, the chip shows in the room
box, send, the picture shows in the room; the room, composer and side-chat specs. Screenshots of the overlay at 1440
light and dark.

## Result

Filled in at the end.
