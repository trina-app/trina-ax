# The side chat queues a message sent while the answer runs

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (extends "Messages typed during an answer" in docs/DECISIONS.md to the room side chat)
- Branch: feat/side-chat-queued-sends (the owner, QA TC-4912)

- **Ask:** in the ✦ side chat beside a room or thread, send was off while the AI answered. Queue the next message the
  way the full chat does.
- **Rule:** the side chat uses the full chat's queue (store/sendQueue.ts), the same component under the messages
  (QueuedMessages) and the same words. Sent while an answer runs, the box's text and files wait; the box empties. A
  stopped or failed answer pauses them with "Send now", and a message sent then goes at once with them.
- **Context is fixed when queued:** what the box showed on top of the question (a quoted message, else the "Looking at
  this thread" chip) is kept with the waiting message as its `lead`, so it goes about the same thread even if the thread
  closed or the chip was taken off meanwhile. The lead is not part of the edit (as an edit of a sent side chat question
  keeps its thread line). Waiting messages are combined only with others under the same lead; a message about
  something else goes in the next turn.
- **Kept across closing and reloads:** a side chat with waiting messages counts as not done, so the panel opens again
  on it, also after a reload (the browser's stored queue is checked when the newest side chat is looked for). A reload
  follows the full chat's rule: it still sends by itself only if the awaited answer is the newest message; otherwise it
  waits for "Send now".
- **Not changed:** an answer to the AI's question is still sent at once; starters and quick questions stay off while an
  answer runs; shared chats are not touched here (their queue is PR #1280). The side chat has no stop button.
