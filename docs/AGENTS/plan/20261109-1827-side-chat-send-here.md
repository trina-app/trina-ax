# One click from the side chat: send an answer to this room or to the asked message's thread

- Date (UTC): 2026-11-09 18:27
- Branch: `feat/side-chat-send-here`
- Status: in progress
- Where: trina-ax core (`web/src/components/rooms/`, `web/src/components/chat/`, `server/src/chat/answer-share.ts`,
  `server/src/rooms/service.ts`, `shared/src/api/`). Why: chat, rooms and permissions are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A new choice in the share API (`threadRootId`, optional) and a new control in the side chat.

## Goal

A room's private side chat (✦) belongs to one room, yet "Share to room" under its answers opens the general
"대화방에 보내기" dialog: a room list, a search and a note, to pick the room again. The owner found that odd. Under each
answer in a side chat, one quiet control sends the answer at once to where it belongs: the thread of the room message
the question was about, or the room.

## Scope

In:
- Under each finished answer in a room's side chat, one text button in place of "Share to room":
  - an answer to a question about a room message: `[copy] [스레드에 보내기 ▾] [regenerate]`; ▾ opens a menu with one item,
    대화방에 보내기;
  - any other answer: `[copy] [대화방에 보내기] [regenerate]`.
  English "Send to thread" / "Send to room"; five languages. Never "스레드에 답글" or "답장" (the hover bar's
  "스레드에서 답장" only opens a reply box).
- A click sends at once: no picker, search, note or toast. Then the control is one line for this page's session:
  `✓ 스레드에 보냈어요 · 보기` / `✓ 대화방에 보냈어요 · 보기` ("앞부분만" when the server cut the answer). The focus goes to
  보기 and a `role="status"` says it. 보기 opens the thread (the reply marked) or the room at the message (a phone: the
  side chat closes so the room shows); ✦ brings the same side chat back.
- The server's "confirm" (linked files with 첨부 switches, material some members cannot see) opens only the confirm step
  of `ShareToRoom.tsx`, factored out, with the target (the thread's message, or the room). 취소 / ✕ / Esc close it and
  give the focus back to the control. The full chat's dialog is unchanged.
- Double sends: a ref guard while sending, one `clientMessageId` per click, reused only for that click's confirm and
  for trying the same target again after a failure that may have sent it (a network error, 5xx). Never across clicks: the
  server's lookup of a `clientMessageId` returns a deleted message too, and a unique index (room, author, client id)
  stands behind it, so the lookup stays as it is.
- The thread target travels in the question text. `SideSeed.thread` (the asked message's thread root:
  `threadRootId ?? id`) only when the message can have a thread (seen by the whole room, not an event line, not a private
  AI preview); `withQuote` puts ` (thread_id <id> in this room)` at the end of the quote's header line, as the file
  quote carries `file_id`. Shared helpers (`shared/src/api/rooms.ts`): the token, its parse (first line only) and its
  hiding. The app hides it wherever it shows a question (the bubble, copy, edit, which puts it back); the server leaves
  it out of a new chat's placeholder title.
- Which answer goes where (`web/src/lib/sideChatSend.ts`): the nearest earlier question on the answer's branch that
  quotes something decides: its token's thread, or the room when it has none (a file ask, an event line, an older chat).
  A follow-up without a quote ("더 짧게") keeps the thread. It is read from the messages, so it holds after a reload,
  🕘, ↗ and regenerate. An old side chat without tokens gets 대화방에 보내기 only; nothing is guessed from quote text.
- Server: `ShareAnswerToRoomBody.threadRootId` (optional), passed to `Rooms.send`, whose refusal of a shared answer with a
  thread root goes; its root checks apply (same room, seen by me, can have a thread, not deleted). `shareAnswerToRoom`
  checks the root first, before the sending budget and the file checks: a bad or deleted root is 409
  `reason: 'thread_root'` with a clear message; the web shows a short line under the answer and offers
  대화방에 보내기. Followers of the thread (the root's author too) are notified as for any reply. Never in a confidential
  chat (the refusal and the hidden control stay).
- ↗ (a side chat open as a full chat): its 대화방에 보내기 dialog starts with the side chat's room picked
  (`chat.sideRoomId`).
- docs/DECISIONS.md: a side chat's answer goes to the asked message's thread by default, or to the room via ▾.

Out (not in v1): "대화방에도 보내기" on a thread send; a file's thread (a file ask goes to the room); the note; a toast;
a server column for the asked message.

## Steps

1. Shared: `threadRootId` in the body; the thread token helpers. Server: the root check in `shareAnswerToRoom`,
   `Rooms.send` takes a shared answer in a thread, the placeholder title without the token; tests.
2. Web: `SideSeed.thread` and the token in `withQuote`; the question shown without it; `lib/sideChatSend.ts` (the
   target of each answer); the confirm step out of `ShareToRoom.tsx`; `rooms/SendHere.tsx` (the control, the sent line,
   the error line, the confirm); the side chat passes its target and its 보기; the full chat pre-picks the side chat's
   room; five languages.
3. Tests (below), screenshots before and after (the control, ▾, the sent line, the confirm; 1440 and 390, light and dark),
   DECISIONS, CHANGELOG, API docs.

## Risks

- Privacy: a thread reply is seen by everyone who sees its root; the root must be one the whole room sees, so the
  answer reaches no one the room message would not. The confirm check's audience stays the whole room (conservative).
  Later members: a thread reply is judged with its thread's first message (`rooms/history.ts`, `COALESCE(thread_root_seq,
  seq)`); a test checks a shared answer in a thread.
- Double sends: guarded by the ref and the per-click id (see Scope).
- The question carries an id the AI also sees; it reads as the thread's id for `room_read` (harmless, useful).
- Another branch (`feat/trina-star-bigger`) edits `SideChatPanel.tsx`; whoever merges second resolves.

## Tests

Server (`tests/unit/b-answer-share.test.ts`, `b-side-chat.test.ts`, title): a share to a thread root; refusals (another
room's message, a deleted root, a reply or an event line or a private preview as root, a room I am not in, a
confidential chat), checked before the budget; the confirm flow with a thread target; one id per click; followers
notified; a later member's history. `bun run build:native` first; the room, chat, answer-share and side-chat suites, the
security permission matrix, then the whole `tests/unit`.
Web unit (Docker): the token's parse and hiding, the nearest-question rule, the control (send, ▾, confirm, error). e2e:
thread send, ▾ room send, the confirm path, an old chat without a token (room only); the side chat, room and share
specs. `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`.

## Result

(to fill in)
