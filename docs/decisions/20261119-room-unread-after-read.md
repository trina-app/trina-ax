# A conversation's row goes by its timeline: read to the end, it is plain

- Date: 2026-11-19
- Status: accepted
- Supersedes: the row part of "Badges" in "스레드와 반응" ([DECISIONS.md](../DECISIONS.md)) and "A reply in a thread I
  follow keeps its own rule" in [20261116-mentions-only-no-count.md](20261116-mentions-only-no-count.md)
- Branch: fix/room-unread-after-read (the owner, QA TC-5363)

- **Ask:** on potenlab.trina.app (0.5.18) the owner opened a bold channel, read it, switched to another one, and the
  first one stayed bold, in the web app, the desktop app and on their other devices. Expected: Slack, where a channel
  you have seen is no longer bold.
- **Cause:** the channel had a new reply in a thread they follow (they wrote its root; Slack's rule, unchanged). The
  row's mark (`roomCounts`) added the followed threads with new replies (`threadsUnread`) to the timeline's unread
  messages, and reading the room reads only its timeline, never a thread. The read itself was saved (server:
  `unreadCount 0`, `lastReadSeq` at the newest), but `threadsUnread` stayed 1, so the row stayed bold with a number until
  that thread was opened. Reproduced on a private copy of the QA team with two accounts; plain messages alone were read
  as expected (focus, scroll and the sidebar's cache were not the cause).
- **Rule:** a row's marks (the bold name, the number, a folder's pill, the 대화 count on the rail and the phone tab bar)
  go by the room's own timeline (`unreadCount`), as Slack's channels do. A followed thread's new replies show where
  Slack shows them: the root's dot, the room header's thread mark, and **Mentions & threads** (their notices). One
  exception stays on the row: an unread followed reply that mentions me shows "@" (and bold) until it is read.
- **The numbers follow the rows** (review of #51): the one count n (the tab title, the Mac Dock, an installed web app's
  icon, the phone app's icon and the server's push badge, server/src/notifications/push-badge.ts) counts a room exactly
  when its row counts (`roomWantsMe` = not hidden and `roomCounts(..).counts`): a room's own unread messages that want
  me by my level, and an unread @mention, one inside a followed thread included. A followed thread's reply without a
  mention adds to no number, so the icon never shows "1" with nothing marked in the list; it is in Mentions & threads
  (its own mark) and under its root, and the Dock's dot for unread rooms (`roomLightsDot`) still lights for it. The
  "Replies in threads I follow" switch now only decides notices: the server's push and Inbox row (unchanged) and the
  desktop app's notice of a room message (`roomNoticeWanted`: wants me, or a followed reply while the switch is on).
- **Unchanged:** the server's numbers (`Room.threadsUnread`, `nextThreadId`), the notices, and reading a thread.
- **Tests:** web/test/unit/room-counts.test.tsx (the rule, every surface that adds up, the one count agreeing with the
  rows, the desktop notice), tests/unit/push-badge.test.ts (a followed reply: 0; one that mentions me: 1),
  web/test/e2e/room-read-not-bold.spec.ts (1440 and 390: read the channel, switch away, not bold, after a reload too).
- **Version impact:** patch.
