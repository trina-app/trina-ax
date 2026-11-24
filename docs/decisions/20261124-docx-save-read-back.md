# A Word file saved from the work folder is read back for its tracked changes and comments

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (adds to the save step of [20261124-doc-skills.md](20261124-doc-skills.md))
- Branch: fix/docx-comments-written (QA A-43-L)

- **Ask:** QA A-43-L reported a proofread .docx saved without the four margin comments the answer named. It was a QA
  false positive (the team-folder file has them; QA read an earlier work-folder copy), but it showed a real gap: the save
  result of a Word file leaving the work folder ("Saved X as Y (0.04 MB)") says nothing about what the saved bytes hold,
  so an answer's claim about tracked changes or comments rests on the AI's plan. The docx skill's `comment.py` also makes
  a comment that Word does not show until its marks are placed in the text.
- **Rule:** every route that takes a Word file out of the work folder (save_work_file, copy_files from `chat:work/`, a
  new version of a chat file; chat/places-copy.ts officeOut) reads the bytes it saves in the office worker (mode
  `docx-review`, files/docx-review.ts; only the package's XML parts are kept for it) and its result says: tracked
  insertion, deletion and move marks in the body (elements in the file's XML, worded so, not Word's Review count),
  how many comments and how many Word shows in the margin (comment marks in the body, footnotes and endnotes), and each
  fault: a comments part with no relationship or no content type (Word shows none), comments with no `w:commentReference` (not shown), marks that name no comment (Word may call the file
  damaged). The line ends "Describe the file's tracked changes and comments only as this read-back says."
- **Not refused:** if the read-back itself fails the result says the file is saved and its contents could not be read
  back this time. A file with such a fault is still saved (the person may want it as it is); the result names the
  fault so the AI fixes the file or says so.
- **Not changed:** comment_docx and edit_office already read their own output back; read shows comments and tracked
  changes (files/ooxml.ts docxExtraText). PowerPoint and Excel files get no such line (no comments or tracked-change
  path for them here).
- **Tests:** tests/unit/docx-review.test.ts (a file with tracked changes and comments written and read back; each fault),
  tests/unit/places-copy.test.ts (save_work_file and copy_files carry the line).
- **Version impact:** patch (a save result says more; no new tool, setting or API; an improvement, not a bug fix).
