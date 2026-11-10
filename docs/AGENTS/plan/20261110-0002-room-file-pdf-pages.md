# room_file reads a scanned PDF's pages as images, like a team-folder read

- Date (UTC): 2026-11-10 00:02
- Branch: `fix/room-file-pdf-pages`
- Status: in progress
- Where: trina-ax core (`server/src/chat/room-tools.ts`, `server/src/files/service.ts`, `shared/src/tools.ts`). Why:
  chat, files and the AI's tools are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new, backward-compatible capability of the AI (scanned room PDFs become readable); no API,
  data or connector change.

## Goal

A PDF sent in a room gives the AI its text layer only (`room_file`), so a scanned PDF someone posts in a room cannot be
read: the AI says to save it to the team folder first. Team-folder reads already show pages without a text layer as
images (docs/DECISIONS.md "AI sees images and PDF pages"). The owner approved the same for room files.

## Scope

In:
- `room_file` (the person's own chat, a side chat, and a room's own session) on a PDF: the team read's page contract
  through one shared helper taken out of `FileService.readPdf` (no copy of its loop): each page's text layer as text,
  pages without one as images, `pages` ("3", "1-5", "1-3,7", at most 20), `as_images`, the tool output limit
  (24,000 tokens, pages that do not fit are named for the next call), the per-turn image budget (shared with team
  reads), the team switch `aiVision` and the engine (`visionBlock`), the same notes.
- `offset` keeps its meaning (characters of the text): with `offset`, or a PDF over 10 pages read without `pages`, the
  result is the text as today, now naming the pages without a text layer and the `pages` to read them with.
- Every room check stays as it is (member now, room not archived, the message visible to the person: not deleted, not
  a hidden answer, not someone else's private preview; the safety check's quarantine; the live account), and is run
  again right before the result goes out (also at the socket's drain, as team reads do), for text and pixels alike.
- The tool descriptions; DECISIONS and CHANGELOG.

Out:
- The remote MCP connector's `room_file` keeps its schema and its text-only answer (a connection never takes pixels).
- No OCR change: a Mac with image viewing off reads scanned pages with Apple Vision, as the team read does.

## Steps

1. `FileService.pdfPagesForModel`: the page loop of `readPdf`, given checked bytes; `readPdf` calls it.
2. `readRoomFileFor`: PDFs through `pdfLayer` + the helper; a re-check of the room checks before delivery, returned as
   `beforeDelivery` and carried by the chat tool set and `mcp/protocol.ts` to the socket.
3. `RoomFileInput` / `RoomFileHereInput` gain `pages` and `as_images`; descriptions say scanned pages come as images.
4. Tests, DECISIONS, CHANGELOG.

## Risks

Security: pixels of a room file must go only to someone who may see it now. No migration, no API change, no user-facing
strings (the notes are the read's existing ones, in five languages).

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`; new `tests/unit/room-file-pdf.test.ts`; the room, vision, side-chat,
remote MCP and security unit files.

## Result

Filled in at the end.
