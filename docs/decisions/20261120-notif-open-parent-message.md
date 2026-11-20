# A notice opens the message it is about, with a thread's parent in the middle

- Date: 2026-11-20
- Status: accepted
- Supersedes: part of [the Inbox click](../DECISIONS.md) ("The click opens the thread (`/rooms/<id>/t/<root>`) or the
  room at my first unread message") and the room push path `/rooms/<room>/t/<root>` in the rooms threads entry
- Branch: fix/notif-open-parent-message (the owner, QA TC-5665 to TC-5671)

- **Ask:** The owner clicked an Activity row for a thread reply with an @mention under a Trina answer. The thread opened
  on the right, but the chat in the middle stayed where it was (a later answer), not at the answer the thread is under.
  Slack scrolls to the parent, lights it and opens the thread. The same for every notice that points at a message,
  push taps too, and in a personal chat shared with Share as well as project chats and rooms.
- **Rule (rooms, `pages/Room.tsx`, `lib/rooms.ts` timelineTarget):** with no thread open, the timeline goes to `?m=` and
  lights it (as before). With a thread open from a link, an Activity row or a push tap, the timeline goes to the
  thread's first message and lights it, and the thread lights `?m=` (the reply). A message that is not among the loaded
  ones is loaded around (`store/rooms.ts` loadAround, as for a search hit). A thread opened by a click in the room
  (history state `here`) leaves the room where it was. `RoomMessages` lights a message again the next time a link points
  at it.
- **Rule (chats, `pages/Chat.tsx`, `lib/linkedAnswer.ts`):** a thread at `/c/<chat>/t/<answer>` opened from outside the
  chat goes to that answer and lights it (`data-focused`, as `?answer=`), reading up to 10 older pages (500 messages)
  to find it. On another version of the chat the chat stays where it is (the thread panel says which version). This is
  the same page for a project chat, a chat shared by Share with people, and the owner of that chat.
- **Rule (push):** a phone's push path names no query (`validPushPath`), so a room notice's path ends at its message:
  `/rooms/<room>/m/<message>`, a reply `/rooms/<room>/t/<root>/m/<reply>` (`notifications/push-events.ts` roomPath).
  The web app reads `/m/<id>` as `?m=<id>` in place of the address (`App.tsx`, `lib/rooms.ts` pushedMessagePath). The
  browser's service worker takes the message's id from the signed-in notice (`room.message`) and opens `?m=`. A chat
  thread's push path stays `/c/<chat>/t/<answer>`: the page goes to the answer from the path alone.
- **Left out:** a chat thread notice does not name the reply (no `?m=` in the chat thread panel); the panel opens at its
  newest replies, as before. A chat answer on another version is not switched to.
- **Tests:** `web/test/unit/linked-answer.test.ts`, `web/test/unit/push-worker.test.ts`, `tests/unit/b-rooms.test.ts`,
  `tests/unit/b-rooms-threads.test.ts`, `web/test/e2e/inbox-rooms.spec.ts`, `web/test/e2e/chat-threads.spec.ts`.
- **Version impact:** none (no API change; a phone app opens any id path in the page).
