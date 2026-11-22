# A room post counts who can't open a team-folder file, and room members can ask to view a linked file

- Date: 2026-11-22
- Status: accepted
- Supersedes: for team-folder files only, the "names only for files the asker may share (or an admin)" rule of
  [The send-to-room card: one line, who can't open the file, Send and Don't send](20261117-send-to-room-card-two-buttons.md):
  since the review of batch 3 (#389) a member's card counts every team-folder file, also one they may share
- Branch: wip/qa1122-s120 (QA S-120: TC-v1e-03, TC-v2f-A1; plan docs/AGENTS/plan/20261122-0818-qa-scenario-followups-1122.md)

- **Ask:** 한지우 had her AI post a PDF link from `groups/영업/` to #영업-보고. The card said only "링크된 파일 1개를 1명이
  열 수 없어요" and 최도윤 (in the room, not in 영업) got "파일을 찾을 수 없거나 볼 권한이 없어요" with no next step.
- **Why the card counted (root cause):** in the QA run the PDF was not made by 한지우's AI. It was a prepared file of
  김민지's (the AI found it with a search and the step after the post offered "김민지 님에게 요청"). A file the asker's own AI
  writes in a group folder, in this answer or an earlier one, records the asker as its maker (files/shares.ts
  creatorOf), so it is theirs to share: Send lets them view it, as before. Nothing to fix there; a test pins it
  (tests/unit/b-room-link-ask.test.ts).
- **Rule (the poster's card, changed by the review of batch 3, #389):** the card names the room members who can't open a
  linked file only for the team owner and admins, or when every file concerned is the asker's own file in their own
  personal folder. Everyone else gets a number ("N명은 못 열어요"), for a team-folder file (`shared/`, `groups/…`, a
  team project folder) too, also one the asker may share: names there told a member who in the room is outside the
  group, while files/access-routes.ts gives folder-access names only to the owner and admins and members a count. The
  first version of this decision named them for any team-folder file the asker reads by the folder's access; that is
  gone. A teammate's personal file, or a file the asker has only through a one-by-one share, keeps the count (review
  of #1235). No copy goes past the folder rule: copies still go only for files the asker may share or made in this
  answer; Always allow kinds are unchanged. After the post the step still offers "Ask <owner>" / "Ask an admin", and
  the AI's result says the people there can ask from the link themselves.
- **Rule (the viewer's ask):** a room member opening a team-file link in a message that does not open for them gets
  "이 파일을 볼 권한이 없어요" with who answers and [보기 요청]. `GET/POST /api/rooms/:id/messages/:messageId/file-access`
  (`path`) answer `ask` / `asked` / `open` / `no`. The ask is an ordinary file access request (file_access_requests,
  files/shares.ts request/answer): the file's owner, or with none the team owner and admins, answer with Share or
  Decline in Activity; Share is the view-only grant. It answers only for a non-guest active member who sees that message
  (history, thread, hidden answers, not deleted), a path that is a link in that message's text, a file they cannot read
  now, and a request the file rules allow; everything else is one `no` (404 on POST), so paths cannot be probed. The
  answerer is named only when it is the message's author (whom the viewer sees anyway), else "the file's owner or an
  admin". No new table or kind, no migration, no edit to the posted message.
- **Why:** the card follows one rule with the Files screen (files/access-routes.ts): who a team folder lets in is named
  to the owner and admins, counted for everyone else. The count still tells the asker that someone there can't open it,
  and the viewer's ask below gives those people a next step that is not a dead end.
- **Privacy cost:** none added: a member's card never says who is outside a group, and a teammate's personal or
  share-reached file stays counted, so no one's private sharing choice is shown.
- **Left out:** a copy for team-folder files the asker may only read; the viewer asking the poster to attach a copy
  (the first plan's "Ask to add it"; the review chose the file requests instead).
- **Tests:** tests/unit/b-room-link-ask.test.ts (card names and counts, root cause, the endpoint's ask/asked/open/no,
  guest, a path not in the message, a message the caller can't see, approve grants view; an admin's card names),
  tests/unit/b-post-to-room.test.ts (a team-folder file is counted on a member's card), web/test/unit/room-file-ask.test.tsx.
- **Version impact:** patch (the same card and panel with a line and a button added; no setting, no table).
