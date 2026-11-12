# A room message the server got while its reply was lost shows once

- Date (UTC): 2026-11-11 12:08
- Branch: `fix/room-send-lost-reply`
- Status: done
- Where: `shared/src/api/rooms.ts`, `server/src/rooms/store.ts`, `web/src/store/rooms.ts`. Why: the team chat rooms are
  core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: one optional field on the author's own room messages, nothing new to see

## Goal

QA TC-236: a member sends a message in a room, and the connection drops after the server got it but before its answer
came back. The room then shows the message twice: delivered (from the live event or the replay after the reconnect)
and, under it, the same text as a failed bubble with 다시 시도 / 지우기. It stays like that after reconnecting. The rule
is "delivered once, or failed with Retry and Discard; never both".

Cause: the app keeps the send as a pending bubble until the POST answers. A message that comes another way (the live
`room.message`, a replay, a page read again by the reconnect) cannot be matched to it: `RoomMessage` has no
`clientMessageId`, although the server stores it (`room_messages.client_id`) and already returns the first message for
the same id again.

## Scope

In:
- `RoomMessage.clientMessageId` (optional): the id the author's app made when it sent the message. Only on the
  viewer's own messages (`messagesOut` is per viewer, the live event too), never on anyone else's.
- The web store settles a pending send when its message is on screen (the room's timeline or a thread on screen),
  whichever way it came: the POST answer, the live event, a replay, a page read again. One place for all of them: a
  subscription on the store, so it does not depend on each read path (and does not touch the lines open PR #365
  changes in the page reads).
- A send whose POST fails after its message came another way changes nothing (no failed bubble, no text back in the
  box).

Out: retrying a lost send by itself (the room keeps Retry / Discard for a send the server did not get).

## Steps

1. Shared contract: `clientMessageId` optional on `RoomMessage`.
2. Server `shownOut`: add it for the viewer's own user messages.
3. Web: `settledPending(state)` (pure) and a store subscription that drops pending sends whose message is on screen;
   `post()` does nothing when its pending send is gone.
4. Tests: server (own message carries it in the POST answer, the list and the live event; another member's copy does
   not), web store (event while the POST fails; a page read after a reconnect; a thread reply).
5. `changes/room-send-lost-reply.md`.

## Risks

- Visibility: the field goes only to the author; no other person's id is shown. No migration, no permission change.
- PR #365 (rooms page-load merge) edits `web/src/store/rooms.ts` in the page reads and the `room.message` handler; this
  change stays out of those lines.
- No UI text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/b-rooms.test.ts`,
`bun run test:web`, the rooms e2e specs; a local dev server run of the QA script (request reaches the server, the reply
is aborted, offline 10 s, online).

## Result

Built as planned. `RoomMessage.clientMessageId` is sent only on the viewer's own user messages (`shownOut` in
`server/src/rooms/store.ts`, so the POST answer, page reads, search hits and the per-person live event alike).
`settledPending` (pure) plus one store subscription settle a pending send as soon as its message is in the timeline or a
thread on screen; `post()` ignores a failure whose send is no longer pending. No change to the lines PR #365 edits: the
branch merges with it cleanly and the rooms store tests pass on that merge too.

Checked on a local dev server with the QA steps: the POST reaches the server and its answer is aborted, offline 10 s,
online: the message shows once and no failed bubble at any time. With the live connection cut as well, the bubble shows
failed while cut and goes when the reconnect brings the message. Offline before the send still shows failed with
다시 시도 / 지우기, and 다시 시도 delivers it once.
