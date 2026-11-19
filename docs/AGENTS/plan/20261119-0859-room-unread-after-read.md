# A conversation read to its end is no longer bold (QA TC-5363)

- Date (UTC): 2026-11-19 08:59
- Branch: `fix/room-unread-after-read`
- Status: done
- Where: web + shared (Team AX core). Why: the rooms list and its counting rule live in the core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to how a row is marked

## Goal

The owner (potenlab.trina.app, 0.5.18) opens a bold channel, reads it, switches to another one, and the first one stays
bold, on every device. Expected (Slack): once the channel's messages are seen, the row is no longer bold.

Reproduced on a private copy of the QA team (two accounts, one posts, one reads): plain messages are read and the row
goes plain. When a reply came in a thread I follow (I wrote the root, or replied there before), the row stays bold
after reading the whole timeline: `roomCounts` makes a row bold for `unreadCount + threadsUnread`, and reading the room
never reads a thread. Server state after the read: `unreadCount 0, threadsUnread 1`.

## Scope

In: the row's marks (bold name, number, "@") and the totals that add them up go by the room's own timeline, as in Slack.
A followed thread's new replies show in the room (the root's dot, the header's thread mark), in Activity and as
notices; on the row only when one mentions me ("@"). After review: the one count n (tab title, Dock, phone icon,
push badge) follows the rows too (roomWantsMe = the row counts); the desktop notice for a followed reply stays
(roomNoticeWanted), and so does the Dock's dot.
Out: a Threads view.

## Steps

1. `shared/src/api/attention.ts`: `roomCounts` from the timeline (+ mention); `roomWantsMe` keeps followed replies on its own.
2. Unit tests (web/test/unit/room-counts.test.tsx, session-markers), push badge test unchanged.
3. Web e2e: read a channel with a followed thread reply, switch away: not bold (1440, 390).
4. Decision file, changes file, shots at 1440/390 light/dark.

## Decisions

docs/decisions/20261119-room-unread-after-read.md

## Result

`roomCounts` goes by the timeline (and an unread mention); `roomWantsMe` and `roomLightsDot` keep their answers without
it. Verified on the private QA copy: before, the channel stayed bold after the read (`unreadCount 0, threadsUnread 1`);
after, it is plain once left, and the followed replies show in Mentions & threads, under the root and in the header's
thread mark. Tests: web/test/unit/room-counts.test.tsx (+ rail-badges, room-messages, rooms-store updated to the rule),
web/test/e2e/room-read-not-bold.spec.ts (fails on the old rule).
