# Word and Excel files with formatting, and chart pictures

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: feat/rich-office-output (second limits audit N3 and N4; QA TC-4915, TC-4916)

Plan: docs/AGENTS/plan/20261118-0900-rich-office-output.md.

- **Ask:** in the second limits audit the AI said "I can't set text colours in a Word file here", "Word files I make here
  can't have a custom header or footer", "I can't add conditional formatting" and "I can't create PNG images" (a Gantt
  chart came out as SVG, a Word report had no chart). Claude Code does these with python-docx, openpyxl and matplotlib.
- **Rule, Word (make_file format "docx"):**
  - Text colour and highlight in the Markdown itself: a span `[text]{color=red highlight=yellow}`, a block
    `::: {color="#C00000"}` ... `:::`, or the class `.mark` (yellow). Colours are names (red, darkred, orange, yellow,
    green, blue, purple, gray, ...) or `#RRGGBB`; anything else is refused and nothing is saved. Each colour pair
    becomes one Word style named after it ("Color FF0000 Highlight FFFF00"; a block's is "Paragraph ..."), so bold and
    links inside keep their own formatting. The highlight is cell shading (`w:shd`), not `w:highlight`: LibreOffice
    ignores `w:highlight` in a style, and shading takes any colour.
  - `page`: `size` (a4 default, letter, a3, legal), `orientation`, `margins_cm` (one number or per side, default
    2.54), `header` and `footer` (a centred string or `{ left, center, right }` on tab stops at the middle and the right
    margin; `{page}` and `{pages}` become PAGE and NUMPAGES fields), `page_numbers: true` (a number in the footer unless
    it already has `{page}`). Written into the last section (`w:pgSz`, `w:pgMar`, header and footer references, in
    ECMA-376 order) and two new parts with their relationships and content types. A template's own header or footer
    stays unless one is given here.
- **Rule, Excel (format "xlsx"):** `sheets: [{ sheet?, number_formats, column_widths, freeze, filter, conditional }]`
  through exceljs. Conditional `when`: greater_than, less_than, greater_or_equal, less_or_equal, equal, not_equal,
  between, contains, duplicates, top, bottom, above_average, below_average, formula, color_scale, data_bar. The default
  look is Excel's own "light red fill with dark red text". A rule formula passes the same check as a cell formula (only
  cells of this workbook; INDIRECT, HYPERLINK and the rest refused). A sheet that is not there, a range that is not one,
  a missing value: refused before the file is written.
- **Rule, pictures:** format "png" takes an SVG (`content`, or an .svg `source`) and saves a PNG at twice the SVG's size
  (longest side at most 4,000 px). An .svg picture in a docx or pptx goes in as such a PNG, so a report can hold a chart
  the AI drew. The AI draws the chart (SVG); there is no chart spec.
- **Why typst draws it:** every install that makes PDFs already has typst (the Linux bundle's `bin/`, Homebrew on a Mac),
  and typst renders SVG with resvg. The headless browser is not on every Mac, `sharp`/`resvg` would be new packages, and
  the Go helper has no SVG text. SVG text is drawn in the PDF font list (bundled Noto Sans CJK on Linux, the Mac's own),
  so Korean labels show. typst runs in the converter isolation with `--root` the work folder, like the PDF.
- **Left out:** these options for PDF and for text in PowerPoint (pandoc's pptx writer has no custom styles); a
  contents page with page numbers; changing an existing Word or Excel file in place (edit_office, another PR).
- **Tests:** tests/unit/c-make-file-rich.test.ts. Rendered once with LibreOffice 26.8 (docx: colours, highlight,
  landscape, header, "Page 1 of 1" footer, the PNG chart; xlsx: every rule kind).
- **Version impact:** minor (new make_file options and a new output format).
