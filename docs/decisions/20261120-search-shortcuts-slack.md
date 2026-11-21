# Search the Slack way: ⌘F in a conversation, chips, unread rows

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (adds to [message search at least as good as Slack's](20261119-message-search-slack-level.md) and
  [⌘K에서 대화방 메시지 찾기](../DECISIONS.md#k에서-대화방-메시지-찾기--room-11-and-group-chat-messages-in-the-search-palette-featsearch-room-messages-2026-11-08-product-owner))
- Branch: feat/search-slack-shortcuts (the owner approved the plan and its independent review on 2026-11-20; QA
  TC-5640 to TC-5650)

넣을 곳: trina-ax `web/src/lib/searchKeys.ts`, `web/src/components/Layout.tsx`, `web/src/components/SearchDialog.tsx`,
`web/src/components/rooms/RoomMenu.tsx`, `web/src/store/ui.ts`, `server/src/rooms/search.ts`,
`shared/src/search-text.ts`, `shared/src/api/rooms.ts`, 이유: the search box and room search are core chat.

- **Ask:** search that works like Slack's: ⌘F searches the conversation you are in, chips under the box narrow it,
  and the empty box shows what is unread.
- **Rule: the keys** (`searchShortcut`, one pure function, unit-tested):
  - ⌘K (Ctrl+K; on a Mac ⌘ or Ctrl, as before) opens search anywhere, over another dialog too.
  - ⌘F (Ctrl+F off a Mac; on a Mac only ⌘, because Ctrl+F moves the caret in Mac text fields) opens search with
    "This conversation" on in a room, a DM, a group chat or a thread. It keeps the browser's own find (the desktop
    app's find bar) where the page has its own text to read: an AI chat, the file viewer (`/files/view`, `/f/:id`) and
    while a file or artifact is open in the side panel. Anywhere else it is ⌘K.
  - Either key while search is open puts the focus back in the box with its text selected. A second ⌘F does not open
    the page's find over the box (it would search the page behind it); Edit › Find… in the desktop app always does.
  - Another dialog open: ⌘F does nothing. While an input method composes a word nothing happens; otherwise the letter
    is read from `e.code` when `e.key` is not a Latin letter (⌘ with the Korean input source gives 'ㄹ' for F).
  - The web app never takes ⌘G: it is the desktop app's Find Next.
- **Rule: the chips** (on the All, Conversations and Files types; toggle buttons with `aria-pressed`, never part of the
  results' listbox; Backspace in an empty box turns the last one off):
  - **This conversation** sends `room=` (`RoomSearchQuery.room`). The server looks it up only among `myRooms` (rooms
    the person is in now, not archived, the guest rules applied) and intersects it with any `in:`; a bare `room` is a
    filter too, so only room messages and files are searched. A room they are not in finds nothing and answers
    `filters.roomGone` (a fixed sentence in the app), never the room's id. The chip is shown only when search opened in
    a room, and its room is never said again in the results' label. With no text it asks nothing and says to type.
  - **Sent by me** adds `from:me` and **Mentions me** adds `mentions:me` to the text sent: typing the words is the same
    search. `mentions:me` is `MENTIONS_SQL` (by name, or @everyone by someone else) in the same query as who sees what;
    `mentions:` anyone else reads as a filter that matched nobody.
  - `q` stays `min(1)`: the client never sends an empty one.
- **Rule: the empty box** lists up to 3 conversations with unread messages in "Needs attention" (after the AI chats
  that need you; mentions first, then the latest; muted and hidden rooms left out). Drafts are not listed: they are
  kept per device, so the list would be patchy.
- **The room's ⋯ menu** starts with "Search in this conversation" (the same as ⌘F there), for phones and mouse users.
- **Cut:** Slack's ⌘G (Find Next in the desktop app), "Has link" (cheap, but the owner wants a lean row), threads only
  and my activity (Activity covers them), "+" more (the types, the order and typed filters do it), drafts, and a
  search inside one AI chat (no endpoint and no jump to a message there; ⌘F is the page's find).
- **Changed for people:** ⌘F used to always find on the page. In a conversation it now opens search; the page's find
  is a second press away only through Edit › Find… in the desktop app (the browser's menu in a browser).
- **Speed:** a chip with no text walks the newest messages until a page fills; a rare filter (mentions) walks far. On
  100,000 messages `from:me`, `mentions:me` and both with a room took about 75–160 ms on the build Mac
  (`tests/unit/b-rooms-search-slack.test.ts` prints them). No migration.
- **Version impact:** server and web ship together (the server serves the web app, and the desktop and phone apps load
  it), so a new web app never talks to an older server; an older server would ignore `room=` and give only wider
  results the person may see, never hidden ones.
- **Tests:** `tests/unit/b-rooms-search-slack.test.ts` (room=, a room not mine, left or archived, the in: intersection,
  mentions:me, 100,000 messages), `tests/unit/a-guests-room-search.test.ts` (a guest), `web/test/unit/search-keys.test.ts`
  (the keys, unread rows), `web/test/e2e/search-message-filters.spec.ts`. By hand in the packaged desktop app: the first
  and second ⌘F, ⌘F in an AI chat, the Korean input source.
