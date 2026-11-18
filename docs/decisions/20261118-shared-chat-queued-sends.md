# Messages sent during an answer wait in shared chats too, in the order people queued them

- Date: 2026-11-18
- Status: accepted
- Supersedes: "No queued sends" in docs/DECISIONS.md "Shared project chats" (phase 1, 2026-11-07)
- Branch: feat/shared-chat-queued-sends (the owner, QA TC-4899)

Plan: docs/AGENTS/plan/20261118-1012-shared-chat-queued-sends.md.

- **Ask:** in a shared project chat, while the AI answered, the owner wanted to attach another zip and say "이것도". The
  box showed Stop (their own question) or held the text with "○○님의 질문에 답하는 중이에요" (someone else's). "왜 미리
  못보내두지? 왜 큐에 못쌓아두지?" In a chat of one person such a message waits under the conversation and goes when the
  answer is done (docs/DECISIONS.md "Messages typed during an answer wait and go when it ends").
- **Why it was off:** phase 1 left it out ("Not in phase 1 … queued sends"): one turn at a time per chat (409
  `shared_chat_busy`), and a queue kept only in each browser would have two people's browsers race when an answer ends.
  Two more things a queue would have hit there: a waiting message goes under the last answer the page shows, which in a
  shared chat can be stale (someone else's turn ended a moment ago and is not read yet), so the send would have made a
  second version of the conversation; and someone else's stopped or failed answer would have paused my messages as if I
  had stopped it.
- **Rule:** the same queue as a private chat (store/sendQueue.ts, kept in the sender's browser: edit, Don't send, Send
  now, a reload keeps them, several of one person go together as one message). While someone else's question is
  answered the line above the box says whose and that what is sent now goes after it; the clock button queues (no Stop:
  only the asker stops). Also queued: a send while the others' messages wait (theirs go first).
- **Order between people, decided by the server:** the browser holding waiting messages tells the server how many wait
  (`PUT /api/chats/:id/waiting {count}`, never the text; again every 15 s, and 0 when they are sent, removed, paused or
  being edited). The server keeps, in memory, who waits since when per shared chat (chat/shared-waiting.ts); a place not
  refreshed for 45 s (a closed tab) stops counting. A send there while someone else has waited longer is refused 409
  `shared_chat_next` naming them; that browser keeps its messages waiting and tries again two seconds later, as after a
  409 `shared_chat_busy`. A send removes the sender's place, so someone with more waiting goes to the back: one turn
  each, first queued first sent. Chosen over a server-side message queue (the text would have to be stored and shown to
  nobody, edited and removed there) and over a client rule alone (which would leave the order to whose browser is
  faster). A server restart forgets the places; the next refresh says them again.
- **Under the chat's end:** a queued send in a shared chat has no `parentId`, so it is answered under the chat's
  active end as the server has it, never under a stale answer of this page (no branch).
- **Pauses:** my own stopped or failed answer pauses my waiting messages ("Send now"), as in a private chat; someone
  else's does not. A reload when others' turns happened meanwhile: "This message has not been sent yet." with Send now.
- **What the others see:** `Chat.shared.waiting`, how many messages of the others wait, as one quiet line under the
  conversation ("다른 사람의 메시지 2개가 보내기를 기다리고 있어요"): no names, no text, no files before they are sent.
- **Files:** a file from the computer is saved in the project folder when it is attached (as before); a waiting message
  keeps the line "프로젝트 폴더(채팅 첨부)에 저장돼요 · N명이 볼 수 있어요" under it (a chat shared with people: its own line).
- **Known limit:** the place in line is per person: one person queueing from two devices at the same time has one
  place for both, so those two devices' messages are not ordered between themselves (each still goes, once).
- **Not changed:** edit and regenerate still wait for the running answer (they are not queued) and are not ordered by
  the waiting places; the read card stays the asker's.
- **Tests:** tests/unit/b-shared-waiting.test.ts (order, refresh, time-out), tests/unit/b-shared-chats.test.ts (two
  people, 409 shared_chat_next, the count each sees, the send under the chat's end), web/test/unit/send-queue.test.ts
  (declared counts, someone else's turn, 409 next, someone else's stopped answer), web/test/e2e/shared-project-chats.spec.ts
  (Bob's file and "이것도" wait for Olga's answer, Olga sees only the count, both queue and go in order, reload; 1440
  and 390).
- **Version impact:** minor (new behaviour, one new route).
