# Room content is saved where the room's people can open it, also from a group chat or a 1:1

- Date: 2026-11-16
- Status: accepted
- Supersedes: the group chat part of "Where the side chat saves room content" in
  [20261116-room-link-save-one-prompt.md](20261116-room-link-save-one-prompt.md)
- Branch: fix/flow-regressions-0512 (AI flow run on dev 30a54f4e2, FL-28, QA TC-3833)

- **Ask:** in the ✦ side chat of the group chat "라마바카페 건", "민호님이 올린 일요일 회의록 링크 내용 파일로 저장해줘" (no
  place named) saved the notes in the person's own folder (users/<id>/), which nobody else in the room can open. This is
  the owner's own case. Before #1094 the same request saved into the company meeting-notes folder.
- **Why:** #1094 (side-room.ts `saveInFor`) told the AI, for a group chat or a 1:1, to save in the person's own folder
  ("no team folder is just those people"), and that asking to save is enough, so it did exactly that.
- **Rule:** unless the person names a place, the side chat saves the room's content where the room's people can open it:
  - a team room: its group's folder (as before);
  - the Everyone room: shared/, in its fitting subfolder (the meeting-notes folder for meeting notes) by the rule on where
    files go (as before, the subfolder now said in the line);
  - a group chat: the folder of the smallest group that every member who is not an owner or admin belongs to (owners
    and admins read every group's folder, so they do not decide); with no such group, shared/. The person must be able
    to write there and every team member of the room to read it. When people outside the room can open that folder
    (owners, admins, other members of the group), the wider-audience card asks as before;
  - a 1:1, or a person who is a guest: their own folder, as before (a private talk is not for a department by default).
  - a folder the person names by its name ("회의록 폴더") is that folder where it already is, not a new one inside the
    default (AI flow FL-29 saved into a new 영업/회의록 when the company's 회의록 folder was meant).
- **Left out:** a "where to save?" question or card (the owner wants none for an explicit save), a folder made per
  room, and project folders as a default (whether a group chat "is" a project is not known; the person names it).
- **Tests:** tests/unit/b-side-chat.test.ts ("a group chat saves where its people can open it").
- **Version impact:** patch.
