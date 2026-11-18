# The AI changes an existing Word, Excel or PowerPoint file in place (edit_office)

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (the Markdown-then-convert design of make_file stays for new files)
- Branch: feat/office-edit-in-place (limits audit 2026-11-18 item #2, QA TC-4906; plan docs/AGENTS/plan/20261118-1041-office-edit-in-place.md)

- **Ask:** "change the date in this contract", "put 120 in B7", "fix the title on slide 3". The AI could only rebuild
  the file from Markdown or CSV with make_file, and every style, picture, chart, comment and tracked change was lost.
  Claude Code does the same job with python-docx / openpyxl through a shell and keeps the rest of the file.
- **Rule:** one tool, `edit_office`, for .docx, .xlsx and .pptx. Word: find/replace inside one paragraph (the new text
  takes the formatting of the run it replaces), insert or delete paragraphs (a new one copies its neighbour's style and
  numbering), set a table cell, add or delete table rows. Excel: set a cell (keeps its style; text as an inline string,
  so the shared strings part is not rewritten), append rows after the last row (styled like the last row; a table that
  ends there grows). PowerPoint: find/replace, set a shape's text, duplicate a slide, add a slide from a layout, replace
  a picture (fitted into its frame). Changes name things as the AI read them, never the result of another change in
  the same call. Saved like edit_hwp and comment_docx: read first, a new version (old bytes in the history) or a
  conflict copy, `output` for a new file with make_file's wider-audience check (a replacement picture is a source
  too), never under `skills/`.
- **How:** our own patcher, no new library. The zip is checked first (zip-guard), each XML part is scanned linearly
  for tag offsets (ooxml.ts), and only the byte ranges of the edited elements change; every other part keeps its
  compressed bytes (zip-write.ts `raw`). It runs only in the office worker (isolated, memory and time capped). Before
  anything is placed the server checks the two zip directories (only parts of the kinds an edit may touch changed,
  nothing else added or removed), and a fresh worker reads both files: changed XML parts are well-formed (saxes), the
  paragraphs read as before except the reported ones (a diff), and for a workbook every cell of every sheet (SheetJS)
  reads as before except the written ones.
- **Rejected:** openpyxl and ExcelJS (MIT): they rebuild the workbook from their model and drop charts, images and
  parts they do not model, the loss we are fixing. python-docx / python-pptx (MIT): keep unknown XML but need Python
  on every server and reserialize whole parts. docxtemplater: fills templates, its paid modules are not AGPL-compatible.
  NOTICE needs no new entry.
- **Formulas:** after an Excel edit every formula cell's stored result is cleared and `fullCalcOnLoad` is set:
  LibreOffice does not calculate an Excel file again on open, so a total would show the old number. Excel and
  LibreOffice calculate them on open; our preview shows the formula until then. `xl/calcChain.xml` is dropped when a
  formula cell is written or overwritten, as Excel does. Formulas pass make_file's check (nothing that reaches outside
  the workbook); values are read as make_file reads them ("1,500" a number, "007" text).
- **Refused with the reason:** a match across a tab, a line break, a field or a tracked change; a paragraph or cell
  with a comment on it (deleting it would orphan the comment); vertically merged rows; a section break; a cell inside a
  merged area, an array formula or a shared formula's first cell; a table header cell; a slide with a chart, diagram,
  object or media (duplicate only); a signed file; a file with macros; a DTD, comments or processing instructions in a
  part. Rows are never inserted in the middle of a sheet (every reference below would move).
- **No new fields or outside links (QA TC-4948):** edit_office writes text only as escaped `w:t` / `a:t` content, so
  field-looking text ("DDEAUTO ...", "<w:instrText>") stays text; a new paragraph, row or cell copies only paragraph
  and run properties (`w:pPr` / `w:rPr`, without tracked-change marks), never fields, and a match inside a field is
  refused. A duplicated slide refuses when the slide uses anything from outside the file other than a plain hyperlink
  (a linked picture would be fetched again), as well as charts, objects and media. Fields and links already in the
  person's own file stay as they are: it is their file, changed in place, as `copy_files` would keep them. Templates
  for make_file are checked separately (docs/decisions/20261118-any-file-template.md).
- **Left for later:** tracked changes made by the AI, inserting sheet rows in the middle, pictures in Word, deleting or
  moving slides, older formats (.doc/.xls/.ppt, audit #9), shared chats with people (comment_docx is not there either,
  audit #22), guests.
- **Tests:** `tests/unit/c-edit-office-{docx,xlsx,pptx,tool}.test.ts` (each change, each refusal, unchanged parts
  byte for byte, read-back, LibreOffice opens the result when it is installed, the server's part check, the tool path).
- **Version impact:** minor (a new AI tool).
