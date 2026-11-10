# The ✦ side chat opens on a new chat

- Date (UTC): 2026-11-10 07:53
- Branch: `fix/side-chat-opens-new`
- Status: in progress
- Where: trina-ax core, `web/` (`components/rooms/SideChatPanel.tsx`, `store/sideChats.ts`, `pages/Room.tsx`,
  `components/rooms/ViewerColumn.tsx`). Why: the room side chat is core (docs/REPOSITORY-RULES.md).
- Version impact: patch. A behaviour change of one panel; no API, data or text change.

## Goal

The owner: "every time I open it I see the previous conversation; the default should be a new chat. There's a history
button for finding old ones." Opening ✦ Trina beside a room starts on a new, empty chat (its starters, or the quote it
was opened with). Old chats stay in 🕘.

## Scope

In:
- A fresh open is an empty chat: ✦ in the room header, "Ask Trina about this" on a message or file, ✦ in the file viewer,
  the phone sheet, a phone. The chat row is still made by the first question (or file), so open and close leaves nothing.
- Not a fresh open (the same chat stays): the column switching between a thread and Trina (the room page's and the file
  viewer's, "스레드로 돌아가기" and back, 보기 under a sent answer and ✦ back), ← → through files, the room page and the
  viewer's column showing it together, hiding and showing the viewer's column or its phone sheet.
- A fresh open still shows the last chat when it is not done: its answer is on its way (sending, running, queued), the
  AI waits on me (a card), or an answer finished that I have not seen (Chat.unseen, failed or paused included). The same
  marker as Trina history (lib/sessionMarkers.ts `markerOf`), no new store. After a reload the room's newest side chat
  is asked for once, as now, and shown only when it is not done.
- A typed draft or files in the box when the panel closes: kept for this page's session with the chat they were typed
  into (files were uploaded into that chat; #265 drops them when another chat shows). The quote stays too, but alone
  it does not keep an old chat.
- 🕘 and "New chat" as before. DECISIONS (amend #263's "keeps the last chat"), CHANGELOG, comments.

Out: anything on the server; remembering the chat across a reload.

## Steps

1. `store/sideChats.ts`: `open` per room (a panel shows it, or a thread took its place) and `close(roomId)`.
2. `SideChatPanel.tsx`: a panel that comes on screen while the room's side chat is closed decides once, before its first
   paint, which chat it shows (`sideChatOpening`); the newest side chat after a reload only when not done.
3. Closing: the room page's ✕ / ‹ / ✦, leaving the room, and closing the file viewer while its column was on Trina
   (unless the room page has it open). 보기 is a hand-off, not a close.
4. Unit tests in `side-chat.test.tsx`; adjust the tests that expected the newest chat to open.

## Risks

Phones and the phone app use the same panel and the same rules. No migration, no permission change, no new strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`; e2e
`side-chat-send`, `side-chat-attachments`, `room-file-viewer`, `room-hover-bar`, `room-drop`.

## Result

Filled in at the end.
