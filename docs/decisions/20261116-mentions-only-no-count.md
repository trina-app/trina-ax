# A conversation at "Mentions only" adds no number until a message mentions me

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/mentions-only-no-count (the owner, QA TC-4171)

Refines "대화방 알림 설정" and "Session markers" in the archive ([DECISIONS.md](../DECISIONS.md)) and the rail's badges
(docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): those already kept plain messages of a room at 멘션만 out of the one
count n (the tab title, the Dock, the phone icon), but the row's badge, a folder's pill and the 대화 count on the rail
and the phone tab bar still counted them.

- **Ask:** an app channel ("Daily Checkins") set to **Mentions only** made no sound, but its unread number still went up
  in the sidebar, and so did everything that adds it up. The owner expects Slack's behaviour.
- **Rule:** one shared helper, `roomCounts(room)` in shared/src/api/attention.ts, gives `{ bold, mention, number, quiet,
  counts }` and every surface reads it, the server's phone icon number included (server/src/notifications/push-badge.ts
  through `attentionCount` › `roomWantsMe` › `roomCounts`):
  - **Mentions only:** plain messages make the row's name bold and add no number anywhere: no row badge, nothing in its
    folder's pill, the 대화 count on the rail and the phone tab bar, the messages total, the tab title, the Dock or
    taskbar, the phone icon. A folded folder or section with such a room is bold too, with no pill. A message that
    mentions me (a mention by name, or the everyone word from someone else: `mentioned`, as today) shows the "@" badge
    and counts everywhere. A reply in a thread I follow keeps its own rule (it has a number, and counts in n while
    "Replies in threads I follow" is on).
  - **All messages:** unchanged, every unread message and followed reply.
  - **Off:** unchanged: the grey number, never in a total (mentions included). This was already so for muted rooms
    (`room.muted`, my own level 끄기). It is now also so for a room that is off only through my default "nothing", which
    the rail and folder pill used to count while the one count n did not.
  - A screen reader still hears that the row has unread messages: the badge's place holds the words "Unread messages"
    (`rooms.unreadNoCount`) when there is no number.
- **Default levels (checked):** a new room has no level of its own, so my default applies (Settings › Notifications,
  `direct` unless I changed it): team rooms (Channels, the groups' rooms, and the everyone room) are **Mentions only**,
  DMs and group chats **All messages**. An app posts in the room it was added to, so an app channel follows the
  room's kind. "Mentions only" is therefore the default of every channel: with this rule a channel's plain messages
  show bold and no number by default, as in Slack. Nothing is added to settings.
- **Why one helper:** the rule lived in four places (the row's `roomBadge`, the rail's `unreadRooms`, the folder's
  `roomFolderPill`, the one count's `roomWantsMe`), and three of them did not know the level. With one helper, on the
  server too, they cannot drift apart again.
- **Left out:** a count of mentions (Slack shows how many): the server sends only whether one mentions me, so a
  mentioned room shows "@" and adds its unread count to the messages total, as before.
- **Tests:** web/test/unit/room-counts.test.tsx (the helper, every surface that adds up, the row badge's words),
  tests/unit/push-badge.test.ts (a group chat set to Mentions only: 3 plain messages leave the phone icon at 0, a
  mention makes it 1), web/test/e2e/mentions-only-count.spec.ts (sidebar row, folder pill, rail: 3 plain messages →
  bold, no number; a mention → "@" and 1).
- **Version impact:** none (the server already sends each room's level; an older server's rooms follow its kind).
