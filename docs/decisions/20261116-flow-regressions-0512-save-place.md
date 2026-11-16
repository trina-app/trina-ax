# Room content is saved where the room's people can open it, also from a group chat or a 1:1

- Date: 2026-11-16
- Status: accepted
- Supersedes: the group chat and 1:1 part of "Where the side chat saves room content" in
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
  - a group chat or a 1:1: the team folder that every team member of the room can read, with the fewest people outside
    the room who can (a group's folder or a team project's folder, else shared/); on a tie, the one more of the room's
    guests can read. The person must be able to write there. With nobody outside the room able to open it, the save
    needs no wider-audience card (#1094's explicit save then adds no card either);
  - a 1:1 that only shared/ fits stays in the person's own folder: a private talk is not for the whole company by
    default. A group chat that only shared/ fits goes to shared/, and the wider-audience card asks as before.
- **Left out:** a "where to save?" question or card (the owner wants none for an explicit save), and a folder made per
  room.
- **Tests:** tests/unit/b-side-chat.test.ts ("a group chat or a 1:1 saves where its people can open it").
- **Version impact:** patch.
