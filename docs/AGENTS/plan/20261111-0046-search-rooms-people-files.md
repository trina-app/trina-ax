# ⌘K: rooms and people by name, files sent in rooms, word-by-word matching, two palette bugs

- Date (UTC): 2026-11-11 00:46
- Branch: `feat/search-rooms-people-files`
- Status: in progress
- Where: trina-ax core (`web/src/components/SearchDialog.tsx`, `shared/src/search-text.ts`, `shared/src/api/rooms.ts`,
  `server/src/rooms/search.ts`, a new `server/src/rooms/file-search.ts`, `server/src/rooms/service.ts`,
  `server/src/routes/rooms.ts`, `server/src/routes/chats.ts`). Why: the search palette, rooms and their visibility rule
  are core chat (see docs/REPOSITORY-RULES.md).
- Version impact: minor. One new endpoint and result type (room files), a new group in the palette, a looser match
  (every word instead of one exact run). No migration.

## Goal

An audit of the ⌘K palette on dev (2274559af) found five gaps the owner approved fixing:

1. ⌘K cannot jump to a room or a person by typing its name.
2. Files sent in rooms cannot be found: they live under `.system/` and a file-only message has an empty body, so it is
   not in `room_messages_fts`.
3. Room-message search and AI-history search need the whole query as one exact run: "견적서 보내" does not find
   "견적서를 보내드렸어요".
4. A chat result from an older query can open on Enter (search "견적서", replace it with "회의록", Enter fast).
5. The highlight jumps to another row when results arrive above it (the selection is an index).

## Scope

### 1. Rooms & people (web only)

- One group on the **All** tab, only while something is typed: "Rooms & people" (en.ts first; ko "대화방·사람"; ja, es,
  id filled). No new tab, no new button or card.
- **Sources (no new server data).** The rooms list the person already has (`store/rooms.ts`, `GET /api/rooms` =
  `reader.ts myRooms`: rooms they are in now, not archived; hidden rooms included, as message search does) and the team's
  people (`store/people.ts usePeopleList`, `GET /api/people`: the list the new-DM picker uses; never me). Both are read
  when the palette opens if no screen has read them yet.
- **One row per room or person.** A DM in the rooms list stands for its person (their face and name); a person with no
  DM in the list is a person row. A team room, the everyone room and a group chat are matched by the title the app
  shows (`useRoomTitle`), people by name.
- **Matching** (`shared/src/search-text.ts`, new, with unit tests; no helper existed): NFKC and lower case on both
  sides; every whitespace-separated word must be in the name; a Korean initial consonant in the query (ㄱ…ㅎ, ㄲ…ㅉ)
  matches a syllable that starts with it, so "ㄱㅈ" finds "견적", "ㅁㅎ" finds "민희", "김ㅁ" finds "김민희". Order: the
  whole query at the start of the name, then inside it, then by words or initials; rooms by latest activity, people
  by name. At most 5 rows. The match is marked when it is a plain substring.
- **Enter / click.** A room opens `/rooms/:id`. A person opens their DM: the DM in the rooms list when there is one,
  else `useRooms.openDm` (`POST /api/rooms {kind:'dm'}`, which returns the existing DM when there is one) then
  `/rooms/:id`: the same path the new-DM picker (`PeoplePicker.tsx`) uses. A failure shows the picker's toast.
- **Place.** First on the All tab: it is a name jump, local, so it never arrives late and never moves rows below it.

### 2. Files sent in rooms (server + web)

- `GET /api/room-files?q=&cursor=&limit=` (`API.searchRoomFiles`, query `RoomSearchQuery`, response
  `RoomFileSearchPage`: `items` (file id, name, kind, message id, roomId, threadRootId, author, createdAt), `rooms` (as
  `RoomSearchPage.rooms`), `nextCursor`). `server/src/rooms/file-search.ts`, called through `Rooms.searchFiles`, which
  runs `syncFor` first like `Rooms.search`.
- **Access rule: exactly message search's.** Candidates only in `reader.ts myRooms` (rooms they are in now, not
  archived). Only files sent with a message (`message_id` set; an unsent upload never), of a message in the same room,
  not deleted, not an event line. Who sees the message is decided in the query with `store.ts SEE_MEMBER_SQL` on the
  member row of the message's room (where they see the room from: a later member of a group chat or a 1:1 from their
  join, a team room's or the everyone room's whole history once opened; others' private previews never; old answers
  hidden from them, including answers people shared from their own AI chat with files, and everything in their threads
  never), so the page, its LIMIT and its cursor only count or name files they see. Then `canSee` on each row, then
  `messagesOut`: the message must come out not withheld and the file must be among its `files`. Leaving or being taken
  out ends it at once (no member row).
- **Matching:** every word of the query in the file name, `LIKE … ESCAPE` (A–Z in any case, `%` and `_` as themselves),
  NFC (names are stored NFC). Newest message first; cursor = (message rowid, file rowid) of the page's last hit.
- **Index: none.** `room_files` holds one row per file sent (far fewer than messages); the query reads the names once
  and joins messages by primary key. The suite measures it on 20,000 files; a migration is added only if that is slow.
- **Palette.** On the All and Files tabs (where file rows show), after the team files' names: the file name (match
  marked) and "in #room" (team room, everyone room), "with Ben" (a DM), "in <group chat name>". 4 rows on All, 20 on
  Files, no "more" row. Opening one opens that message in its room (`hitHref`: `/rooms/:id?m=`, a thread reply
  `/rooms/:id/t/:root?m=`), the way message hits do.

### 3. Word-by-word matching (server + web)

- `shared/src/search-text.ts searchWords(q)`: NFC, split on whitespace, no empty or repeated words, at most 8 (as
  `reader.ts searchRooms`).
- `rooms/search.ts`: words of 3+ characters: one FTS5 `MATCH` of quoted phrases joined by `AND` (the index); none: the
  trigram `LIKE` with the longest word (the existing fallback). Every word is matched again on the message's own body
  with `LIKE … ESCAPE`. Any order. Visibility, `CROSS JOIN` order, page size and cursor unchanged (the cursor is still
  the page's last hit). The snippet starts around the first word found.
- `routes/chats.ts listChats`: every word must be in the chat's title or in one of its messages (per chat, as
  `chat/room-project-chats.ts` does for the AI's project_chats tool). A shared chat: each word through its title, a
  person's message, or an answer not hidden from the person (`sharedHits` per word, `AnswerSight`).
- Web: the palette marks the first match of every word.

### 4. Stale results (web)

Each async source stores the query it answered with its result: chats (`/api/chats?q=`), file names
(`/api/files/find`), room messages (`/api/room-messages`, also its "More messages" pages) and room files
(`/api/room-files`). Rows, the loading state and Enter use a result only when its query is the one in the box now, so
nothing from an older query is shown or opened.

### 5. Selection by row key (web)

The selection is `{ key, index }`: the active row is the row with that key; when it is gone, the row at that index.
Arrow keys and the mouse set the key; typing or another tab goes back to the first row. "More messages" keeps the
position, so the keys land on the first new message.

Out: filters (`in:`, `from:`), "search in this room", the History tab's name, folders, Needs attention, remembering the
last query, room file contents, people's other fields (job title) as match targets, word matching for the palette's
local lists (projects, skills, scheduled tasks, MCP).

## Steps

1. This plan (first commit).
2. `shared/src/search-text.ts` (`searchWords`, `nameMatch`) + tests.
3. Server: word-by-word in `rooms/search.ts` and `routes/chats.ts`; `rooms/file-search.ts`, the contract, the route,
   `bun run docs:api`, the security matrix case.
4. Web: SearchDialog (rooms & people, room files, words, stale results, selection by key), i18n in five languages.
5. Tests (below), then docs: DECISIONS.md (the ⌘K section), user docs about search if any, `changes/search-rooms-people-files.md`.

## Risks

- Migrations: none planned (dev's highest is 338; 600/701 are other series).
- Permissions: the room-files source is new data on the wire; it reuses message search's rule (above) and is checked
  by tests for every case in "Tests". Rooms & people show only lists the person already has.
- Enter's top row changes on the All tab when a room or person matches (they come first). Chats keep their order.
- A looser match returns more rows; pages and cursors stay bounded as before. Each extra word in a chat search is one
  more scan of `messages_fts` (≤ 8).
- Five app languages; phone (390 px) and desktop; light and dark.
- Not touched (another branch changes project access): `projects.ts`, shared-chat audiences (`shared.ts`),
  `chat/read-rooms.ts`, the project members dialog.

## Tests

- `tests/unit/search-text.test.ts`: initial consonants (ㄱㅈ → 견적, ㅁㅎ → 민희, double consonants, mixed syllables and
  initials), NFKC (full-width letters, compatibility jamo), case, words in any order, the rank, words split and capped.
- `tests/unit/b-rooms-file-search.test.ts`: a non-member (owner and admin too), after leaving a group chat and after
  being taken out of a team room, a later member of a group chat (a file before their join: nothing; after: found), a
  later member of a team room (the history: found), a 1:1 only by its two people, a file in the thread of an answer
  hidden from a later member and a shared answer with a file hidden from them, a private preview with a file (only its
  person), archived rooms, a deleted message, an unsent upload, words in any order, case, `%` and `_`, pages without
  repeats and a cursor never at an unseen file, 20,000 files timed.
- `tests/unit/b-rooms-search.test.ts`: "견적서 보내" finds "견적서를 보내드렸어요", any order, short words only, mixed,
  pages over several words, the plan still starts at the index.
- `tests/unit/b-api.test.ts`, `tests/unit/b-shared-chat-audience.test.ts`: chat search by words across the title and
  messages; a word only in an answer hidden from the person does not count.
- `web/test/unit/search-palette.test.tsx`: a stale chat result is never shown nor opened by Enter; the highlight stays
  on its row when results arrive above it; rooms & people rows (initials, a DM, a person without a DM → `openDm`);
  room file rows open the message.
- `web/test/e2e/search-rooms-people-files.spec.ts` (mock server, one spec): a room by its initials, a person's DM, a
  room file opening its message, 1440 and 390.
- Checks: `bun run typecheck`, `bun run check:docs`, `bun run check:i18n`, the touched areas' unit tests,
  `bun run test:unit` compared with dev.

## Result

(filled in at the end)
