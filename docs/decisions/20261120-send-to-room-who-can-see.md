# Send to conversation: ask only for what someone in the room can't open; Always allow is final

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (the button keeps the check of [Send to a conversation](20261117-send-to-room-card-two-buttons.md); it now also reads "Always allow" as [Rule A](20261116-always-allow-final-rule-a.md) says)
- Branch: fix/send-to-room-taint (the owner's screenshot, 2026-11-20: 루마네시스템, a 3-person channel linked to a
  project; QA TC-5521 to TC-5525)

Where: `server/src/chat/answer-share.ts` (the button's check and send), `server/src/chat/post-to-room.ts` (the AI's card
words), `server/src/chat/prompt.ts` (the side chat's project line), `web/src/components/chat/ShareToRoom.tsx`.

- **Ask:** in a project channel's side chat the owner pressed "대화에 보내기" and got the confirm step. The answer used
  only the channel's messages and the project folder, which all three can open. The AI said its search was not limited
  to the project folder (hits in the owner's own folder, a "leads" and a "team korea" department folder), and that
  "reading other people's words makes the app ask again even with Always allow on".
- **What made it ask (before):** `answerCheck` → `provenanceChecker.of` (answer-share.ts) counts every source the
  branch read that some room member cannot read (`missingReaders`, read-scope.ts). The grep over the whole team folder
  put the owner's own folder and two department folders in the answer's source list; bob and erin cannot read them, so
  `prepareShare` set `applies` and `sendShare` answered "confirm". This room's messages and the project folder never
  counted for members who can see them (unit test, also passing before). Who wrote a file was never part of this check.
- **Rule (unchanged):** the button asks only when the AI read something at least one current member cannot open: this
  room's messages and a folder every member reads never count, whoever wrote them; a member who joined after the
  messages read, or to whom an old answer is hidden, still counts (they were never given that history; a hidden answer
  still refuses). A guest counts by the guest's own access (a guest outside the project makes the project folder count).
- **Rule A gap, fixed:** the button never read the person's "Always allow". The AI's `post_to_room` already sent past
  this check under it. Now the button does too: with Always allow for room posts (`post_to_room`) it sends at once,
  links stay links; with Always allow for posts with their files (`post_files`) the linked files the person may share
  go as copies (`FileShares.view(...).canShare`: a teammate's file stays a link, as on the AI's card). Only the sender's
  own row counts; the team switch off, a confidential chat and an answer hidden from a member stop it as before. Audited
  `room.answer_share` with `always: true`. There is no decision that the button re-asks under Always allow; the AI's
  sentence was its own guess, not what the code did.
- **The card's words:** the line now says what happened ("While writing this answer, the AI read things from … that 2
  people here can't see") rather than "this answer includes content from", and names each place in the Files screen's
  words with how many files read there count when all are known (`AnswerSharePlace.files`, optional: "2 of my files",
  "1 file in Groups › marketing"). The AI's card (`post_to_room`) names places the same way. Never who.
- **The side chat's prompt:** a channel linked to a project now tells the AI to look in the project's folder first for
  a question about the channel's work, and to search wider only when the answer is not there or the person asks; what
  it reads outside makes the button ask. What it may search is not limited (Claude Code is the floor).
- **Tests:** `tests/unit/b-send-to-room-who-can-see.test.ts` (real turns: same room, project folder, wide search, Always
  allow), `tests/security/send-to-room-always-allow.test.ts` (another person's Always allow, team switch, confidential,
  a teammate's file never copied), `tests/unit/a-guests-answer-share.test.ts` (guest and the project folder),
  `web/test/unit/share-to-room.test.tsx` (the line's words).
- **Version impact:** patch (no new screen, setting or table; one optional API field).
