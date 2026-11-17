# Save to team folder: one quiet action on every room file

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/room-file-save-btn (the owner)

- **Ask:** files sent in rooms, DMs and threads live in the rooms' own storage (`.system/rooms/`), never in the team
  folder, so the team's files do not build up. The owner chose "a Save to team folder action on each file, with an
  AI-suggested place, one tap", not a card that pops up by itself.
- **Rule (screens):** a file chip has a small save icon beside its download icon, shown on hover and keyboard focus on a
  computer (it keeps its place, so the chip never jumps); on a touch screen it is hidden and the file's long-press menu
  has **Save to team folder**. Every file's menu (right-click, menu key, long press) has it, pictures included. No card,
  banner or AI message ever offers it. One shared place: `RoomMessages.tsx` FileChip/RoomPicture and `FileMenu.tsx`, so
  the timeline, DMs, group chats and threads all get it. Not in the AI chat: its attachments are already in the person's
  own team folder.
- **The sheet:** "Where should this go?" (ko 어디에 저장할까요?): the message's files (one sheet for all of them; those
  already saved say so and are not copied again), one folder pre-selected and labelled **Suggested** (or **Recent**: a
  folder the person saved into lately, when no name fits), **Choose another folder…** (the existing folder picker), Cancel
  and Save. When people outside the conversation can open the folder: "12 people outside this conversation can see this
  folder." A personal-looking file: no folder picked and a gentle note; the person picks and may still save.
- **Already saved:** the chip's icon becomes a quiet link with the folder's name ("In team folder · <path>" in its
  tooltip and accessible name) that opens the file; the menu item becomes **Open in team folder**. Kept server-side in
  `room_file_saves` (migration 415: file id, team path, sha256, size, and the copy's identity on disk when its bytes were last checked, so a room open does not hash again), written by the person's save and by the AI's
  save_room_file. A row only says where to look: every read checks the file is still there with the same bytes and the
  viewer may read it, so a moved, changed or deleted copy stops counting, and a viewer who cannot open that folder is
  never told where it went.
- **The suggestion has no AI call.** It reuses the Move picker's name matching (`team-files/move-suggest.ts`,
  `suggestForNames`): the file's name, then the room's name (not a DM's: a person's name) and the words of its message and
  thread root, against the folders the person can write, their file names and the person's own file-list lines. Free,
  well under 2 s, the same with the AI off, and no prompt-injection path from a message. The Move picker's rate limit
  applies to every plan (30 a minute per person). The owner's "AI-suggested" is met by the file list the AI keeps per folder; a model call would add cost and
  latency for little (Dropbox and our own Move picker found name rules beat a model here).
- **Sensitive-looking files:** an ID card, passport, driver's licence, bank book, resident or family register (by the
  file name or the message's words, in the six languages) or a resident registration number (in those words, or in a
  small text file's content) get no suggestion. Pictures, PDFs and spreadsheets are not read for it (room files have no
  OCR text). "Personal information" is not a trigger word: a privacy policy, or a privacy team's room, would lose every
  suggestion.
- **Server:** `GET /api/rooms/:id/saved-files`, `POST /api/rooms/:id/save-plan`, `POST /api/rooms/:id/save-to-team`
  (`rooms/save-to-team.ts`). The copy takes save_room_file's read checks (findRoomFile with the person's member row: a
  room they are in now, the message visible to them, not deleted; RoomFiles.open again right before the bytes; not on the
  download-only list; at most 50 MB) and the AI's byte save (`placeProduced`: write access checked again, the storage
  check, never an overwrite: a different file of that name stays and the copy goes beside it; the same bytes already
  there, at its own name or as a copy made beside another file earlier, count as saved, no second copy; two files with
  one name in one message both stay, the second beside the first). The folder must exist, be one the person can see and
  write, never under skills/ or a personal skills folder,
  never `.system/`, and the target never an instruction file name (CLAUDE.md and the like). Every file and the folder are
  checked before anything is copied. The file history records it (`save_room_file`, by the person). The sheet showing
  the audience is the confirmation; there is no second card.
- **Guests:** cannot save (their AI has no save_room_file either). The three endpoints are not in
  `auth/guest-endpoints.ts` (403), each function checks again, and the screens show no save for a guest.
- **Screens, small rules:** the desktop icon takes no space until the chip is hovered or focused; on a phone a saved
  file's link is the folder icon alone (the file's name stays readable), its place in the accessible name. What was
  saved is kept per signed-in person in the tab and forgotten when someone else signs in.
- **Left out:** live updates of "In team folder" for other people (they see it on the next room load); the image viewer's
  own buttons; OCR for the sensitivity hint.
- **Tests:** `tests/unit/b-rooms-save-to-team.test.ts` (bytes, same bytes, beside a different file, several files,
  outside the room, guest, other group's folder, skills/, read-only, `.system`, path tricks, instruction name,
  quarantine, unsent upload, deleted message, all-or-nothing, suggestion, audience, sensitive, per-viewer saved list),
  the permission matrix cases in `tests/security/lib/rooms-cases.ts`, web `test/unit/room-save-sheet.test.tsx`, e2e
  `web/test/e2e/room-save-to-team.spec.ts`.
- **Version impact:** minor (three endpoints, one additive table).
