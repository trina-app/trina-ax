# A chart's own data workbook passes the Office exit check; charts are read back on save

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (narrows "Exit check" in [20261124-doc-skills](20261124-doc-skills.md))
- Branch: fix/pptx-chart-embedded-data (QA A-03-L, Top 50 tasks 2026-11-24; plan
  [20261125-0644-pptx-chart-embedded-data](../AGENTS/plan/20261125-0644-pptx-chart-embedded-data.md))

- **Ask:** charts in decks (and Word files) Trina makes must be editable: right-click > Edit Data in PowerPoint,
  Keynote or Google Slides opens their numbers, as in Claude Code's decks. Owner: fix the root for every chart in every
  deck, and check Word and Excel the same way.
- **Cause:** a native chart keeps its numbers in an embedded workbook (`ppt/embeddings/*.xlsx`, `word/embeddings/`),
  linked from the chart part by a `.../relationships/package` relationship and `<c:externalData>`. pptxgenjs `addChart`
  and python-pptx `add_chart` both write it. The exit check (files/office-links-check.ts `scanOffice`, also make_file's
  check) refused every `package` relationship as an embedded object, so a deck with native charts was refused with
  "Remove it and save again" and the AI removed the workbooks. Excel charts point at the workbook's own sheets and were
  never affected.
- **Rule:** a `package` relationship passes only when (1) its target is not outside the file (the external, scheme,
  `//` share and backslash checks run first, as for every relationship) and is a plain relative path (no `:`, leading
  `/` or `//`, `\`, `%`); (2) its source part is a chart by its content type in `[Content_Types].xml`
  (`application/vnd.openxmlformats-officedocument.drawingml.chart+xml`), not by its name alone; (3) its Id is the one
  the chart's `<c:externalData r:id>` names; (4) its target is an `.xlsx` in the `embeddings/` folder of the same
  top folder (`ppt/`, `word/`, `xl/`) and exists; and (5) that workbook passes the same scan as an Excel file, one level
  deep (no macro project, outside links, data connections, OLE / package objects of its own, Word fields). A risky item
  inside it is refused, naming the workbook ("has a chart data workbook ppt/embeddings/… that holds a macro project").
  Each workbook is scanned once per file; at most 500 workbooks and 64 MB of them are checked, past that the file is
  refused. Everything else stays refused: `oleObject`, a binary `.xls` / `.bin`, a package on a slide or in the document
  body, an external target.
- **Read-back:** a .pptx or .docx leaving the work folder (save_work_file, copy_files) has its charts read in the office
  worker (files/chart-data.ts, mode `chart-data`): per chart, whether its data workbook is named, present, readable and
  holds the values the chart shows (only the cached points are compared, within one budget of 64 MB of workbooks and
  1,000,000 cells per file; past it a chart counts as unreadable). The save result says "all N charts are native charts with their data sheet", or
  names each chart (slide, title) that cannot be edited and how to fix it, so the AI rebuilds before it answers.
- **Left out:** make_file's Markdown route (pandoc) still puts a chart in as a PNG (the fallback when box_shell cannot
  run). Templates (office-template.ts) still refuse embedded workbooks: pandoc does not carry a template's slides. The
  vendored skills (resources/doc-skills) are unchanged.
- **Tests:** tests/unit/chart-data.test.ts (with the cases of the security review of #573) (real decks from tests/fixtures/charts: pptxgenjs 4.0.1 and python-pptx
  1.0.2), tests/unit/places-copy.test.ts (save_work_file of the deck).
- **Version impact:** patch (bug fix).
