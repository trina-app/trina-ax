# edit_office: change an existing Word, Excel or PowerPoint file in place

- Date (UTC): 2026-11-18 10:41
- Branch: `feat/office-edit-in-place` (step 1, the template part: `feat/any-file-template`)
- Status: in progress
- Where: trina-ax `server/src/files/` (the editors, office worker only) and `server/src/tools/edit-office.ts`. Why: file
  tools for the AI are Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor, a new AI tool.
- QA: TC-4906 (limits audit 2026-11-18, item #2 "edit existing Word/Excel/PowerPoint in place, and any template").

## Goal

"Change the date in this contract", "put 120 in B7 of the budget", "fix the title on slide 3": today the AI can only
rebuild the file from Markdown or CSV with make_file (`files/service.ts` edit refuses binary files; the comment of
`tools/make-file.ts` says Office output is Markdown, then convert). Every style, picture, chart, comment and tracked
change in the person's file is lost. Claude Code does the same job with python-docx / openpyxl through Bash and keeps
the rest of the file. A template also has to be under `skills/` (`make-file.ts` `template()`), so "make it like my
last report" cannot use the person's own document.

After this: one tool, `edit_office`, changes a .docx, .xlsx or .pptx in place. Everything outside the edited parts
stays as it was, byte for byte where the zip allows. And make_file takes any .docx / .pptx / .hwpx the person can read
as its template.

## Scope

In (step 1, small PR): make_file's `template` may be any team file the person can read, not only one under `skills/`.

In (step 2): `edit_office` with these changes, all found in the file as the AI read it (never in each other's results):

- **docx**
  - `{ find, replace, occurrence?, all? }`: exact text inside one paragraph. The new text goes into the first run the
    match touches and keeps that run's `w:rPr` (bold, font, size, colour); the rest of the match is cut out of the
    runs after it. Runs and paragraphs the match does not touch are not rewritten.
  - `{ insert_paragraph: { after | before, text, occurrence? } }`: a new paragraph next to the one holding the text,
    with that paragraph's `w:pPr` (style, numbering, spacing) and its first run's `w:rPr`. Lines become paragraphs.
  - `{ delete_paragraph: { text, occurrence? } }`: removes the paragraph (refused when it holds a table, a section break
    `w:sectPr`, a bookmark start whose end is elsewhere, or a comment range that starts or ends outside it).
  - `{ table_cell: { table, row, column, value } }` (1-based, as read shows the tables): the cell's text, keeping the
    cell's first paragraph's `w:pPr` and first run's `w:rPr`; a cell with a nested table is refused.
  - `{ add_rows: { table, after_row, rows } }`: copies of row `after_row` (borders, widths, shading, run style) with new
    text; `{ delete_rows: { table, rows } }`. Refused across vertically merged cells (`w:vMerge`) that the change would
    split.
  - Kept: comments (`word/comments.xml` and the ranges), tracked changes (`w:ins`, `w:del`, `w:*PrChange`), headers,
    footers, footnotes, pictures, fields, content controls, every other part. A match that falls inside or across a
    tracked change, a field code (`w:instrText`, `w:fldChar`) or a content control's boundary is refused with the
    reason, not "fixed".
- **xlsx**
  - `{ cell: { sheet, ref, value } }` or `{ cell: { sheet, ref, formula } }`: a number, text, boolean or empty, or a
    formula. The cell keeps its `s` (style: number format, font, fill, border). Text is written as an inline string
    (`t="inlineStr"`), so `xl/sharedStrings.xml` is not rewritten (Excel and LibreOffice read both and turn it into a
    shared string on their next save). A formula is written without a cached value, `xl/workbook.xml` gets
    `fullCalcOnLoad="1"`, and `xl/calcChain.xml` is dropped (with its relationship and content type), as Excel does
    when it rebuilds the chain; this is the one part that changes outside the edited sheet. Formulas that reach
    outside the workbook (external refs, DDE, HYPERLINK, WEBSERVICE, INDIRECT, ...) are refused with make_file's
    check (`tools/make-file.ts` `cellValue`).
  - `{ append_rows: { sheet, rows } }`: rows after the last used row, each cell styled like the cell above it. Rows
    are not inserted in the middle in this version: that shifts every reference below (formulas in all sheets,
    merged cells, named ranges, charts, conditional formats, data validations, tables) and a missed one is a silent
    wrong number. The AI is told to append or to set cells.
  - A cell in a shared formula's range, an array formula, a table's header row, or a merged area that is not its top
    left cell is refused with the reason. A sheet's `<dimension>` grows to cover new cells.
  - Kept: styles, charts, pivot tables, named ranges, other sheets, images, comments, data validation, conditional
    formats, freeze panes, column widths.
- **pptx**
  - `{ slide, find, replace, occurrence?, all? }`: exact text inside one paragraph of one shape on the slide (title,
    body, table cell, grouped shape), the new text in the first matched run's `a:rPr`.
  - `{ slide, shape, text }`: the whole text of one shape, by its name (as `pptx-extra` lists it) or its placeholder
    (`title`, `body`, `subTitle`); each line becomes a paragraph with the first paragraph's `a:pPr` and first run's
    `a:rPr`. A shape with no text body is refused.
  - `{ duplicate_slide: { slide, after? } }`: a copy of the slide part and its relationships (same layout, same media
    parts, no notes copy), a new `p:sldId` in `ppt/presentation.xml`, its relationship and content type.
  - `{ add_slide: { layout, after? } }`: a new slide from a layout by name (as read lists them), with the layout's
    title and body placeholders, empty; text is then set with `{ slide, shape, text }` in the same call (later
    changes may name the new slide by its number).
  - `{ replace_picture: { slide, picture, image } }`: the picture (by name or 1-based order on the slide) shows a team
    image (png/jpeg/gif) the person can read; its frame (`a:xfrm`) stays, so it takes the old picture's place and
    size. A media part used by another slide is not changed: the slide gets a new media part. The image is a source
    of the result (the wider-audience check).
  - Kept: masters, layouts, themes, notes, animations, transitions, charts, every other slide.

Out (later, written in the decision): tracked changes made by the AI (Word's suggested edits), inserting sheet rows in
the middle, new charts in an existing workbook, moving or deleting slides, pictures in docx, .doc / .xls / .ppt / .odt
(no LibreOffice on servers, audit #9), and macro-enabled files (.docm, .xlsm, .pptm: not accepted).

## How (the edit_hwp / comment_docx pattern)

- **Libraries: none new.** The editors are our own TypeScript over the zip and XML that `docx-comment.ts` and
  `hwpx-edit.ts` already use: `zip-guard.ts` (`checkZip` before anything expands, entry count, total and ratio caps),
  `zip-write.ts` (`readZip` / `writeZip` with `raw`: every part that is not changed is copied with its compressed bytes
  as they were) and `ooxml.ts` `tags` (a linear tag scanner with offsets, so only the edited byte ranges of a part
  change). Checked and rejected:
  - openpyxl (MIT) and ExcelJS (MIT, already a dependency): both rebuild the whole workbook from their model and drop
    what they do not model (charts and images in openpyxl, pivot caches, slicers, unknown extensions). That is the
    formatting loss we are fixing. SheetJS community (Apache-2.0) does not write styles.
  - python-docx / python-pptx (MIT): keep unknown XML, but need Python in the converter sandbox on every server
    (only the dev environment has python3-docx, `scripts/system/packages.json` group devenv), and a second runtime
    for one tool. Our patcher changes less than they do (they reserialize every part they load).
  - docx4js, officegen, pptxgenjs, docxtemplater (MIT / dual-licensed; docxtemplater's paid modules are not
    AGPL-compatible): template fillers or writers, not in-place editors.
  So NOTICE gets no new entry. If a library is ever added, it must be MIT / BSD / Apache-2.0 / ISC / LGPL and get a
  NOTICE line in the same PR.
- **Where it runs:** only in the office worker (`files/office-worker.ts`, new write modes `docx-edit`, `xlsx-edit`,
  `pptx-edit`), started through the converter isolation (sandbox-exec / bwrap, the converter cgroup's memory cap, a
  watchdog, a time limit, an output cap). The server process never parses the document. Limits as comment_docx: 64 MB
  file, `ZIP_TOTAL_MAX` expanded, 2,000 parts, one XML part at most 64 MB, at most 100 changes per call.
- **Refused before any change:** an encrypted or signed package (`_xmlsignatures/`, a changed file would break the
  signature), a DTD, `<!ENTITY`, a non-UTF-8 part, a strict-OOXML namespace we do not read, a file that is not the
  format its name says.
- **Saving, as edit_hwp and comment_docx:** the file must be the version the AI read in this turn (`readHashes`),
  write access checked before the worker runs and again when it is placed (`placeProduced`): without `output` a new
  version of the same file (the old bytes go to its history, `file_versions`); a conflict copy when someone saved it
  in the meantime; with `output` a new file, the document (and a replacement picture) its sources: make_file's
  wider-audience question (`confirmSources`). Not under `skills/` (as comment_docx). In shared chats and rooms it is
  offered where comment_docx is (`team-content-tools.ts`, `rooms/ai-tools.ts`), same path checks.
- **Read back before anything is placed**, not on the worker's word: (1) the same zip parts in the same order with the
  same compressed bytes, except the parts the change list may touch (by change kind); (2) the text as the normal
  reader reads both files (`sheetText` for xlsx, `docxParagraphs` plus pandoc for docx, `pptx-extra` plus pandoc for
  pptx): every paragraph / cell / shape not named by a change reads as before, and each changed one reads as asked;
  (3) every XML part that changed parses as well-formed XML in a fresh worker run (mode `office-verify`).
- **The AI's view:** the tool result lists each change with where it went ("slide 3, Title 1: "Q3 plan" -> "Q4
  plan""), and says the file's layout in Word / Excel / PowerPoint was not checked. The instructions say: use
  edit_office to change an existing Office file, make_file only for a new one or when the person asks to rebuild it.

## Steps

1. Step 1 PR (`feat/any-file-template`): make_file `template` = any readable team file of the output's format; still
   a source for the wider-audience check; the size limit stays; tool and schema text, guest rewrite, tests.
2. This plan, then `files/docx-edit.ts` + `tools/edit-office.ts` (docx), worker mode, registration, tool lists,
   step label (six languages), tests on real-looking files (a contract with styles, a comment, a tracked change,
   a table; made by Word-like XML in the test, and the files LibreOffice saves).
3. `files/xlsx-edit.ts` (a budget with styles, a chart, a named range, two sheets, shared strings, a calc chain).
4. `files/pptx-edit.ts` (a deck with a master, layouts, a picture, notes).
5. Decision file, `changes/office-edit-in-place.md`, docs (`docs/for-teams*.md` line on editing Office files).
6. Real-AI check on a copy of the QA team: change one cell, one paragraph and one slide title; open the results with
   LibreOffice (`soffice --headless --convert-to pdf`) and in the web preview.

## Decisions

- `docs/decisions/20261118-any-file-template.md` (step 1).
- `docs/decisions/20261118-office-edit-in-place.md` (step 2: own patcher, no library; what is refused; append-only
  rows).

## Risks

- A crafted file: the worker isolation and zip-guard bound it; the patcher only splices byte ranges found by the tag
  scanner and refuses what it does not recognise around an edit.
- A file Word / Excel "repairs" on open: the tests open every result with LibreOffice when it is installed and parse
  every changed part; Excel-only checks (calcChain, inline strings) follow what Excel itself writes.
- No migration. Tool lists in `c-tools`, `i-wiring`, `b-browser` change. Step labels in six languages.

## Tests

`bun run typecheck`, `bun run check:prepush` (Bun 1.3.12), new `tests/unit/c-edit-office-{docx,xlsx,pptx}.test.ts`
(each change kind, each refusal, unchanged parts byte-identical, read-back, LibreOffice conversion when `soffice` is
there), the template test in `c-tools.test.ts` changed to a file outside `skills/`.

## Result

(filled in at the end)
