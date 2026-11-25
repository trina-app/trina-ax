# Charts in made decks and Word files keep their data sheet (Edit Data works)

- Date (UTC): 2026-11-25 06:44
- Branch: `fix/pptx-chart-embedded-data`
- Status: done
- Where: server/src/files (the office exit check and a chart read-back), server/src/chat/places-copy.ts. Why: the
  check every AI-made Office file passes is in files/ (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: decks and Word files with native charts are kept with their chart data; no new
  setting or API.

## Goal

QA A-03-L (Top 50 tasks, 2026-11-24): a deck Trina made on Linux had charts, but PowerPoint's right-click > Edit Data
did not open their numbers. Claude Code's decks do. People who get a deck from Trina must be able to change a chart's
numbers in PowerPoint, Keynote or Google Slides.

Root cause (reproduced): pptxgenjs `addChart()` (the pptx skill's way) writes a native chart and its data workbook,
`ppt/embeddings/Microsoft_Excel_Worksheet<n>.xlsx`, linked from `ppt/charts/_rels/chart<n>.xml.rels` by a relationship
of type `.../relationships/package` (`<c:externalData r:id>` in the chart). The exit check every AI file passes
(files/office-exit.ts -> office-links-check.ts `scanOffice`) refuses every `package` relationship as "an embedded
object", so the deck was refused with "Remove it and save again", and the AI removed the workbooks to get it saved.
The same holds for a chart in a Word file (`word/charts/`, `word/embeddings/`).

## Scope

In:
- `scanOffice` (make_file's check and the exit check, every kind): a chart part's internal `package` relationship to
  an embedded `.xlsx` in the package passes when that workbook itself passes the same scan (no macros, links, data
  connections, objects; one level only: a chart inside the embedded workbook may not embed another). Anything else
  (`oleObject`, a binary `.xls`/`.bin`, a package from a slide, an external target, a missing part) is refused as before.
- A read-back of the charts of a .pptx / .docx leaving the work folder (save_work_file, copy_files: places-copy.ts
  officeOut), in the office worker: each chart has its data workbook, and the workbook's cells match the series the
  chart shows. The save result says so, or names each chart without data (or with other numbers) and how to fix it
  (rebuild with addChart, keep `ppt/embeddings/`), so the AI fixes it before answering.
- Tests with real files made by pptxgenjs (combo chart included) and python-pptx (a Word chart built in the test from
  the deck's parts), the exit check passing them, a macro / external link inside the embedded workbook refused, and the
  read-back.

Out:
- make_file's Markdown route (pandoc) still puts a chart in as a PNG picture; it is the fallback when box_shell cannot
  run, and pandoc cannot write native charts.
- Templates (office-template.ts) still refuse embedded workbooks: pandoc does not carry a template's slides.
- The vendored skill files (resources/doc-skills) stay as published (SOURCE.json hashes).

## Steps

1. `scanOffice`: chart-data workbook exception, nested scan.
2. `files/chart-data.ts`: read-back (mode `chart-data`), wired in office-parse.ts and places-copy.ts.
3. Unit tests in tests/unit, LibreOffice headless open of the generated deck as a manual check.
4. changes/pptx-chart-embedded-data.md, decision file for the exit-check exception.

## Decisions

docs/decisions/20261125-pptx-chart-embedded-data.md: a chart's own data workbook is not "an embedded object" for the exit
check (changes docs/decisions/20261124-doc-skills.md "Exit check").

## Risks

Security: the exit check gets one narrow allowance; the workbook is scanned with the same rules, and a risky item in
it is identified by the workbook's path and that item's own identity. No migration, no UI text.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for office-links-check, office-exit, chart-data.

## Result

Built as planned. Reproduced first: the pptxgenjs fixture deck saved through save_work_file was refused with "the
PowerPoint file refers to an embedded object ... (package) (and 3 more) ... Remove it and save again"; with the fix it
is saved byte for byte and the result says "all 4 charts are native charts with their data sheet". LibreOffice 26
headless opens both fixture decks with live chart objects. Fixtures and the scripts that made them are in
tests/fixtures/charts/.
