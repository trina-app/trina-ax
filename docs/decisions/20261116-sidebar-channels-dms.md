# Team rooms are Channels, and group chats are listed in Direct messages

- Date: 2026-11-16
- Status: accepted
- Supersedes: the section names and the "Group chats" section of [Conversations by kind under Show more](../DECISIONS.md#conversations-by-kind-under-show-more-featsidebar-rooms-by-kind-2026-11-11-product-owner)
- Branch: feat/sidebar-channels-dms (the owner, QA TC-3835, TC-3836)

넣을 곳: Team AX core (`web/src/components/nav/RoomsList.tsx`, `web/src/components/rooms/RoomIcon.tsx`, the six
`web/src/i18n/*.ts`, `server/src/chat/i18n.ts`, `docs/site`), 이유: the Chats list and its words are core. Plan:
`docs/AGENTS/plan/20261116-0617-sidebar-channels-dms.md`.

- **Ask:** the Chats list had **Team rooms** (the everyone room and one # room per group) and a separate **Group chats**
  section (chats of hand-picked people), and people could not tell the two apart. Follow Slack: channels, and direct
  messages that hold both 1:1s and group DMs.
- **Rule: "Team rooms" are "Channels" wherever the app names them.** en Channels / channel, ko 채널, ja チャンネル, zh 频道,
  id Saluran, es Canales: the Chats section, the warning that a chat read channels someone may not be in, the new
  member's welcome card, the rename prompt of a channel ("Channel name"; a group chat's stays "Group chat name"), the AI's
  "send to" card for a channel with no name of its own (`#channel`), and the user docs in every language. Words only:
  the room kinds (`team`, `all`), the API, tables and URLs keep their names. The everyone room stays **Everyone**.
- **Rule: no Group chats section.** Group chats are in **Direct messages** with the 1:1s, in one list by latest activity
  (the order the DM section already had). Since that section now holds more than 1:1s, its ko and ja names become Slack's
  "다이렉트 메시지" and "ダイレクトメッセージ" (were "1:1 대화", "1:1トーク"); en, zh, id and es were already Slack's.
  A group chat's row shows two of its people's faces (the shared `FaceStack`, ringed in the row's colour) in place of the
  speech bubbles, and its name as before: its own name, or its people's names cut with "…". A group chat with nobody
  else left keeps the bubbles. The room header is unchanged.
- **Unchanged:** pins, conversation folders, unread and "@" badges, mute, the row's "⋯" (rename, leave, hide, notify,
  copy link), new group chats (they appear in Direct messages), and the word "group chat" for one of them (guests, invites,
  the people picker).
- **The rename line no longer names the kind.** "{actor} renamed the group chat to {name}" also showed in channels (team
  rooms can be renamed); it is now "{actor} renamed this to {name}" / "{actor} reset the name".
- **Removed:** the "Group chats" section and its key `rooms.section.group`.
- **Earlier naming:** "대화방 v1" named them 팀 대화방; "그룹 대화와 방 이름" added group chats as their own kind; "지난 대화"
  (2026-11-07) already made team rooms and the everyone room work like Slack channels. This makes the words match.
- **Tests:** `web/test/unit/rail-panels-p3.test.ts` (sections and the mixed order), `web/test/unit/rooms-lib.test.ts`
  (the rename line), `web/test/e2e/chats-panel.spec.ts` (labels, order, faces).
- Version impact: **patch** (words and the order of one list; no API, DB or URL change).
