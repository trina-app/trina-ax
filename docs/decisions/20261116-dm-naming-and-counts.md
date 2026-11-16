# One name for a group chat, and a channel's count is its members

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/dm-naming-and-counts (QA TC-3934, TC-3935, TC-3936, TC-3937)

- **Ask:** after [Channels and Direct messages](20261116-sidebar-channels-dms.md) a chat of several hand-picked people
  was called "Group chat", "group conversations" and "Direct and group conversations" in different places, and the New
  conversation dialog listed channels under "Groups" with a count ("3 people") other than the channel's header ("4
  members").
- **Rule: one name for a multi-person direct message, everywhere the app and the docs say it.** en **group chat**, ko
  **그룹 대화**, ja **グループトーク**, zh **群聊**, id **obrolan grup**, es **chat de grupo**. The section that holds them and
  the 1:1s stays **Direct messages** (`rooms.section.dm`); a 1:1 on its own is en "Direct message", ko "1:1 대화", ja
  "1:1トーク", zh "私信", id "Pesan langsung", es "Mensaje directo" (ko and ja keep the short "1:1" where an Activity
  row says where a notice is from). Where both kinds are meant, the text names both
  ("Direct messages and group chats", "1:1 대화·그룹 대화"), never "direct and group conversations". Words only: code
  names, the API and the room kinds (`dm`, `group`) keep theirs.
- **Rule: the New conversation dialog lists channels under the Chats list's word for them** (`rooms.section.team`:
  Channels, 채널, …), each by the channel's name as the list shows it. `rooms.picker.groups` is removed.
- **Rule: a channel's count is the header's.** The dialog's count is the channel's `memberCount` with the header's
  word (`rooms.members`: "4 members", me included). Before, it counted the people a tick would add (the group's active
  people minus me), so it was one less than the header for everyone in the channel. An owner or admin who is not in a
  group's channel sees that group's active people, themselves included if they are in it: the same rule the server uses
  to fill the channel (active, not deleted, not a guest). The guest invite's place list uses the same word for a group
  chat. `rooms.picker.groupCount` is removed. The Files view's "N people see it" is about the folder (its verb says so,
  and the owner and admins are in it), so it keeps its number and words.
- **Rule: a group chat's two faces fill the picture's box.** The front face is 80% of the box (16px in the sidebar's
  20px, 26px in a phone's 32px row) and ringed in the row's colour; the back one is 70%. A face without a photo is a
  disc in a shade of the line colour, not the hover colour, so it stays visible on a highlighted row in dark mode.
- **Rule: a refused thread reply delete says why in its own words**: "This reply can't be deleted: your team's
  security settings don't allow it, or the chat is confidential." (`threadReplyDeleteSafeOps`, all six languages), not
  the text about continuing shared chats.
- **Tests:** `web/test/unit/room-picker.test.tsx` (heading, count, an admin outside the channel),
  `tests/unit/b-chat-threads.test.ts` (TC-3784's 409 carries the new words), `web/test/e2e/chats-panel.spec.ts`.
- Version impact: **patch** (words, one count and the faces' size; no API, DB or URL change).
