# Side chat: a message sent while the answer runs waits, as in the full chat

- Date (UTC): 2026-11-18 10:00
- Branch: `feat/side-chat-queued-sends`
- Status: done
- Where: web/src/components/rooms/SideChatPanel.tsx with the full chat's queue (web/src/store/sendQueue.ts,
  web/src/lib/sendQueue.ts, web/src/components/chat/QueuedMessages.tsx). Why: the side chat is an ordinary personal
  chat, so it reuses the one queue instead of a copy.
- Version impact: minor, a new behaviour in the side chat

## Goal

QA TC-4912: in the ✦ side chat beside a room or thread, send is off while the AI answers. The full chat lets the message
wait ("답이 끝나면 보낼게요.") and sends it when the answer is done. The side chat should do the same.

## Scope

In: queueing from the side chat box (text, files, the quote or thread chip shown then), edit and remove, the queue kept
when the panel closes and opens and after a reload, the same look. Out: shared chats (PR #1280), a stop button in the
side chat, starters and quick questions while an answer runs (they stay off).

## Steps

1. lib/sendQueue.ts: an optional `lead` on a waiting message (what goes on top when it is sent); `combine` takes only
   messages with the same lead and puts it on top once; storage keeps it.
2. QueuedMessages: a message with a lead shows it as the sent bubble will (UserText with quotes).
3. SideChatPanel: send while busy queues (or sends now with paused ones), with the quote or thread line as the lead;
   the clock icon, "send when the answer is done" label and placeholder as in the full chat; the queue under the
   messages; restore when the chat's messages are read; a chat with waiting messages opens again (notDone, and
   findSideChat after a reload).
4. Tests: web/test/unit/send-queue-lead.test.ts, two tests in web/test/unit/side-chat.test.tsx.

## Decisions

docs/decisions/20261118-side-chat-queued-sends.md
