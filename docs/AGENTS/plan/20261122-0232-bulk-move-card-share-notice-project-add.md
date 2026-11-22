# Many moves in a shared folder ask once; a post shares only what it says; "added you to a project" notice

- Date (UTC): 2026-11-22 0232
- Branch: `fix/bulk-move-card-share-notice-project-add`
- Status: in progress
- Where: server file tools (`server/src/tools/file-moves.ts`), post_to_room (`server/src/chat/post-to-room.ts`,
  `server/src/chat/share-next-steps.ts`), project joins (`server/src/chat/project-joins.ts`,
  `server/src/notifications/service.ts`), shared API (`shared/src/api/notifications.ts`), web Activity text.
  Why: QA rows TC-r2u-25 (S-122, P1), TC-r2u-29 (P2), TC-r2u-03 (P2) of the claude-code scenario rerun.
- Version impact: patch. One more card in one case, one notice more for the person added, a narrower grant; no
  new setting, table or route.

## Goal

1. **TC-r2u-25.** The AI renamed and moved 15 files of the shared 마케팅 folder (18 people see it) with no card.
   Cause (code, not an Always allow left in the copy: the undo's trash card in the same run still offered 항상 허용):
   `move_files` asks only when who can see the files changes (a move inside one shared folder changes nobody's
   access), and `rename_file` / `rename_files` never ask. #305 (merged) only touched the box_shell "new files in the
   project folder" bulk card and delete_files, not moves.
   Fix: before the AI moves or renames more than a few items (more than 3 in one answer) in places other people see,
   the server asks once on one card that lists them; a yes covers the rest of that answer's moves and renames. The
   person's own "Always allow" for moves (`move_files`, Rule A) skips it. A scheduled run (nobody to ask) is refused as
   today's move card refuses.
2. **TC-r2u-29.** "○○님이 "index.html" 파일을 공유했어요" after a post of chart-green.svg; "명함.jpg" after a post of a
   quote. Cause: the notice names the file the grant really opened. post_to_room's Send attached the posted file as a
   copy (no share, so no share notice) and gave view access to the copy's *source* files (what the chat that made it
   read: the business card photo, an unrelated index.html), which the card never named ("보내면 함께 공유돼요").
   Fix: when Send carries copies, its view covers linked files that do not go as copies, not the sources; the sources
   keep the existing "N people can't see some sources" line and the "Let them view" button after the post.
3. **TC-r2u-03.** People added to a project get no notice (only the project's existing members hear "X joined").
   Fix: the person who starts to see a project because someone else changed it gets a project.joined notice of their
   own, "{by}님이 나를 '{project}' 프로젝트에 추가했어요" (same audit row; shown always, not pushed, as project.joined).

## Steps

1. file-moves.ts: a per-answer count of moved/renamed items in places other people see; past 3, one card listing
   this call's items (and how many went before in this answer); yes approves the rest of the answer.
2. post-to-room.ts / share-next-steps.ts: `fileGapsOf(..., { sources: false })` for the plan of a Send with copies.
3. project-joins.ts + notifications/service.ts + shared schema + web text (6 languages).
4. Tests: unit tests for each; typecheck, check:prepush, area tests, web unit tests.

## Risks

- One more card: only past 3 items in a shared place, once per answer, never with Always allow.
- A source no longer opened by Send: the person still sees the provenance line and the button after the post.

## Tests

- `tests/unit/file-moves-bulk-card.test.ts` (new), `tests/unit/c-who-can-open.test.ts`, project join notice test.

## Result

(filled at the end)
