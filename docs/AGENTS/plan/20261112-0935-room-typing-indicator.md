# "Alice is typing…" in rooms, DMs and threads

- Date (UTC): 2026-11-12 09:35
- Branch: `feat/room-typing-indicator`
- Status: done
- Where: Team AX core (`shared/src/api/ws.ts`, `server/src/rooms/`, `web/src/`). Why: rooms are core chat (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new user-visible feature with a new WebSocket frame (older pages and servers ignore it)

## Goal

People in a room, a 1:1 or a thread see when someone else is writing an answer, so they wait for it instead of
moving on. QA row TC-392.

## Scope

In:
- One quiet line just above the message box: "Alice is typing…", "Alice and Carol are typing…", "Several people are
  typing…". Names as this person's app shows them (the people directory, then the room's member list). Never myself.
- The main box speaks for the room's timeline; a thread's box for that thread only.
- Over the WebSocket that already exists, as control frames (like `presence`: no seq, never replayed, nothing stored).
  Client frame `room.typing {roomId, threadRootId, typing}`; server frame `room.typing {roomId, threadRootId, userId,
  typing}`.
- Sending: "typing" at most every 3 s while keys are pressed; "stopped" at once on send, an emptied box, leaving the
  box (blur) or the room. Never queued while disconnected.
- Receiving: a person drops off the line 5 s after their last ping, when "stopped" comes, when their message arrives in
  that place, and all at once when the connection is lost.
- Server (`server/src/rooms/typing.ts`): the sender must be a member of the room (not archived), and for a thread able
  to see its root, the same checks a message has; anything else is dropped without an answer. Relayed only to the other
  members who can read that place (a thread: those who see its root). At most 20 frames per 10 s per person, at most 5
  places at once per person; a "stopped" goes out only after a relayed "typing". In memory only, no table, no migration.
- Trina answering: the room already shows "Trina is answering" under the messages (RoomAiStatus). Not repeated in the
  new line (one indicator per thing).
- Phones (the store app's WebView is this page): the line floats above the box without taking space, so nothing jumps;
  a short fade, none with reduced motion. `aria-live="polite"`; the words change only when the set of people changes.

Out: the AI chats (one person), Slack connector rooms, showing typing in the conversation list.

## Steps

1. Contract: the two frames and the timings in `shared/src/api/ws.ts`.
2. Server: `rooms/typing.ts` (checks, relay, rate limit), started with presence in `chat/runtime.ts`.
3. Web: `lib/roomTyping.ts` (sender throttle, line words), `store/typing.ts` (who is typing where, expiry),
   `lib/realtime.ts` and `store/live.ts` wiring, the line in `RoomComposer`.
4. i18n en first, then ko/id/ja/es. DECISIONS entry, changelog fragment.
5. Tests, screenshots at 1440 and 390, light and dark.

## Risks

- Privacy: the frame names only the person's id; outsiders and members who cannot see a thread root get nothing.
- Load: one small DB read per ping (room, member row, members); pings are throttled by the client and limited per person
  on the server.
- Older servers answer an unknown client frame with an error frame the page ignores; older pages ignore the new server
  frame (not a known event).
- No migration (highest on dev: 701).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/b-room-typing.test.ts` (server),
`web/test/unit/room-typing.test.tsx` (web), `web/test/e2e/room-typing.spec.ts` (a second member through the mock
server), the rooms unit tests.

## Result

Built as planned. One change: the line floats in space the message lists keep free at their bottom (their padding went
from 16 to 24 px) instead of over a coloured strip, so it never covers a message and needs no background matching the
room or the thread panel. The sender's output goes through `setTypingOut` (`lib/roomTyping.ts`, set by `store/live.ts`)
so the box does not import the socket wiring. Decisions: docs/DECISIONS.md "입력 중 표시". PR: https://github.com/trina-app/trina-ax/pull/600.
