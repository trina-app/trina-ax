# Chats sidebar: "Channels" and group conversations in Direct messages

- Date (UTC): 2026-11-16
- Branch: `feat/sidebar-channels-dms`
- Status: in progress
- Where: trina-ax (Team AX core: web/src/components/nav, web/src/components/panels, web/src/pages/Rooms.tsx, the
  language tables, server/src/chat/i18n.ts, docs/site). Why: the Chats list is a core chat feature
  (docs/REPOSITORY-RULES.md)
- Version impact: patch (wording and the order of one list; no API, DB or URL change)
- QA: TC-3835 (Channels wording), TC-3836 (group conversations inside Direct messages)

## Goal

Owner decision 2026-11-16: the Chats sidebar has "Team rooms" and a separate "Group chats" section, and people find the
two confusing. Follow Slack: team rooms (the everyone room and one per group) are **Channels**, and group chats are
listed in **Direct messages** with the 1:1s.

## Scope

In:
- Words only (no identifiers, APIs, tables or URLs): every user-visible name of a team room in the six language tables
  and the server's chat table, and the user docs in docs/site (every language that has the pages). The DM section in ko
  and ja is named for 1:1s only ("1:1 대화", "1:1トーク") and becomes Slack's "다이렉트 메시지" / "ダイレクトメッセージ".
- The rename dialog's label and the "renamed" event line say "group chat" in a team room too: the label gets a channel
  word for team rooms, the event line no longer names the kind.
- Sidebar (and the phone's Chats tab, same sections): the "group" section is removed; `group` rooms are in the DM
  section, ordered with the 1:1s by latest activity (the store's order, as the DM section already is). A group chat's
  row shows the shared `FaceStack` (2 faces) instead of the speech-bubble icon; its name is cut with "…" as before.
- Pins, folders, unread badges, mute, the row menu, rename and leave: the same `RoomRow`/`RoomMenu`, unchanged.

Out: the room header (another branch), group chats' own name ("group chat" stays the word for one), conversation
folders.

## Checks

typecheck, check:i18n, check:docs, guard tests (korean outside tables, product name, korean register, i18n completeness,
docs-site), web unit tests for nav/rooms, targeted e2e (chats panel, rooms, DMs, group chats), screenshots 1440/390 light
and dark for owner, member and guest.
