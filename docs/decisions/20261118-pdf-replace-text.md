# edit_pdf changes words inside a PDF, and the old words are really gone

- Date: 2026-11-18
- Status: accepted
- Supersedes: "Not added: changing a PDF's own text" in `20261116-edit-pdf.md` (for text; pictures stay out)
- Branch: feat/pdf-text-edit-xlsx-hyperlink (owner rule 2026-11-19 "Claude Code is the floor", QA TC-4992)

Plan: docs/AGENTS/plan/20261118-2140-pdf-replace-text-xlsx-hyperlink.md.

- **Ask:** edit_pdf "cannot change the PDF's own text". Claude Code does it with a PyMuPDF script: `page.search_for`,
  `add_redact_annot` + `apply_redactions` (the old text is removed from the page's content, not covered), then
  `insert_text` / `insert_htmlbox` in a matching font and size. Do the same so the old words are gone.
- **Rule:** a new edit_pdf operation `replace_text { find, replace, pages?, match_case? }`. Every match on the pages
  (default all) becomes `replace` ("" removes the words). In the office worker (files/pdf-text.ts), with pdf-lib, which
  is bundled on Mac, Linux and Windows already: no PyMuPDF, no new install, nothing new in `scripts/system/packages.json`.
  - The page's content is read operator by operator with the text state and each font's widths and letter map
    (ToUnicode, else its encoding and glyph names; Identity-H and the predefined Unicode CMaps such as UniKS-UCS2-H).
    A space in `find` matches a space, a gap or a line break between words.
  - The matched glyphs are taken out of their text operators, so their codes are nowhere in the page's content. The page
    gets one new content stream; the old streams, now unreachable, are deleted before the file is written (a save is a
    full rewrite, so neither they nor older revisions of the file stay in it). Tests decode every stream of the result.
  - The new words are written at the first old glyph, inside the same text object: same colour, size, position, turn.
    In the PDF's own font when it holds a glyph for every new letter (an embedded subset holds only the letters it lists
    or draws); else the closest standard font (sans, serif, mono; bold, italic), with its widths written so every viewer
    places the words after it the same; else (letters outside WinAnsi) the server's Pretendard, as add_text does.
  - The rest of the line follows the new words: the rest of their run, and the runs after it on the line that belong to
    the same text (each starts within about a letter's height of the one before). A larger gap or an upright rule the
    line crosses (a table's column line) is another column and does not move; when the line would reach it or the page's
    edge, the new words get smaller (to 60%), or, if even that does not fit, keep their size and the AI is told to look
    and offer shorter words. A paragraph is not re-wrapped; a line that grows into the right margin is reported too.
  - Said plainly, nothing saved when nothing changed: a page that is a picture (a scan: "words that are part of a picture
    cannot be removed or changed here"); the hidden text layer of a scanned page (render mode 3: changing it would not
    change what the page shows, so it is left as it is); a font that does not say which letters it draws; text inside a
    drawn block (a form XObject); vertical text. The result tells the AI which fonts were used and what moved.
- **Kept:** every edit_pdf limit and card: new file next to the original (or `replace: true` after a read), the
  wider-audience check, locked PDFs refused, the 40 MB input cap, signed PDFs flagged, the worker isolation.
- **Not added:** text inside form XObjects, annotations, bookmarks and form fields; re-wrapping a paragraph; /ActualText
  of a marked-content span around the words (rare; a viewer's copy may show it).
- **Tests:** tests/unit/pdf-replace-text.test.ts (worker: old bytes gone from every decoded stream, kerned and split
  runs, ' and escaped strings, colour kept, runs after the words moved, a table column not moved, subset font with and
  without the letters, Identity-H, UniKS-UCS2-H, scan, hidden layer, unreadable and vertical fonts, with add_text and
  remove_pages); tests/unit/c-edit-pdf.test.ts (tool path, original unchanged, scan refused).
- **Version impact:** minor.
