# A saved Word file says what it really holds (tracked changes and comments)

- Date (UTC): 2026-11-24 14:08
- Branch: `fix/docx-comments-written`
- Status: done
- Where: server/src/files, server/src/chat/places-copy.ts. Why: the save path of the work folder is core (docs/REPOSITORY-RULES.md)
- Version impact: patch: a save result says more; no new tool, setting or API

## Goal

QA A-43-L (2026-11-24, qa.trina.app): asked to proofread a .docx with tracked changes and margin comments, the AI built
the file in the work folder with the docx skill and saved it with save_work_file. The work-folder file has 8 tracked
insertions and 9 deletions but no comments part and no comment marks; the answer said "I checked that all four are saved
in the file". Nothing on the save path drops comments (the exit check only takes out an attached template; comment.py
from the skill writes all six parts when run), so the file was built without them, and the save result gave the AI no
fact to check its claim against: it says only "Saved X as Y (0.04 MB)".

## Scope

In: every route that takes a Word file out of the work folder (save_work_file, copy_files from chat:work/, a new
version of a chat file) reads the file back in the office worker and the result says what it holds: tracked insertions,
deletions and moves in the body, comments, and the comment faults Word does not show or calls damage (a comments part
nothing links to or with no content type, comments with no mark in the text, marks that name no comment).
Out: refusing such a file (the person may still want it); PowerPoint and Excel (no comments or tracked changes path
there); the AI's own build script.

## Steps

1. files/docx-review.ts: `docxReview(bytes)` (counts and faults, read with ooxml.ts tags), worker mode `docx-review`.
2. chat/places-copy.ts officeOut: for a .docx, run the mode and add one read-back line to the result.
3. Tests: a docx with tracked changes plus comments added by comment_docx's writer reads back with the right counts; a
   comments part without marks, without a relationship, and marks without a comment are named; save_work_file's result
   carries the line.

## Decisions

docs/decisions/20261124-docx-save-read-back.md.

## Risks

One more office-worker run per saved Word file (small: one linear pass over document.xml and comments.xml). No
migration, no UI, no i18n (the line is for the AI).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/docx-review.test.ts, tests/unit/places-copy.test.ts,
tests/unit/c-comment-docx.test.ts.

## Result

Built as planned: files/docx-review.ts (mode `docx-review`), officeOut in chat/places-copy.ts adds the line for
every Word file leaving the work folder, decision docs/decisions/20261124-docx-save-read-back.md. On the QA files the
line reads "8 tracked insertions, 9 tracked deletions; no comments" for Trina's and "10 tracked insertions, 11 tracked
deletions; 4 comments (all shown in the margin)" for Claude Code's; a comment.py comment without its marks is named as
not shown. A file with a fault is saved and the fault named, not refused.
