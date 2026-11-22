# Scenario rerun small fixes: ranges with "~", video and deck downloads for shared chats, folder and shared-chat labels

- Date (UTC): 2026-11-22
- Branch: `fix/r2a-tilde-download-labels`
- Status: done
- Where: web (Markdown, chat faces label, room file places, answer tiles, sign-in language, i18n), shared (folder
  labels, promo/deck API summaries), server (prompt line, promo video and intro deck access).
- Why: QA scenario reruns r2a (TC-r2a-02, -05, -06, -10) and E (small items from the coordinator).
- Version impact: patch. Fixes and wording; a shared chat's people may now download its promo video and deck (they
  could already see them). No migration, no new setting.

## Goal and findings

1. TC-r2a-02: "3~12초 … 1~2개" in an answer was struck through. Answers, files, artifacts and rich copy use
   `remark-gfm` with its default `singleTilde: true`; people's messages already had `singleTilde: false`. One renderer
   (`web/src/components/Markdown.tsx`) serves chat answers, rooms, file preview, artifacts and the desktop app (it loads
   the web app); the mobile app has no Markdown. Fix: strike needs `~~`.
2. TC-r2a-06: the video card's panel (ArtifactPanel, a promo video) had no download for someone a chat is shared with:
   GET/POST `/api/promo-videos/:id` answered 404 to anyone but the chat's owner, so the MP4 button stayed hidden. The
   intro deck's PowerPoint/PDF had the same owner-only rule. Team and chat files already had Download wherever the person
   can open them (FilePanel `canDownload = !noAccess`). Fix: whoever may open the chat (chatFor 'view') gets the info
   and the files, when they may also open every picture the video or deck shows (the files are made with the owner's
   permissions). Where the server cannot make an MP4 at all (not a dev Mac) there is still no button (the existing rule:
   never a button that cannot work). PR #320 changes FileBody's MediaView (team/chat files), not ArtifactPanel or these
   routes: no overlap, so this branch is off dev.
3. TC-r2a-05 (English label part): "김민지's folder" came from the shared-chat prompt line `sharedOwnFolderLine`, which
   told the AI to say "<name>'s folder". Fix: a label per language (`PERSON_FOLDER_LABEL`, English first: "{name}'s
   folder", ko "{name} 님 폴더", …), given to the AI word for word. (Not in en.ts: the words are the AI's, so they live
   with the other folder labels in `shared/src/folder-labels.ts`.)
4. TC-r2a-10: the faces on a shared chat's row are the other people who wrote in it, most recent first, by decision
   ("Faces in every chat list"). That stays. Its label and tooltip read "공유 채팅 · 김민지", which looks like the owner.
   Fix: the label starts with who started it ("내가 시작함" / "한지우님이 시작함"), then "참여: …"; the writers alone
   are left out when the only one is the starter.
5. Rerun E: ko/id `projects.guestsOff` had "{n}" inside a plural form, which the formatter cannot read, so the raw
   template showed; now "#". A unit test reads every plural of every language.
6. Rerun E: a chat attachments folder made in the team's language ("Chat attachments") showed in English in a Korean
   room: it is shown in the viewer's language wherever a place is shown (folder words, room chips and lines).
7. Rerun E: one file attached to an answer several times showed as identical tiles: one tile per file.
8. Rerun E: a removed member's sign-in page now follows the browser's language (as a guest's screen already did).

## Steps

1. Plan (this commit). 2. Code and tests. 3. typecheck, check:prepush, area tests, web unit tests (Bun 1.3.12).
4. Visual check on a private QA copy at 1440 and 390. 5. Independent review. 6. One PR into dev, not queued.
