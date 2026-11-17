# Save to team folder: one quiet action on every room file

- Date (UTC): 2026-11-17 10:12
- Branch: `feat/room-file-save-btn`
- Status: in progress
- Where: Team AX core (`server/src/rooms/save-to-team.ts`, `server/src/routes/rooms.ts`,
  `server/src/team-files/move-suggest.ts`, `shared/src/api/rooms.ts`, `web/src/components/rooms/RoomMessages.tsx`,
  `web/src/components/FileMenu.tsx`, a new `web/src/components/rooms/SaveToTeamSheet.tsx`). Why: chat, permissions and
  files are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. Three new endpoints and one additive table; nothing removed.

## Goal

Files sent in rooms, DMs and threads live in the room's own storage (outside the team folder) and never build up the
team's files. The owner chose: a "Save to team folder" action on each file, with one suggested place and one tap. No card
that pops up by itself, no banner, no AI card.

## Scope

In:
- On a file chip (room, DM, thread): a small save icon next to the download icon, shown on hover and keyboard focus on a
  computer. In the file's right-click / long-press menu everywhere (pictures too): "Save to team folder".
- Already saved (the same file, tracked per room file, still there with the same bytes, and the viewer can open it): the
  icon becomes a quiet "In team folder · <folder>" link that opens it; the menu item opens it too.
- The sheet "Where should this go?": one folder pre-selected (Suggested, or Recent when nothing fits), "Choose another
  folder…" (the existing FolderPicker), Cancel, Save. The folder's audience when people outside the conversation can see
  it. One sheet for all files of the message.
- Suggestion without an AI call: reuse the Move picker's suggester (`team-files/move-suggest.ts`, names and file-list
  lines against the folders the person can write), fed with the file name plus the room's name and the message's words.
  Sensitive-looking files (ID card, passport, bank book, resident numbers: by name, message words or a small text file's
  content) get no suggestion and a gentle note.
- Server: `POST /api/rooms/:id/save-plan` (the sheet's files, suggestion, sensitivity, the chosen folder's audience),
  `POST /api/rooms/:id/save-to-team` (the copy), `GET /api/rooms/:id/saved-files` (what this viewer sees as saved).
  The copy uses save_room_file's checks and the AI's byte save (`placeProduced`): room membership and the message
  visible to the person, not quarantined, ≤ 50 MB, never skills/ or an instruction file, write access checked again, the
  storage check, never an overwrite (a copy next to a different file), the same bytes already there count as saved.
  Guests: not allowed (as save_room_file is withheld from a guest's AI); not in GUEST_ENDPOINTS.
- Table `room_file_saves` (file id, team path, sha256, saved at). The AI's save_room_file records there too (one line in
  `chat/room-tools.ts`).
- Copy English first, then ko/zh/ja/es/id.

Out:
- The AI chat's own attachments: they are already in the person's team folder (`users/<me>/.attachments`).
- The image viewer's own buttons (its menu already shares FileMenu; left as is).
- Live updates of "In team folder" for other people (they see it on the next room open).
- OCR of pictures and PDFs for the sensitivity hint (room files have no OCR text; name and message words only).

## Steps

1. Tests first: `tests/unit/b-rooms-save-to-team.test.ts`, web unit test for the sheet/menu logic.
2. Migration `414_b_room_file_saves.sql`; `rooms/save-to-team.ts`; extract `suggestFolders` from move-suggest.
3. Contract, routes, guest list (left out), security matrix cases, features.ts, `docs:api`.
4. Web: store of saved files per room, FileChip icon, FileMenu item, SaveToTeamSheet, mock server handlers.
5. i18n in six languages, changes fragment, decision note, QA rows.
6. Shots (ui-polish) and an independent review.

## Risks

Room content copied into team folders: every read check is the room_file one, every write check placeProduced's; the
audience is shown before the save. The suggestion reads only folders the person can write and lines their own file list
shows. No AI call, so no cost and no prompt-injection path.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `MIGRATIONS_BASE=origin/dev bun run check:migrations`,
`bun run check:prepush`; server tests under Bun 1.3.12 (`b-rooms-save-to-team`, `b-rooms-team-file`, `b-chat-rooms-save`,
move-suggest tests, security matrix rooms cases, guest endpoints); web unit tests; e2e with workers: 1.

## Result

(filled in at the end)
