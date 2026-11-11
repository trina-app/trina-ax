# Phones: one attach sheet in every message box, team files in rooms, the box stays in sight, the AI picker closes

- Date (UTC): 2026-11-11 16:28
- Branch: `feat/phone-attach-sheet`
- Status: done
- Where: trina-ax `web/` (message boxes) and `server/` + `shared/` (a room route). Why: chat, files and phones are core
  (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new ability (a team file sent in a room from a phone) and one new endpoint; computers unchanged

## Goal

QA rows from the phone audit (2026-11-11):

- TC-251 (owner: "파일첨부가 일관성이 없고, 모바일 친화적이지 않긴 함"): three message boxes, three ways to attach. A room's
  📎 opens the plain file input (iOS's own menu); the AI chat's + is a small web menu whose "기기에서 올리기" opens iOS's
  menu again and "사진 찍기" repeats it; the side chat's 📎 has no team files. A room cannot take a team file at all.
- TC-252: with the keyboard up, six files and the "@" list push the text field out of a 480 px view; the room box grows
  to a fixed 200 px; the AI chat keeps its engine row and "나만 봐요" under the box while typing.
- TC-247: the AI picker's list covers the box and nothing closes it but a pick (no outside tap, Escape or Back).

## Scope

In (phones, below 768 px):

1. One attach sheet (`web/src/components/chat/AttachSheet.tsx`) on `rooms/MenuButton`'s phone sheet, in the AI chat's
   box, a room's and a thread's box, and the side chat's box: 사진 보관함 (`accept="image/*,video/*"`), 사진 찍기
   (`capture`), 파일, 팀 파일. Each row opens one picker. For iOS the 파일 row asks for any data file
   (`application/octet-stream`), which WebKit opens as its file browser at once (WKFileUploadPanel: no image or movie
   type accepted, no menu); elsewhere it takes any file as before.
2. A team file in a room: `POST /api/rooms/:id/files/team { path }` copies a team file I may read now into my room upload
   (`RoomFiles.fromTeamFile`, the "첨부해서 보내기" path of `chat/answer-share.ts`: my read access checked at the copy, a
   folder, a link, a hard-linked or quarantined file answer 404 like a missing one, ≤ 50 MB, the storage check, photo
   metadata cut out), sent by id like an upload. It answers how many other members could not open the team file (a
   count, never who), and the box says so under the files, as the share step's "첨부하면 {n}명이 더 보게 돼요" does.
   Audited (`room.team_file`: the room as room audits name it, the path, the count). Copies not sent go after a day,
   as uploads do.
3. The room box with the keyboard up: files in one sideways row, the "@" list at most a quarter of the visible height,
   the text field at most 30 % of it (computers keep 200 px). The AI chat's box: the row under it (the engine picker) and
   "나만 봐요" hide while the keyboard is up; its files in one sideways row too.
4. The AI picker (the box's and "다른 모델로 다시 시도" in `chat/Messages.tsx`) is a `MenuButton` sheet on phones: scrim,
   a tap outside, Escape (and Back once overlay-back's hook is in MenuButton). The same choices as now (TC-182, the
   one-choice picker hidden, is PR #428; the changes here keep out of its lines in `Composer.tsx`).

Out: computers and tablets keep their menus (the + popover, the 📎 file input, the listbox picker; the picker's list
also closes on a tap outside there now). A native photo picker in the phone app (iOS shows its own short menu for the
photo library from a web page; only the app can skip it).

## Steps

1. Plan (this file).
2. Server: shared contract (`ROOMS.attachRoomTeamFile`), the route, the audit label in five languages, unit tests
   (`tests/unit/b-rooms-team-file.test.ts`), the mock server's handler.
3. Web: `AttachSheet`; the AI chat's box, the room box (team files through `TeamFilePicker` and the route), the side
   chat's box on phones.
4. Web: the keyboard-up layout (room and AI chat boxes).
5. Web: the AI picker as a sheet on phones (`EngineMenu.tsx` items, `Composer.tsx`, `Messages.tsx`).
6. e2e: `web/test/e2e/phone-attach-sheet.spec.ts` (WebKit for the inputs' accept and capture), `phone-composer-keyboard`,
   `phone-engine-picker`; `changes/phone-attach-sheet.md`.

## Risks

- No migration. Permissions: the copy is `fromTeamFile`'s (read access now, 404 for anything else); the count uses the
  rooms' own link check (`fileOpener`).
- Overlaps: #428 (Composer's picker lines: kept out of its hunks), #429 (Messages.tsx imports and the error row), #413
  and #430 (`shared/src/api/rooms.ts` elsewhere), overlay-back (MenuButton's Back hook).
- Five app languages; phones and computers (1440 screenshots before and after).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the rooms
unit tests, and the new phone e2e specs (WebKit where iOS matters).

## Result

PR #439. Built as planned, with these differences:

- The "@" list floats over the newest messages on a phone (right above the box) instead of pushing the box up: with six
  files, the list and a long draft in a 480 px view the messages kept only 13 px otherwise.
- "나만 봐요" goes while the keyboard is up only in a chat nobody else sees; a shared chat keeps its "N명이 볼 수 있어요"
  line (docs/DECISIONS.md "Who sees it, always": who reads what I type matters most while typing).
- The phone picker is its own file (`chat/EngineSheet.tsx`), so `EngineMenu.tsx` (#428) is untouched and Composer's
  picker hunks stay apart from #428's (a test merge with #428, #413, #423 and #429 is clean).
- Each box's 파일 input keeps the test id its computer input had (`file-input`, `side-chat-file-input`,
  `room-file-input`).
