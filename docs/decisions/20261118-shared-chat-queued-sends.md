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
  `shared_chat_next` (naming nobody); that browser keeps its messages waiting and tries again two seconds later, as
  after a 409 `shared_chat_busy` (without reading the chat again). A send removes the sender's place, so someone with
  more waiting goes to the back: one turn each, first queued first sent.
- **A first place nobody uses** (review of #1280): the first time someone is held back by a place while no answer
  runs, its holder has 12 s to send; after that the place goes to the back and holds nobody back until its holder
  sends or stops waiting (a browser that never sees the answer end, or a script that only says it waits). A new turn
  gives the next quiet moment a fresh grace period. The browser also reads a shared chat with waiting messages again
  whenever someone else's turn starts or ends, from the queue's runner (not only the open chat page), and says a
  count only for a chat whose messages it has and are current (else 0).
- **Limits on the route:** at most 30 calls a minute per person and chat (429). The others are told
  (`chat.updated`) only when someone starts or stops waiting; `Chat.shared.waiting` counts people, not messages. A
  say of "waiting" within 3 s of the person's own send is refused (409 `waiting_after_send`: a refresh that left
  before the send must not make a new place); the browser says it again 3.5 s later. Places go with the chat
  (deleted, in the trash, purged, no longer shared: publishChat) and with a person who stops seeing it (stopTurnsIn). Chosen over a server-side message queue (the text would have to be stored and shown to
  nobody, edited and removed there) and over a client rule alone (which would leave the order to whose browser is
  faster). A server restart forgets the places; the next refresh says them again.
- **Under the chat's end:** a queued send in a shared chat has no `parentId` but `after`: the last message its page
  showed. The server answers it under the newest end of the branch through that message: turns that came since (not
  read yet on that page) are kept, and a version someone switched to between turns is not where it lands.
- **Pauses:** my own stopped or failed answer pauses my waiting messages ("Send now"), as in a private chat; someone
  else's does not (a question with no author, from before authors were kept, counts as the chat's creator's). A reload when others' turns happened meanwhile: "This message has not been sent yet." with Send now.
- **What the others see:** `Chat.shared.waiting`, how many other people have messages waiting, as one quiet line under
  the conversation ("다른 사람 2명의 메시지가 보내기를 기다리고 있어요"): no names, no text, no files before they are sent.
- **Files:** a file from the computer is saved in the project folder when it is attached (as before); a waiting message
  keeps the line "프로젝트 폴더(채팅 첨부)에 저장돼요 · N명이 볼 수 있어요" under it (a chat shared with people: its own line).
- **Known limit:** the place in line is per person: one person queueing from two devices at the same time has one
  place for both, so those two devices' messages are not ordered between themselves (each still goes, once).
- **Not changed:** edit and regenerate still wait for the running answer (they are not queued) and are not ordered by
  the waiting places; the read card stays the asker's.
- **Tests:** tests/unit/b-shared-waiting.test.ts (order, refresh, time-out, grace period, a late refresh, drops),
  tests/unit/b-shared-chats.test.ts (two people, 409 shared_chat_next naming nobody, someone who never queued, the
  count each sees, a holder who never sends, guests / outsiders / removed members, the rate limit, a deleted chat,
  `after` with a branch switch and with newer turns), the permission matrix (Team plan's shared chat),
  web/test/unit/send-queue.test.ts (declared counts, someone else's turn read again with another chat open, a chat not
  loaded says 0, 409 next, someone else's stopped answer, no-author questions), web/test/e2e/shared-project-chats.spec.ts
  (Bob's file and "이것도" wait for Olga's answer, Olga sees only the count, both queue and go in order, reload; 1440
  and 390).
- **Version impact:** minor (new behaviour, one new route).
