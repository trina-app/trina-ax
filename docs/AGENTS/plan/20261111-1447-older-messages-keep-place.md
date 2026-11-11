# Loading older messages keeps the message you were reading in place

- Date (UTC): 2026-11-11 14:47
- Branch: `fix/older-messages-keep-place`
- Status: in progress
- Where: `web/src/lib/stickToBottom.ts`, `web/src/pages/Chat.tsx`, `web/src/pages/Room.tsx`,
  `web/src/components/rooms/ThreadPanel.tsx`. Why: the message lists are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: the list no longer jumps when older messages load

## Goal

QA TC-237: in an AI chat (and a room, and a thread) with more than one page of messages, scrolling up until older
messages load makes the view jump down by the loaded page's height: question 7 in sight became question 10 (scrollTop
361 → 1655); in a room [166] became [177]. Chromium and WebKit. Cause: the browser's own scroll anchoring
(`overflow-anchor`) already keeps the place when messages are added above, and the page then adds their height again
(`scrollTop += scrollHeight - before`). Older engines without scroll anchoring need that line; current ones get the move
twice.

## Scope

In: one helper in `lib/stickToBottom.ts` used by the three lists. Before the older page is read it notes the first
message row in sight and its place in the list's content, and turns the browser's scroll anchoring off for the list;
after the page is on screen it scrolls by how far that row moved down (what came in above it), once, and turns anchoring
back on. The same result whether the engine anchors or not, at the very top too, and growth below the row (a streaming
answer, a new message) is not counted as it was with `scrollHeight`.

Out: the other ways a list loads (newer pages of a window around an older message, a link's message brought into view).

## Steps

1. `holdPlace(scroller, rows)` in `lib/stickToBottom.ts`, returning the function that puts the place back.
2. Chat.tsx (`[data-message-id]`), Room.tsx and ThreadPanel.tsx (`[data-testid="room-message"]`, as lib/messageCopy.ts
   marks rows) use it instead of the scrollHeight line.
3. Unit test with a fake list: anchoring on or off, the place is kept; growth below is not counted; a row that is gone
   leaves the list as it is.
4. `changes/older-messages-keep-place.md`.

## Risks

Phones and computers alike (the iPhone app's WebView is WebKit); the list's own size watcher (`watchListSize`) runs
after layout and leaves a reader who scrolled up where the browser put them, so it does not fight this. No UI text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test web/test/unit/stick-to-bottom.test.ts`,
`bun run test:web`; a local dev server check in Chromium and WebKit (a room with 180 messages scrolled up slowly; an AI
chat with more than 50 messages).

## Result

(filled in at the end)
