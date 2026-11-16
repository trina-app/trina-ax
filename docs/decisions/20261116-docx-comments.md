# Word comments on an existing .docx

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/docx-comments (AI flow check FL-21 step 3, QA TC-3818)

- **Ask:** "계약서 워드에 제3조 옆에 '정산일 재확인 필요' 메모(댓글) 달아줘". The AI said it could not add a Word comment,
  left the file unchanged and offered a copy with the note as body text. No tool changed an existing .docx; make_file
  only writes a new document from Markdown (losing the original's formatting).
- **Reading (already there):** read gives a .docx's comments with their author, date and the text they are on, in a
  labelled section after the body (files/ooxml.ts docxExtraText, since QA R2-FMT-04). No change.
- **Rule:** a new tool `comment_docx` adds 1 to 20 comments, each next to the paragraph that holds the given exact text
  (`occurrence` when the text is in several), as Word's Review > New Comment makes them: a `<w:comment>` in
  word/comments.xml (the part, its content type and the document's relationship made when missing), the paragraph
  wrapped in `commentRangeStart` / `commentRangeEnd` with a `commentReference` run; the author is the person. It runs
  in the office worker (files/docx-comment.ts, mode `docx-comment`); every other zip entry is copied with its compressed
  bytes as it was, every paragraph's text must read the same afterwards, and the comments must read back through the
  normal reader before anything is placed.
- **Not changed here:** text inside a text box (a comment goes next to body text), the older copy of new content
  (mc:Fallback), and a document that keeps its comments in a part with another name: refused with words.
- **Saving:** as edit_hwp saves, and like it the wider-audience card is asked before the worker runs, in place too (a
  comment can carry text of a private file the chat read): the file must be the version the AI read in this turn; without `output` a new version
  of the same file (the old one in its history; a conflict copy if someone saved it meanwhile); with `output` a new
  file with the document as its source (the wider-audience card). Never under skills/ (no skill-save card covers it).
- **Not yet:** tracked changes (suggested insertions and deletions, `w:ins` / `w:del` with author and date): writing them
  is a larger change (run splitting inside formatted text); the description tells the AI to say so and offer a comment.
  Reading them: pandoc's default accepts them silently, so the AI sees the text as if every suggestion were accepted
  and does not know there are pending changes; a "tracked changes" section in docxExtraText would fix that (small).
  It is a team-file tool in a person's own chat (ROOM_FILE_TOOLS: no "outside content" mark). Shared chats, guests,
  scheduled runs and the confidential chat do not list it yet (allowlists: it fails closed); adding it there needs its
  write target in WRITE_TARGET_ARGS (a follow-up).
- **Version impact:** minor (a new tool).
