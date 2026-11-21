# Chat files: audience-true wording after an AI save, and a Word preview that fits the panel

- Date (UTC): 2026-11-21 16:30
- Branch: `fix/chat-file-wording-docx-fit`
- Status: done
- Where: server/src (chat transcript, place output texts), web/src (Word preview). Why: two QA findings on batch #254
- Version impact: patch, two small fixes with no new feature

## Goal

1. QA TC-6778: in a chat that was shared and then made private again, the AI said a changed chat file was attached
   "for everyone in the chat" while the chat shows "Only you can see this chat". The words the AI is given (the
   transcript's attachment note, the result after a new chat-file version or an attached file) said "everyone in
   this chat" whatever the chat's audience. They now follow the chat's audience now: a chat shared with people (or a
   project chat) says everyone in the chat; a chat only the person sees says nothing about everyone.
2. A Word (.docx) preview in the side panel (chat files, S2) is cut off on the right at 1440 and 390: docx-preview draws
   the page at its paper width. The page now scales down to the panel's width (never up), as it fits in the wider file
   viewer column.

## Scope

In: `answerWithFiles` / `sharedCopiesNote` / `labelledTranscript` (chat/shared.ts) take the audience; `versionText` and
`chatLinksInText` (files/place-output.ts) too; the edit_office description stops promising "everyone". `DocxView` gets
the panel width and zooms the pages to fit.
Out: no UI string changes (these are AI-facing words, English only, so no locale files). No change to who can open what.

## Steps

1. Tests: transcript and version texts in a private chat say no "everyone"; in a shared chat they still do. Web: the
   fit factor for a page wider and narrower than the panel.
2. Server: an `everyone` flag from the turn (`exec.shared`, chatKind `people`) down to the texts.
3. Web: `docxFitZoom(width, page)` in lib; DocxView measures the page once after render and sets CSS zoom on the
   wrapper; re-applied when the width changes.
4. Visual check on a private QA copy at 1440 and 390.

## Decisions

none

## Risks

CSS `zoom` (Chromium, Safari, Firefox 126+). Electron is Chromium. On an older Firefox the page stays as before
(scrolls). No migration, no permissions change.

## Tests

`bun run typecheck`, `bun run check:prepush`, the area unit tests (chat shared, places versions), web unit tests.

## Result

As planned. The transcript note, the result after an AI chat-file version and the attached-file line say "everyone in
this chat" only in a chat shared with people (or a project chat, for the attached-file line and the transcript); the
edit_office description names no audience. The Word preview zooms to the width it is shown in (side panel, file
viewer), measured once per render, re-applied on resize, never above 1. Checked on a private QA copy at 1440 and 390
(the side panel: a team .docx and a chat attachment; the page fits, no sideways scroll). PR: (linked in the PR).
