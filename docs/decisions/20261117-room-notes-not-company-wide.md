# Room notes from a group chat: own folder plus a share with the room, not the company-wide folder

- Date: 2026-11-17
- Status: accepted
- Supersedes: the `shared/` fallback for group chats in 20261116-flow-regressions-0512-save-place.md
- Branch: fix/qa-man-026 (QA hands-on AI row MAN-026, retest of #1162)

- **What happened:** in the 3-person "leads" group chat (pras, qa-b, qa-c), the ✦ side chat saved "the notes from that
  link" to Company-wide › Meeting notes. Ten people can open that folder. No card asked, because the asker had an
  Always allow rule for wider saves from an earlier row (MAN-027).
- **Cause:** `saveInFor` (server/src/chat/side-room.ts) picks the smallest group folder that holds every plain member
  of the room. qa-b and qa-c share no group, so it fell back to `shared/`, and the side-room line told the AI not to ask
  where first.
- **Rule:** for a group chat, when no group folder holds every plain member and the team has people outside the room,
  the default place is the person's own folder. The side-room line then tells the AI to share the saved file with the
  room's other people (by name) with `share_with_person`, view only. That card is the one question. The AI does not put
  the file in `shared/` unless the user names a place.
- **Kept as before:** a team room (its group folder), the Everyone room (`shared/`), a group chat that a group folder
  holds (#1162's FL-28 case, its wider-audience card when the group is bigger than the room), a 1:1 and a guest (own
  folder). `shared/` stays the place when everyone in the team is in the room, or when the person may not share their
  own files (the team's "Members can share files they own" is off).
- **Why not ask "where?" first:** #1094 keeps room saves at one prompt at most. The share card names exactly who will
  see the file, which is the decision the person makes anyway.
- **Tests:** `tests/unit/b-side-chat.test.ts` (the own folder and the names, the side-room line, the members-cannot-share
  fallback).
- **Version impact:** patch (AI instructions and the default save place; no data change).
