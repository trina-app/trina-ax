# An answer sent to a room carries the video (or page) the answer made

- Date (UTC): 2026-11-22 02:04
- Branch: `fix/room-post-attachment`
- Status: in progress
- Where: server/src/chat (answer-share, post-to-room), server/src/rooms/files.ts, web room page and send-to dialog.
  Why: scenario QA TC-r2b-03 (P1) and TC-r2b-06 (P2).
- Version impact: patch: a fix of what "대화에 보내기" and post_to_room send; no new feature, no migration.

## Goal

TC-r2b-03 (S-025): 이서연 had Trina make a promo video, then sent the answer to 전체 with "대화에 보내기". The toast
said "전체에 보냈어요", but the room got only the AI's text: the video is an artifact (beside the chat, no file), and
the send attaches only team files the answer links to. 박준호 had nothing to play.

TC-r2b-06 (S-023): a side-chat answer sent to its room said "이 파일은 지금 저만 열 수 있습니다", while the file went
with the message and every member could open it. And at 1440 with the side chat and a preview open, the room column
shrank to one character.

## Scope

In:
1. The artifacts an answer made (the version that answer made, per key) go with the room message as files, on the
   button and on post_to_room (which also takes `artifacts`: keys of artifacts on the answer's branch, for "post the
   video I made earlier"). A promo video goes as its MP4 when one is rendered, else as its HTML page, which plays in
   the room's file viewer. Never for own_words (a dictated message carries nothing the chat made).
2. Attaching fails (storage, the room, the file): nothing is posted, and the error says the file could not be attached;
   post_to_room's result says nothing was posted and why. Never "sent" without the file.
3. The confirm step (button) and the post_to_room card name the files that go with it.
4. A sentence of the AI's text that says who can open something ("저만 열 수 있습니다", "only you can open it") is left out
   of the room's copy: in the room it is not true, and the room shows per link who can open it.
5. Room page: with a single side column open and a row too narrow for the room's 420 px beside it (a file preview
   beside the page), the column is a sheet over the room, as in a narrow window.

Out: rendering an MP4 on servers without the renderer; activity-feed items for plain room messages (a room message
notifies by the room's own rules: unread count, push per the room's setting; unchanged).

## Steps

1. shared: `artifactFileName` moves to shared/src/api/artifacts.ts (web re-exports it); PostToRoomInput `artifacts`;
   ShareAnswerToRoomResult confirm `artifacts` (names).
2. server: answer-share `answerArtifacts` + PreparedShare/Check carry them (in the confirm key); sendShare attaches them
   (RoomFiles.fromBytes / fromLocalFile) and fails whole on an error; `dropWhoCanOpen` on the room's copy.
3. post-to-room: pass keys, card row, refusal text for reason `artifact_attach`.
4. web: ShareConfirm lists the artifacts; Room.tsx sheet when the row is too narrow.
5. Tests: server unit (answer-share artifacts, refusal, sentence filter), web unit (roomColumns helper).

## Decisions

none (follows docs/DECISIONS.md "post_to_room" and the "대화방에 보내기" rules: what the answer made goes with it, as
files the AI made in the answer already do).

## Risks

Provenance: an artifact is content of an answer on the branch, whose reads the check counts already; artifacts off the
branch or of another person's turn are never taken. Room storage: the room's limits apply (create()). Five languages for
the new strings.

## Tests

`bun run typecheck`, `bun run check:prepush`, the area's unit tests (tests/unit for answer-share, post-to-room, rooms
files), web unit tests. Real check on a private QA copy (video in a chat → post to a room → another member at 1440/390).

## Result

(filled in at the end)
