# A Word file saved from the work folder is read back for its tracked changes and comments

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (adds to the save step of [20261124-doc-skills.md](20261124-doc-skills.md))
- Branch: fix/docx-comments-written (QA A-43-L)

- **Ask:** "Proofread brightfield_proposal.docx; every change visible (tracked changes) plus what I need to decide."
  The answer said four margin comments were saved and "I checked that all four are saved in the file". The work-folder
  file had 8 tracked insertions and 9 deletions, and no comments part and no comment marks.
- **Root cause:** nothing on the save path drops comments: the exit check (files/office-links-check.ts) takes out only an
  attached template, and the docx skill's `comment.py` writes the comments part, its relationship and content type when
  it runs. The file was built without the comments, and the save result ("Saved X as Y (0.04 MB)") gave the AI no fact
  about what the saved bytes hold, so a claim from its plan went into the answer unchecked. The skill also has a quiet
  trap of its own: `comment.py` defines a comment that Word does not show until its marks are placed in the text.
- **Rule:** every route that takes a Word file out of the work folder (save_work_file, copy_files from `chat:work/`, a
  new version of a chat file; chat/places-copy.ts officeOut) reads the bytes it saves in the office worker (mode
  `docx-review`, files/docx-review.ts) and its result says: tracked insertions, deletions and moves in the body, how many
  comments and how many Word shows in the margin, and each fault: a comments part with no relationship or no content type
  (Word shows none), comments with no `w:commentReference` (not shown), marks that name no comment (Word may call the file
  damaged). The line ends "Describe the file's tracked changes and comments only as this read-back says."
- **Not refused:** a file with such a fault is still saved (the person may want it as it is); the result names the
  fault so the AI fixes the file or says so.
- **Not changed:** comment_docx and edit_office already read their own output back; read shows comments and tracked
  changes (files/ooxml.ts docxExtraText). PowerPoint and Excel files get no such line (no comments or tracked-change
  path for them here).
- **Tests:** tests/unit/docx-review.test.ts (a file with tracked changes and comments written and read back; each fault),
  tests/unit/places-copy.test.ts (save_work_file and copy_files carry the line).
- **Version impact:** patch (a save result says more; no new tool, setting or API).
