# The side chat comes back after a reload; a reloaded chat opens at its bottom

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (extends [The side chat queues a message sent while the answer runs](20261118-side-chat-queued-sends.md))
- Branch: fix/chat-live-and-reload (QA TC-4962, TC-4963)

- **Ask (TC-4963):** a message waits in the ✦ side chat's queue, the page is reloaded, and the panel stays closed until
  ✦ is pressed. It should open again by itself when it has waiting messages, and a panel that was open before the
  reload should be open after it.
- **Rule:** the room page remembers per tab (sessionStorage, per person: `web/src/lib/sideChatOpenKeep.ts`) which rooms
  have the side chat open; opening and closing it (✦, ✕, ‹, a thread taking its place) and leaving the room write it.
  When the room page opens it asks once (`SideChatPanel.tsx sideChatComesBack`): open after a reload when it was open
  in this tab; on a computer also when messages of mine wait in the room's newest side chat (looked for only when this
  browser keeps waiting messages at all, so an ordinary room open asks the server nothing more). The panel then opens
  on the chat they wait in, as ✦ already did. Never for a guest whose invite gives them no AI.
- **Phone (390 px):** the side chat is a screen over the room there. A reload brings it back when it was the screen
  showing (as a thread's screen comes back with its address), but waiting messages alone do not cover the room the
  person opened with a screen they had closed; ✦ opens it on that chat.
- **Ask (TC-4962):** after a reload a chat opened above its bottom: the newest answer and the waiting messages were
  below the fold, and it did not stay at the bottom while pictures and code blocks above loaded.
- **Why:** the list jumped to its bottom, then the running answer and the waiting messages took their place under it,
  and Chromium's scroll anchoring moved the list up 160 px to keep a row above them where it was. That scroll event (the
  list's own height unchanged) read as the reader scrolling up, so the list stopped following (measured: 222 px above
  the bottom, for good).
- **Rule:** while a message list follows its newest message the browser's scroll anchoring is off
  (`web/src/lib/stickToBottom.ts anchorWhileFollowing`, every list using `useStickToBottom`: the AI chat, the side chat,
  room threads, answer threads); the size watcher keeps it at the bottom itself. Scrolled up, anchoring is the
  browser's again, so a picture loading above keeps the message in sight; loading older messages keeps its own setting
  (holdPlace).
- **Tests:** `web/test/unit/side-chat.test.tsx` (four TC-4963 cases: a waiting message on a computer, nothing waiting,
  open before the reload and closed or left after, a phone), `web/test/unit/stick-to-bottom.test.ts` (the anchoring
  case and the toggle).
- **Version impact:** patch (two fixes).
