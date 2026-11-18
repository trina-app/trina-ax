# Office read: Word tracked deletions and Excel charts

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/office-read-tracked-charts (QA TC-4969, found in TC-4910)

- **Ask:** "the AI should behave like Claude Code". Two parts of Office files did not reach the AI. pandoc's plain text
  of a .docx accepts every tracked change: insertions stay, deletions are dropped, so "what did the reviewer change?"
  could not be answered. Charts in an .xlsx were not read at all (SheetJS and the streaming reader give cells only),
  while Word and PowerPoint charts were already described (ooxml.ts, #1290).
- **Rule 1, tracked changes:** the office worker's `docx-extra` text gets a section `=== Word tracked changes (edits
  not yet accepted; the body above shows insertions and leaves deletions out) ===`. Each paragraph of the body that
  holds a change is given once, whole, with its changes marked in place: `[deleted: …]` (`<w:del>`, its
  `<w:delText>`), `[inserted: …]` (`<w:ins>`), `[moved away: …]` / `[moved here: …]` (`<w:moveFrom>` / `<w:moveTo>`),
  under `- Changed by <author>, <date>:`. Marks without text (a paragraph mark, a run property change) are left out.
  pandoc's body text does not change, so search places, edits by text and old caches stay as they were. Headers,
  footers, footnotes and comments are not scanned for changes (the body is where reviews happen; can be added later).
- **Rule 2, Excel charts:** after the sheets of a whole-workbook read (and after the overview of a big workbook), a
  section `=== Excel charts (charts drawn on the sheets above, with the cells they show) ===` gives each chart in
  workbook order and the order of its sheet's drawing: `- Chart "<title>" (<type> chart) on sheet "<name>":` (or `on
  chart sheet`), then per series `- series "<name>" (values <range>, categories <range>, name <cell>): <cat> = <value>;
  …` from Excel's cached values. A chart without cached values (openpyxl and other writers) says so and keeps its
  ranges, which the AI can read. A chart in the default namespace or under another prefix is read too
  (`chartPrefix`), which also helps Word and PowerPoint charts from such writers. A read of one sheet or range does
  not add charts. Only the parts charts need are inflated (workbook, relationships, drawings, charts; each at most
  16 MB, 64 MB in all), so a big workbook's sheets stay compressed. Charts that cannot be read give a labelled line;
  the sheets are never lost. The sheets' text plus charts stays under the worker's 32 MB output.
- **Places:** files/locations.ts treats the chart section line as the end of the last sheet, so chart lines get no
  sheet range in sources or grep.
- **Safety:** the same linear tag scans as the other ooxml.ts parts; attribute and cell text is put on one line, so a
  series name, title, author or deleted text cannot start a section label or a `# sheet:` line. The text is file
  content, never instructions, like the rest of a file.
- **Cache:** TEXT_CACHE_VERSION 6 → 7; format 6 text is still right (it only lacks the new sections), so it is kept
  and made again in the background like format 5 (`UPGRADABLE_VERSIONS`). The folder version stays 5.
- **Tests:** tests/unit/office-tracked-charts.test.ts (pandoc-made .docx with `.insertion` / `.deletion` spans;
  SheetJS workbooks with make_file's chart writer, an openpyxl-style chart, a 2 MB+ workbook through the streaming
  reader, places, forged labels, a linear-time case).
