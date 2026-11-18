# edit_pdf replace_text (old text really removed); HYPERLINK in make_file formulas

- Date (UTC): 2026-11-18 21:40
- Branch: `feat/pdf-text-edit-xlsx-hyperlink`
- Status: done
- Where: Team AX core: `server/src/files/pdf-text.ts` (new, office worker), `server/src/files/pdf-pages.ts`,
  `server/src/tools/pdf-tools.ts`, `shared/src/tools.ts` (edit_pdf), `server/src/tools/make-file.ts` (formulas).
  Why: files and the AI's tools are core.
- Version impact: minor (the AI can change words inside a PDF and write link formulas in Excel files)
- QA: TC-4992 (PDF text), TC-4993 (HYPERLINK)

## Goal

Owner rule (11-19): "Claude Code is the floor." Claude Code edits a PDF's words with PyMuPDF (search, redact so the old
text is gone, write the new text in a matching font and size) and writes any openpyxl formula. Today edit_pdf "cannot
change the PDF's own text" and make_file refuses HYPERLINK.

## Scope

In:
- edit_pdf `replace_text { find, replace, pages?, match_case? }`: in the office worker, with pdf-lib (already bundled
  on Mac, Linux and Windows; no new install). The page's content stream is read operator by operator; the glyphs of
  every match are taken out of their text operators and the new words are written at the same spot, in the same text
  state (colour, size, position), in the original font when it has every glyph, else the closest standard font (sans,
  serif, mono; bold, italic) or the server's Pretendard for other letters. The rest of the line moves along with the new
  words; another column (a large gap, a table's rule) does not move: the new words get smaller (to 60%) or, when that
  does not fit, the AI is told. The old content streams are dropped from the file.
- Said plainly: words that are part of a picture (a scan), the hidden text layer of a scanned page, text in a drawn
  block (form XObject), vertical text, a font that does not say which letters it draws.
- make_file xlsx: HYPERLINK allowed when its first argument is a "string" that is a web page (http, https), a mail
  address (mailto:) or a place in this workbook ("#Sheet!A1"); a web or mail link may go on with & and cells. A cell
  reference or any other scheme (file:, \\host, other local schemes) is refused with one line why. Rules kept in line
  with #1315 (office-links).

Out: text inside form XObjects, annotations, bookmarks, form fields; re-wrapping a paragraph.

## Tests

- tests/unit/pdf-replace-text.test.ts: worker level; old bytes absent from every decoded stream; pdftotext sees
  the new words; TJ kerning and split runs; hidden layer refused; picture-only page; fallback font; columns.
- tests/unit/c-edit-pdf.test.ts: the tool path.
- tests/unit/c-tools.test.ts: allowed and refused HYPERLINK targets, and make_file through the tool.
