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
  applies to every plan (30 a minute per person). The coordinator (11-17) kept it with no model call: the label is
  "Suggested" (ko 추천), never "AI".
- **Sensitive-looking files:** an ID card, passport, driver's licence, bank book (and its copy), payslip, employment
  certificate, seal certificate, resident register copy (등본/초본), resident or family register (by the
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
  one name in one message both stay, the second beside the first). A copy beside a different file is named
  "name (2).ext", "name (3).ext" (`team-files/place.ts freeName`), not the AI's "name (conflict copy - <person> …)": the
  person saved it themselves (the coordinator, 11-17; only this path). The folder must exist, be one the person can see and
  write, never under skills/ or a personal skills folder,
  never `.system/`, and the target never an instruction file name (CLAUDE.md and the like). Every file and the folder are
  checked before anything is copied. The file history records it (`save_room_file`, by the person). The sheet showing
  the audience is the confirmation; there is no second card.
- **After hands-on QA (11-17, branch fix/save-to-team-bugs; TC-4803..4805):**
  - *Identical files are one file.* Two files of a save with the same bytes are copied once and both point at that copy
    (the second `existed: true`, the same path); the plan marks the second `sameAs` the first, the sheet says "Same file
    as above" (it has no tick of its own) and the toast says how many were the same, so it was saved once. The "already
    there" check looks at every room file's tracked place with these bytes in the chosen folder, not only this file's, so
    the same bytes sent again later find the earlier copy and the "(n)" numbering never skips or doubles.
  - *Personal is per file.* `files[].sensitive` per file; the suggestion is computed from the files that look ordinary,
    and is null only when every file to save looks personal. On a sheet of two or more files to save, each has a tick;
    personal-looking ones start unticked when ordinary ones are there (so one click never takes them into the suggested
    folder), with "Looks personal" on the row and one note. A one-file sheet has no tick.
  - *More personal documents:* employment and salary contracts, HR records, CVs, payroll and pay words, health check-ups,
    medical certificates, transcripts, in the six languages (`rooms/sensitive.ts`). Broad words (급여, 연봉, salary,
    payroll, CV, resume, gaji, salario …) count in the file name only, never in chat words ("광고 성적" is an ad's
    performance). An HR, contract or medical word plus a Korean personal name at the start or end of the name
    (2–4 syllables after "_", a space or "-", a common surname first, not an ordinary word like 양식 or a team or company
    name like 마케팅팀 or 삼성전자) counts too, in any position, in brackets, before a job title or 님, after NFKC (full
    width, a Mac upload's NFD). 계약/용역 need a three-syllable name (company names are often two). A false alarm costs one
    suggestion; a miss could publish a person's contract.
    Known limits (independent review, 11-18): a name glued to the word ("홍길동계약서"), English names
    ("Contract_John_Smith"), visas; three-syllable company names ("계약서_이마트") still lose their suggestion.
  - *Better names, still no model:* common work folders match across languages (회의록 ↔ meeting notes ↔ minutes ↔ 議事録,
    견적 ↔ quotes, 계약 ↔ contracts, 인보이스/세금계산서 ↔ invoices, 보고서 ↔ reports, 디자인 ↔ design, 마케팅 ↔
    marketing; `team-files/move-suggest.ts` CONCEPTS, also used by the Move picker): a folder whose name is that group
    counts as fully named, by the file's own name only (never a description or the room's words); Latin words match
    whole terms or their plurals, never a cut-off ("repo" is not "report"); a bare 회의 only at a word's end. For the save sheet's one folder, a folder is Suggested only when it fits every ordinary file
    (`rank(..., { every: true })`: the lowest score, not the mean); otherwise Recent, the fallback only.
- **Guests:** cannot save (their AI has no save_room_file either). The three endpoints are not in
  `auth/guest-endpoints.ts` (403), each function checks again, and the screens show no save for a guest.
- **Screens, small rules:** on a pointer device the icon's 24px is always kept (invisible until the chip is hovered or
  focused), so hovering never changes the chip's width or re-wraps a row of chips (the coordinator, 11-17); a touch
  screen has no icon; on a phone a saved
  file's link is the folder icon alone (the file's name stays readable), its place in the accessible name. What was
  saved is kept per signed-in person in the tab and forgotten when someone else signs in.
- **Left out:** live updates of "In team folder" for other people (they see it on the next room load); the image viewer's
  own buttons; OCR for the sensitivity hint.
- **Tests:** `tests/unit/b-rooms-save-to-team.test.ts` (QA 11-17: identical files, the numbering, HR documents and names, names across languages, every-file rule, per-file personal; bytes, same bytes, beside a different file, several files,
  outside the room, guest, other group's folder, skills/, read-only, `.system`, path tricks, instruction name,
  quarantine, unsent upload, deleted message, all-or-nothing, suggestion, audience, sensitive, per-viewer saved list),
  the permission matrix cases in `tests/security/lib/rooms-cases.ts`, `tests/unit/c-move-suggest.test.ts` (work-folder groups, every), web `test/unit/room-save-sheet.test.tsx`, e2e
  `web/test/e2e/room-save-to-team.spec.ts`.
- **Version impact:** minor (three endpoints, one additive table).
