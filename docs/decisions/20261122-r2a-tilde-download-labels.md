# A shared chat's row says who started it; its people may download its video and deck

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (amends the label of [Faces in every chat list](../DECISIONS.md#faces-in-every-chat-list-featshared-chats-p2-2026-11-14-tc-1406))
- Branch: fix/r2a-tilde-download-labels (QA TC-r2a-06, TC-r2a-10)

- **Ask:** QA scenario rerun r2a: the row's "공유 채팅 · 김민지" reads as the owner though it is the last writer
  (TC-r2a-10); a person a chat is shared with plays its video but cannot download it (TC-r2a-06).
- **Rule (row):** the faces stay the other writers. The row's accessible name and tooltip start with who started the
  chat ("Started by you" / "Started by {name}"), then "Wrote here: {names}" (ko "내가 시작함 · 참여: …"); only the
  starter when they are the only other writer. Keys `chat.share.startedBy`, `startedByMe`, `wroteHere`.
- **Rule (downloads):** a promo video's MP4 and an intro deck's PowerPoint/PDF go to whoever may open the chat
  (`chatFor` 'view'), not only its owner, when that person may also open every picture the video or deck shows: the
  files are made with the owner's permissions, and the person's own player shows only the pictures they may open.
  Otherwise 404, as before. The AI's `save_promo_video` follows the same rule.
- **Why:** being able to open a thing means being able to keep it (Drive's rule); the picture check keeps a download
  from carrying a picture the person could not open.
- Left out: an MP4 on servers that cannot make one (Linux team servers, hosted): still no button.
- Tests: `tests/unit/b-promo-video.test.ts`, `tests/unit/b-intro-deck.test.ts`, `web/test/unit/project-chat-faces.test.tsx`.
  Version impact: patch.
