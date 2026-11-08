# Search: messages of my rooms, DMs and group chats in the ⌘K palette

- Date (UTC): 2026-11-08 06:53
- Branch: `feat/search-room-messages`
- Status: in progress
- Where: trina-ax core (`server/src/rooms/search.ts`, `server/src/rooms/service.ts`, `server/src/routes/rooms.ts`,
  migration 267, `shared/src/api/rooms.ts`, `web/src/components/SearchDialog.tsx`, `web/src/store/rooms.ts`,
  `web/src/pages/Room.tsx`). Why: rooms, their visibility rule and the search palette are core chat (see
  docs/REPOSITORY-RULES.md).
- Version impact: minor. A new search result type, one new endpoint, an optional query field and one additive migration.

## Goal

From the team chat: "Chat search: search the messages in rooms and DMs", in the ⌘K palette. Today ⌘K finds the person's
AI chat records by title and content (`GET /api/chats?q=`, FTS5 trigram `messages_fts`), projects, files and so on, but
no room message. After this the same palette also lists the room, 1:1 and group chat messages the person can see.
Choosing one opens the room at that message, highlighted for a moment, or its thread for a thread reply. No new screen.

## Scope

In:
- **Server.** `GET /api/room-messages?q=&cursor=&limit=` (`API.searchRoomMessages`; `/api/rooms/search` would be
  taken by `/api/rooms/:id`). The newest matches first, at most 30 a page (default 20), a cursor for more.
- **Visibility: the rooms' own rule, not a copy.** Candidates only from `reader.ts myRooms` (rooms I am in now, not
  archived: what the rooms list shows; hidden rooms count, as in the list's "숨긴 대화"), each kept only when
  `store.ts canSee(db, row, me)` says so (the check `SEE_SQL` writes in SQL: where I see the room from, later members of
  group chats and 1:1s from their join, team rooms and the everyone room their whole history once opened, others'
  private previews never, hidden old answers and everything in their threads never). Before searching, my team rooms'
  histories are opened as `Rooms.list` does. Deleted messages and event lines never match. The row given is
  `messagesOut`'s, and a `withheld` one is dropped.
- **Index: FTS5 trigram, migration 267**, as the chat records' search. `room_messages_fts(body)`, rowid =
  `room_messages.rowid`, kept by triggers on insert, on `UPDATE OF body` (an edit replaces it, a delete empties it) and on
  delete; backfilled and `optimize`d in the migration. 3+ characters: an FTS phrase `MATCH`; 1–2 characters (Korean
  "견적"): the trigram `LIKE` (a scan of the index's text, newest first). Both in rowid order, newest first, so a page
  stops early. Every candidate is checked again against the message's own body with `LIKE … ESCAPE` (the chat records'
  rule: the whole text as one part, any case), so a stale index row can never show a message that does not hold it.
- **Measured before choosing** (prototype, this Mac): a bounded `LIKE` over a 50k room is fast for common words
  (0.02 ms) but 18 ms for a rare one, and over the person's rooms in rowid order 85–345 ms; the FTS stream is 0.1–1.7 ms,
  a 2-character word that matches nothing 17 ms over 100k rows. Final numbers go in DECISIONS.
- **The hit** (`RoomSearchHit`): id, roomId, threadRootId (a reply), authorKind, author, createdAt, and a snippet: the
  visible body around the first match (room links as `#name`), at most 200 characters. The page also lists each hit's
  room light (kind, name, peers, memberCount) for its title.
- **Opening an old message.** `ListRoomMessagesQuery.around=<messageId>`: the page around it, and a `newerCursor` while it
  does not reach the newest. The timeline then holds a window: scrolling down loads newer pages; new messages are not
  added to it until it reaches the newest; a small "최근 메시지" button goes back to the newest; sending reloads the
  newest. Room.tsx asks for `around` when `?m=` is not in the newest page (also the Inbox's links, which looked only 10
  pages back). A thread reply opens `/rooms/:id/t/:root?m=`, as the Inbox does.
- **Palette.** A "대화방 메시지" section after the chat records (기록) on the 전체 tab: up to 5 rows, then "메시지 더 보기"
  loads the next page in place. A row: the sender's picture (the AI's mark for an AI answer), name, `#방이름` (a DM: the
  person; a group chat: its title), "스레드" for a reply, the time, and one line of the snippet with the typed text
  marked. Arrows, Enter, Esc as now. No new tab, no filter chips. Placeholder names messages too, five languages, short
  enough for 390 px. Phones: the same palette (it fills the screen).
- Docs: DECISIONS.md, CHANGELOG.md, `bun run docs:api`.

Out: Slack-style filters (from:, in:, dates), searching file names or file contents of rooms, searching what the
room's AI said privately to someone else (never), the person's own AI chat's `rooms` tool (unchanged: it keeps its own
bounded scan).

## Steps

1. Migration 267 (check free: 266 is the room AI grants branch's), shared contract, `rooms/search.ts`, the route, the
   `around` page in `Rooms.messages`.
2. Server unit tests (`tests/unit/b-rooms-search.test.ts`): non-member, left, later member of a group chat and of a team
   room, hidden answers (no match, never their text in any response), DM, thread reply, deleted and edited, Korean
   substring, cap and pages, index kept in sync, query timing on 50k messages, `around`.
3. Web: store window (`loadAround`, `loadNewer`, `newerCursor`), Room.tsx, the palette section, five locales, mock server.
4. Web unit tests, e2e spec (`web/test/e2e/search-room-messages.spec.ts`: ⌘K → word → Enter opens the room at it; a
   thread hit opens the thread; phone), screenshots before/after at 1440 and 390, light and dark.
5. DECISIONS, CHANGELOG, API reference.

## Risks

- Visibility is the risk: only `canSee` decides, and the tests cover each rule. The snippet is cut from a body `canSee`
  passed, never from a quote or a hidden answer.
- Migration 267, additive (reader level stays): an older build after a rollback keeps the triggers (they are in the
  database), so the index stays right. Backfill time: about 2–3 s per 100k messages, once.
- The rowid key: rowids of `room_messages` survive VACUUM and VACUUM INTO (checked, and a test), and the body check
  drops any row that does not hold the text anyway.
- The timeline window changes the room page's scroll and read marking (nothing is marked read while it is not at the
  newest). The full web e2e runs.
- Five languages, phone width, dark mode.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:tooltips`, `bun run docs:api`, the new
server suite and the rooms suites it touches, web unit tests in Docker, `bun run --cwd web build`, the full web e2e.

## Result

Filled in at the end.
