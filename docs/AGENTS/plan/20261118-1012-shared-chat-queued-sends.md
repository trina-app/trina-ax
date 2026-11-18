# Queued sends in shared chats

- Date (UTC): 2026-11-18 10:12
- Branch: `feat/shared-chat-queued-sends`
- Status: in progress
- Where: Team AX core (web chat screen + server chat routes). Why: chat behaviour is core (docs/REPOSITORY-RULES.md).
- Version impact: minor, a new behaviour and one new route (`PUT /api/chats/:id/waiting`).

## Goal

QA TC-4899. In a shared project chat, while the AI answers (my question or someone else's), I cannot send the next
message: the box shows Stop, or holds my text with "○○님의 질문에 답하는 중이에요". The owner wanted to attach another
zip and say "이것도". In a private chat that message waits under the conversation and goes when the answer is done.
Make it work the same way in shared chats.

## Why it was off

docs/DECISIONS.md "Shared project chats" (2026-11-07) listed queued sends under "Not in phase 1": one turn at a time
per chat (409 `shared_chat_busy`), and the client-only queue would let two people's browsers race at the end of an
answer. Two more problems a queue would hit there: a queued message is sent under the last answer this browser shows,
which in a shared chat may be stale (someone else's turn ended and was not read yet: the send would make a branch),
and someone else's stopped or failed answer would pause my queue as if I had stopped it.

## Scope

In:
- Shared chats queue like private chats: Send/Enter while any answer runs (mine or someone else's) puts the message
  under the conversation with its attachments; edit, remove, "Send now", reload survival as today.
- Order between people decided by the server: a small in-memory "who waits since when" list per shared chat
  (`PUT /api/chats/:id/waiting {count}` from the browser that holds waiting messages, refreshed every 15 s, gone after
  45 s without a refresh). A send in a shared chat while someone else has waited longer is refused 409
  `shared_chat_next`; that browser keeps its messages waiting and tries again. A send clears the sender's place, so
  someone with more waiting goes to the back (first queued, first sent, one turn each).
- Queued sends in a shared chat go under the chat's current end (no parentId: the server's active leaf), never a
  stale branch.
- Someone else's stopped or failed answer does not pause my queue; my own still does.
- Others see only "N messages waiting" (`Chat.shared.waiting`), never the text or the attachments before they are sent.
- A queued computer file keeps the "saved in the project folder · N people can see it" line under it.
- Copy in en.ts first, then ko/ja/zh/es/id.

Out: queueing edit or regenerate (they still wait for the running answer), names of who waits.

## Steps

1. Server: `chat/shared-waiting.ts` (the list), the route, `busyCheck` order rule, `Chat.shared.waiting`.
2. Web: sendQueue store (declare to the server, shared rules in the pump, send at the leaf), Chat.tsx (queue in shared
   chats, the line above the box no longer blocks), Composer (`later`, `note`), QueuedMessages (upload line, others
   waiting).
3. Mock server + e2e (two people), unit tests (pure helpers, server route), decision file, change note.

## Decisions

docs/decisions/20261118-shared-chat-queued-sends.md

## Result

(filled in at the end)
