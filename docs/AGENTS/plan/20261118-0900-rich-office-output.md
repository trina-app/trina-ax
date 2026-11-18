# Word and Excel files with formatting, and chart pictures

- Date (UTC): 2026-11-18 09:00
- Branch: `feat/rich-office-output`
- Status: done
- Where: server/src/tools (make_file) and shared/src/tools.ts (its input). Why: the AI makes Office files there; the
  formatting and the pictures are part of the files it writes.
- Version impact: minor (new make_file options and one new output format)

## Goal

Second limits audit, N3 and N4 (QA TC-4915, TC-4916). The AI said "I can't set text colours in a Word file here",
"Word files I make here can't have a custom header or footer", "I can't add conditional formatting" and "I can't
create PNG images" (it drew an SVG instead), so a Word report could not hold a chart. After this, make_file writes all
of those.

## Scope

In:
- docx: text colour and highlight on a span or a block (`[text]{color=red highlight=yellow}`), header and footer
  text with page number fields, page numbers, page size, orientation and margins (`page`).
- xlsx: per sheet number formats, column widths, frozen rows/columns, filter on/off and conditional formatting
  (`sheets`), all through exceljs.
- format "png": an SVG (content or a .svg source) rendered to a PNG by typst, which every install that makes PDFs
  already has (Linux bundle; brew on a Mac) and which draws SVG with resvg. No browser, no new package.
- An .svg picture in a docx or pptx is turned into a PNG the same way, so a chart drawn as SVG goes into the file.

Out: these options for PDF and pptx text; editing an existing file in place (edit_office, another PR); a chart
spec that draws the SVG for the AI.

## Steps

1. `server/src/tools/docx-format.ts`: the AST pass for coloured spans and the docx zip pass (styles, header/footer
   parts, section properties).
2. `server/src/tools/xlsx-format.ts`: sheet options on the exceljs worksheet.
3. `server/src/tools/svg-png.ts`: SVG to PNG with typst in the converter isolation.
4. MakeFileInput: `page`, `sheets`, format "png"; make_file's description; the result text.
5. Unit tests that fail on the old code; a real-AI check (Word report with a red highlighted risk line, company
   header, page numbers and a bar chart picture; an Excel sheet with conditional formatting).

## Decisions

docs/decisions/20261118-rich-office-output.md

## Risks

A malformed part makes Word "repair" the file: the parts follow ECMA-376 order, tests check them, and the output is
opened in LibreOffice once. SVG text needs a font: typst falls back to the document fonts (the bundled Noto Sans CJK on
Linux, the Mac's own fonts), as for PDFs.

## Tests

tests/unit/c-make-file-rich.test.ts
