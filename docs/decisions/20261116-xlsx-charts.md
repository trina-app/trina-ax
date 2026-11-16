# Excel files the AI makes can hold real Excel charts

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/xlsx-charts (AI scenario check EDIT-13, first run 2026-11-16, root cause #6 "missing tools")

Plan: docs/AGENTS/plan/20261116-0500-xlsx-charts.md.

- **Ask:** "월별 매출 엑셀에 지역별 막대 차트 넣은 파일 만들어줘" gave an Excel file with no chart: make_file could not
  write one, so the AI said so and drew a picture beside the chat.
- **Rule:** make_file with format "xlsx" takes `charts` (at most 10): `{ type: column | bar | line | pie, range: "A1:D5",
  sheet?, title?, anchor? }`. The range's first column is the labels, its first row the series names, every other column
  one series; a pie takes one column of numbers. The charts are native DrawingML charts (`xl/charts/chartN.xml`, one
  `xl/drawings/drawingN.xml` per sheet, their relationships and content types, `<drawing r:id>` in the sheet) added to
  the zip after exceljs has written the workbook (server/src/tools/xlsx-chart.ts). They refer to the cells, so Excel and
  LibreOffice redraw them when the numbers change, and they carry the values (formula results included) as their cache.
  Without `anchor` a chart goes right of the sheet's data, the next one below it.
- **Refused, nothing saved:** a range outside the sheet or not like "A1:D5", no label column or name row, a series
  column without numbers, a pie over more than one column, a sheet that is not there, `charts` on another format.
- **Why this way:** exceljs 4.4.0 and SheetJS 0.20.3 write no charts; a library that does would be a new dependency for
  four chart kinds. The parts are small and fixed, the server already has a zip reader and writer
  (files/zip-write.ts), and every other part of the file is copied as exceljs wrote it.
- **Left out:** adding a chart to a workbook the person already has, in place (the AI writes the table again with
  make_file, as for other changes to a sheet, and saves a new file); colours, axis titles, number formats on the axis,
  stacked bars and other kinds.
- **Tests:** tests/unit/c-make-file-xlsx-chart.test.ts (parts, references, caches, well-formed XML, refusals, a
  SheetJS-made workbook). Rendered once with LibreOffice (column, bar, line, pie).
- **Version impact:** minor (a new make_file option).
