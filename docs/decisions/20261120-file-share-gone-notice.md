# A shared file that no longer opens: who, why, and no dead rows in Activity

- Date: 2026-11-20
- Status: accepted
- Supersedes: part of [A member shares their own files](../DECISIONS.md#a-member-shares-their-own-files--내-파일을-고른-사람과-공유-featfile-share-links-2026-11-15-the-owner-qa-tc-3093)
  (only the bare "no longer available" line of a `file.shared` notice)
- Branch: fix/file-share-gone-notice (the owner, QA TC-5664)

- **Ask:** The owner saw a 활동 row from 트리나 that only said "공유받은 파일을 더 이상 열 수 없어요." and asked when it
  shows up. It named no one and no file, opened nothing and gave no reason, so it looked broken.
- **When `gone` is set:** a `file.shared` notice is built when it is read (`files/shares.ts noticeOut`). It is `gone`
  when the file (or folder) no longer opens for its reader now (`open()` is not `open`):
  - the reader was taken off the share: the sharer removed them, stopped sharing, or removed a group they are in or
    the whole team (`file_share_stops` has the row);
  - the file is in the trash (`file_shares.state = 'trashed'`; it comes back with a restore);
  - someone else moved it where the reader cannot open it (audit `file.unshare` reason `moved_narrower`), or a folder
    share ended because its folder moved (audit `folder_share.ended`);
  - another file took its path, or it changed or went away outside the app (`state = 'dead'`, or the path no longer
    resolves);
  - the file's owner can no longer edit it (left the team, lost access), or the Admin removed links (Remove all, a
    folder's "Remove those links too");
  - a press of several files: none of them opens any more.
  When the file is deleted for good (trash emptied) or the owner's personal folder is forgotten, the share row and its
  notices are deleted, so no row is left. The time on the row is when it was shared with the reader (the notice's
  `created_at`, set again when it is shared again), not when access ended.
- **Rule:** the line names who shared it, while their account is there (the grant that still reaches the reader, else
  the share press that made the notice, from the audit log; a press of several files: its `by_user`). It adds a short
  reason only for the three the server records: `stopped` ("공유가 중지됐어요."), `deleted` ("삭제됐어요."), `moved`
  ("다른 곳으로 옮겨졌어요."). Nothing else gets a reason. Never the file's name, its link or where it went
  (`fileShare.why` in `shared/src/api/notifications.ts`). Example: "test님이 공유한 파일을 이제 열 수 없어요. 공유가
  중지됐어요."
- **The row:** muted and opens nothing. In the 활동 panel an unread one is a button that only marks it read; a read one is
  a plain row. On a phone it keeps "읽음 표시".
- **Read ones drop out:** `GET /api/notifications` leaves out a `file.shared` notice that is `gone` and read. An unread
  one stays, so a share that ends before the person looks is still said once, with who and why. Why: the person already
  saw the share (the original row), so a read dead row adds nothing; Slack and Google Drive remove or replace such
  items. The notice still answers by its id (`GET /api/notifications/:id`, what a push opens), and the counts are
  unchanged (only read rows go). The cursor is the rows', so paging is unaffected.
- **Left out:** a reason for a folder narrowed by an admin, for an owner who lost edit access, and for a file changed
  outside the app (the server records no clear reason the reader would understand); `file.unshared_by_move` and request
  notices are unchanged.
- **Tests:** `tests/unit/c-file-share-gone-notice.test.ts` (each case, the privacy rule, the list rule, the web line),
  `web/test/e2e/file-share-gone-notice.spec.ts` (1440 and 390: the line, muted, no link; SHOTS=1 saves screenshots).
- **Version impact:** API adds the optional `fileShare.why`; older apps ignore it and show the old line.
