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
- **Unchanged:** the one count n (tab title, Dock, phone icon) and the desktop app's notice still count a followed
  reply while "Replies in threads I follow" is on (`roomWantsMe`, now written without `roomCounts`, same answers), the
  Dock's dot for unread rooms, the server's numbers (`Room.threadsUnread`, `nextThreadId`), and reading a thread.
- **Tests:** web/test/unit/room-counts.test.tsx (the rule, every surface that adds up, the one count),
  web/test/e2e/room-read-not-bold.spec.ts (1440 and 390: read the channel, switch away, not bold, after a reload too).
- **Version impact:** patch.
