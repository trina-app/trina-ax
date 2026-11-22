# A message sent offline is kept and goes when the connection is back

- Date (UTC): 2026-11-22
- Branch: `fix/offline-message-outbox`
- Status: done
- Where: web (store/chats.ts, store/rooms.ts, lib/connectionWait.ts, lib/unsentChats.ts). Why: scenario QA TC-r2d-06
  (S-038, P1): on a phone (390) a message sent in a shared chat while offline turned into "보내지 못했어요" after the
  connection came back 10 minutes later, and a reload lost it. 한지우 never got it.
- Version impact: patch. Send reliability only; no API, data or setting changes.

## Cause

- Chats: a send that failed on the network was retried for `SEND_RETRY_MS` (30 s) and then shown as not sent; the
  waiting send lived only in memory (`outbox` Map), so a reload lost it. An earlier QA run delivered because the device
  was offline for less than 30 s, not because of Enter versus the button.
- Rooms: a send that failed on the network was at once "not sent"; it was kept on the device (`roomUnsent:`), but came
  back after a reload as not sent and waited for 다시 시도.

## Change

- `lib/connectionWait.ts`: `connectionDown()` (navigator.onLine false, or the live connection offline/reconnecting) and
  `whenConnected()` (the live connection open again, the browser's `online`, or a try again every 20 s).
- Chats: a network failure while the connection is down keeps the message "보내는 중…" and waits for the connection, then
  sends again with the same clientMessageId (the server keeps the first one). It goes under the newest end of the branch
  through the message it answered (`after`), so a conversation that went on meanwhile gets no new version. Only a
  connection that is back and still fails for 30 s shows "보내지 못했어요 · 다시 보내기".
- Chats: the waiting and not-sent messages are kept on the device per person and chat (`chatUnsent:<chatId>`, cleared at
  sign-out with the drafts). The chat read again after a reload puts them back: on their way → sent by themselves;
  not sent → "다시 보내기". One the server's copy already has is not put back.
- Rooms: the same wait on a network failure while offline; sends put back after a reload go again by themselves (same
  client id; the server answers a repeated id with the first message).

## Tests

- `web/test/unit/offline-send.test.ts`: connection wait; chat offline send waits and goes with `after`; chat reload
  puts it back and sends it; one already delivered is not put back; a refused one comes back as not sent; room offline
  send waits and goes; room reload sends it by itself.
- Visual: a private QA copy, Playwright offline at 390 for 10+ minutes and a reload, in a room and in a shared chat.
