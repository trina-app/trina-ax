# 대화방에 보내기, phase 1: linked files and where the answer came from, asked apart

- Date (UTC): 2026-11-07 08:48
- Branch: `feat/share-to-room-files`
- Status: in progress
- Where: this repo, Team AX core (`server/src/chat/answer-share.ts`, `server/src/chat/read-scope.ts`,
  `server/src/rooms/files.ts`, `shared/src/api/chats.ts`, `web/src/components/chat/ShareToRoom.tsx`). Why: chat, rooms,
  permissions and files are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (a visible change in the share dialog and new optional API fields; older clients keep working)

## Goal

Sending an answer to a room asked "N people in this room can't open files this answer used. Send it anyway?" when
nothing the room gets was closed to them: the check counted every file read on the branch and the whole session's read
scope. A typical false alarm: the AI read a quote in my own folder, copied it to a shared folder everyone in the room
reads, and linked the copy. The dialog also mixed two questions (can members open the linked files; does the answer
carry content from material some cannot read), named no file, offered no fix, and its default button was "그래도
보내기".

After this change the check asks the two questions apart, only when one applies; otherwise the answer goes at once.

## Scope

In:

- **Access**: one row per file the answer links to or shows, with how many members cannot open it, never named when I
  cannot open it myself ("내가 열 수 없는 파일 N개"), and an **첨부** switch (on by default) that sends a copy of the file
  with the message.
- **Provenance**: one line, only when it applies, with how many members cannot see some material the answer used and
  the places I may look myself. Left out: material everyone can read; material whose identical content (same sha256) a
  turn on this branch saved to a place every member can read now (the copy still there with that hash); linked files
  being attached. Unknown branch: "이 답이 참고한 자료를 다 알 수 없어요".
- `RoomFiles.fromTeamFile()`: a team file I may read now becomes a room file through the existing `create()` path
  (10 files, 50 MB each). `shareAnswerToRoom` attaches before `Rooms.send`; no new endpoint.
- `confirmKey`: a keyed hash (a per-server-process secret) over the members, the sources, the files and the attach
  offers; the old `confirm` number keeps working for older clients.
- Read scope: `{type:'user'}` gets `via: 'browser' | 'connection'`; the scope remembers which file-type sources came
  from reads the answer's source list (`message_sources`) records, so only those may be replaced by per-file rows.
  Older scopes count as before.
- Room view: a linked file a member cannot open shows a lock and "권한이 없어 열 수 없어요" instead of plain text.
- Toast "{room}에 보냈어요 · 파일 N개 첨부"; audit `room.answer_share` gains the number of files.
- Five languages, DECISIONS entry, CHANGELOG line, API docs.

Out (later or not possible without a migration):

- "이미 보냄" in the room picker: a room message does not record which answer it came from (migration 261 stored only
  where the answer starts). Needs a column; left for a later PR.

## Steps

1. Shared contract: request `attach`, `confirmKey`; confirm response `files`, `provenance`, `confirmKey`.
2. `read-scope.ts`: `via`, the scope's record of logged file sources; writers in `turn.ts`, connections, Drive.
3. `answer-share.ts`: access rows, provenance with the hash rule, the key, the old `confirm`, attaching.
4. `rooms/files.ts` `fromTeamFile`; `Rooms.send` takes files with a shared answer; audit field.
5. Web: the confirm step, the exits back to the list, the toast; the lock in room messages.
6. Tests: server unit, web unit, mock server + e2e (1440/390, axe), visual pass with ui-polish.
7. Docs: DECISIONS, CHANGELOG, `bun run docs:api`.

## Risks

- No migration (highest on dev: 701). All new state is JSON in `chats.session_read_scope` or in memory.
- Security: counts only, never who; a file is named only when I can open it now (missing and forbidden read the same);
  every check takes from the sending budget; attaching re-checks my read access and only files the answer links to;
  a confidential conversation is never shared.
- Older clients: old request and response fields stay.
- Other work in flight: `server/src/connectors/remote-mcp/**` and `server/src/chat/prompt.ts` are not touched.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` and `tests/unit/docs-site.test.ts`,
the answer-share, rooms, room files, read-scope and chats unit tests, `tests/security/permission-matrix.test.ts` and
`p4-route-coverage.test.ts`, `bun run test:web`, `bun run build:web`, the full web e2e.

## Result

Filled in at the end.
