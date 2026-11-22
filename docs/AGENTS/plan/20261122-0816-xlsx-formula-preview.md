# Spreadsheet preview: formula results instead of formula text (S-112)

- Date (UTC): 2026-11-22 08:16
- Branch: `fix/xlsx-formula-preview`
- Status: done
- Where: web/src/lib/sheetFormulas.ts, web/src/components/viewers/OfficeView.tsx (SheetView), web i18n. Why: QA S-112
- Version impact: patch, a fix to the spreadsheet preview; no API, data or settings change

## Goal

An .xlsx made by the AI (make_file, or openpyxl / XlsxWriter in the work folder) stores formulas without results.
The preview showed `=IF(C2=0,…)` and `=SUM(…)` where Excel and Google Sheets show numbers. It now shows the result,
and the formula on hover or when the cell is clicked or tapped (a line under the sheet). It never shows a number that
Excel would not show: a formula it cannot work out stays as its formula text, greyed.

## Options

(a) Store results when the file is made: needs a calculation engine on every install type. LibreOffice is not in
`scripts/system/packages.json` (it is not on the office Mac or the hosted image), and adding it is a large root
update. A JS engine at save time covers only make_file, not files that Claude Code writes with openpyxl.
(b) Work out common formulas in the preview, for display: covers every file and every install type, no package.
Chosen: (b).

## Scope

In: + - * / ^ & %, comparisons, cell and range references (also to another sheet, quoted or not, `B:B`), SUM,
AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, ROUND, ABS, AND, OR, NOT; `#DIV/0!` as Excel shows it; the cell's
number format. A file with `fullCalcOnLoad` (openpyxl, XlsxWriter: XlsxWriter stores 0 as every result) has every
formula worked out, as Excel does on open.
Out: other functions, defined names, array formulas, dates. These show the formula text, greyed, with a hover note.
Nothing is written back to the file; the AI read path on the server is unchanged.

## Never a wrong number

Not calculated (formula text shown): text in arithmetic (Excel: #VALUE!), a range where one value is expected, a
reference past the rows the preview read on a sheet cut at 5000 rows, a whole column on such a sheet, a circular
reference, a missing sheet, any formula that uses one of these cells.

## Tests

web/test/unit/sheet-formulas.test.ts: SUM, AVERAGE, IF branches, cross-sheet (quoted, Korean), #DIV/0! and IFERROR,
unsupported functions and their dependents, stored results kept, fullCalcOnLoad, the cut-sheet case, operators.
Visual check on a private QA copy at 1440 and 390 with an openpyxl file without stored results.

## Result

Done: see the PR.
