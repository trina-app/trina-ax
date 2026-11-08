# Room AI cards: back after a reload, fully in view, one button order

- Date (UTC): 2026-11-08 11:08
- Branch: `fix/room-card-reload-scroll`
- Status: done
- Where: trina-ax core (`server/src/rooms/`, `server/src/routes/`, `shared/src/api/`, `web/src/`). Why: rooms and the
  AI's confirmation cards are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Three fixes; one new read-only endpoint (additive: an older app does not call it, a newer app
  on an older server gets 404 and shows what it shows today).

## Goal

Hands-on QA of the room AI's confirmation cards on dev found three bugs:

1. A room card disappears after a reload or in another browser. The card is sent once over the socket
   (`turn.request`). A normal chat reads its open cards again when it loads (`GET /api/chats/:id/requests`); a room
   reads only `GET /api/rooms/:id/ai`, which has no cards. The asker sees the "?" in the sidebar and
   "트리나가 답하는 중 •••" with [멈추기] in the room, but no card: the question waits until the 10-minute timeout.
2. A new card sometimes lands below the fold (3 of about 9 cards, at 1440 and at 390): only the "확인해 주세요" line
   shows above the message box until a manual scroll.
3. The button order flips between cards: the two-button card has the main button on the right
   ([허용 안 함] [이번만 허용]); the three-button room card has it first, on the left.

## Scope

In:
- `GET /api/rooms/:id/ai/requests`: the open cards of the caller's own questions in that room (timeline and threads),
  in the shape `GET /api/chats/:id/requests` answers (`OpenTurnRequest`), and only those: never another member's
  question, never a connect card (a room does not show one), never a card for another desktop window. The web app
  reads it with `GET /api/rooms/:id/ai` when a room opens and when the room is read again after a reconnect
  (`resync`), and merges it with `mergeOpenRequests`, the chat path's merge (cards that came over the socket meanwhile
  stay, cards closed meanwhile stay closed).
- The endpoint sits in `shared/src/api/chats.ts` beside `listTurnRequests`: `rooms.ts` cannot import `TurnRequest`
  (`ws.ts` and `chats.ts` import `rooms.ts`, so the import would be circular).
- Answering stays `POST /api/turns/:id/answer`, which already takes the caller's own turn only: verified by a test.
- Scroll: the room (and its thread panel) took any scroll event more than 80px from the bottom as "the reader scrolled
  up". The scroll event of the room's own jump to the bottom can come after the card was added (the step event and the
  card arrive together), and then the room stopped following. Now only a move up unsticks the room; a scroll event at
  the same place or lower keeps it following. The existing size watcher (`stickToBottom`, a ResizeObserver on the
  content) then keeps the whole card in view as it appears or grows. Someone who scrolled up stays where they are. The
  room has no "new below" button to show, and none is added (lean UI).
- Buttons: one order for every server card, as docs/DESIGN-SYSTEM.md says for dialogs and the two-button card: the
  quiet "no" first and the main button last, on the right ([허용 안 함] [이 방에서는 항상 허용] [이번만 허용]). On a phone
  the three buttons stack full width with the main one on top, as the stacked buttons of the skill share card do. The
  address and dev-environment cards (the same three choices) follow the same order. Labels stay.

Out: a "new below" button; changes to the cards' words.

## Steps

1. Server: `TurnExec.cardsFor(window)` (used by both card lists); `RoomAi.requests(userId, roomId, window)`; the route.
2. Shared: the endpoint; `docs:api`.
3. Web: `mergeOpenRequests` takes a scope; `loadAi` reads the cards; the scroll rule in `lib/stickToBottom.ts` used by
   the room, its thread panel and the chat; the button order in `AskCard.tsx`.
4. Tests: server unit tests (asker gets the card back; another member gets none and cannot answer; answered or timed
   out it is gone; threads), web unit tests (merge scope, scroll rule), e2e (reload, a second browser, another member,
   the card in view, button order); screenshots before and after.
5. docs/DESIGN-SYSTEM.md (button order), docs/DECISIONS.md, CHANGELOG.md.

## Risks

- Security: the card's question, details and preview can hold content only the asker may read. The list reads only the
  caller's own active questions of the room (`room_ai_turns.user_id`) and checks the running turn's owner again.
- No migration. The five app languages are unchanged (no new words).
- Phone and desktop: the stacked buttons at 390; the scroll rule is shared with the chat page.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the room unit suites
(`b-rooms-ai*`, `b-room-ai-grants`, `b-chat-rooms`), the web unit tests (Docker), the full web e2e.

## Result

Built as planned:

- Bug 1: `GET /api/rooms/:id/ai/requests` (`RoomAi.requests`, `TurnExec.cardsFor`, also used by the chat's list); the
  web app reads it with the room's AI state (`loadAi`: opening a room, `resync`) and merges it with
  `mergeOpenRequests`, which now takes a scope. A sign-out while it is on its way keeps nothing of it.
- Bug 2: the race was the room's own scroll event: the room jumps to the bottom when the step event arrives, the card
  arrives before that jump's scroll event fires, and the event then measured the card's height as "the reader scrolled
  up". `followsAfterScroll` (room, thread panel, chat) stops following only on a move up. The e2e test forces the race
  (content added, then a late scroll event) and fails on the old code at 1440 and 390.
- Bug 3: `ChoiceRow` in `AskCard.tsx`, also for the address and dev-environment cards, which had the same flipped order.
  The room card's note under the buttons is right-aligned from `sm`, like the two-button card's.

Differs from the plan: nothing in scope. Not added: a "new below" button (rooms have none to reuse).

Tests: `tests/unit/b-rooms-ai-cards.test.ts` (5), web unit tests (`room-ai-cards.test.ts`, `stick-to-bottom.test.ts`,
`ask-card-confirm.test.tsx`), `web/test/e2e/room-ai-cards.spec.ts` (6, one of them screenshots only with SHOTS_DIR);
`room-ai-allow.spec.ts` follows the new order.
