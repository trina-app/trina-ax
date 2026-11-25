# Charts in Word and PowerPoint files are native, editable charts by default

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (extends [20261125-pptx-chart-embedded-data](20261125-pptx-chart-embedded-data.md), whose "Left out"
  named make_file's PNG charts)
- Branch: fix/word-native-charts (live QA on qa.trina.app, dev 0.18.2-dev.20261125131845; plan
  [20261125-1346-word-native-charts](../AGENTS/plan/20261125-1346-word-native-charts.md))

- **Ask:** "차트 하나 넣은 Word 보고서 만들어 줘" gave a .docx whose bar chart was a PNG (word/media/image1.png, no word/charts),
  and the answer did not say so. Any Word or PowerPoint request with a chart, in any language, should get a chart whose
  numbers open with right-click > Edit Data, as an English request that said "editable" already did.
- **Cause:** every way the AI was shown to put a chart in Word drew a picture: make_file's words ("draw a chart as SVG
  and save it as PNG; an .svg picture in a Word or PowerPoint document goes in as a PNG, so a report can hold a chart")
  and the prompt's make_file line; the docx skill's docx-js writes no charts. The save read-back of #573 reads only
  native charts, so a chart picture passed in silence.
- **Rule:** a chart (bar, column, line, pie and the like) in a Word or PowerPoint file is a native chart with its data
  workbook unless the person asks for a picture or the chart has no native form; when it is a picture, the answer says
  its numbers cannot be edited. The ways:
  - make_file (Markdown): a fenced ```chart block with one JSON object (type column, bar, line, pie; title; categories;
    series of name + values) becomes a native chart after pandoc (tools/office-chart.ts): the chart part over its own
    workbook's cells with the values cached, the workbook in word/embeddings or ppt/embeddings named by
    `<c:externalData>`. In PowerPoint the block stands alone under its slide heading and takes the content
    placeholder's area; with other text on that slide it is refused with the fix. A PDF refuses the block (no native
    charts) and keeps the SVG picture way. The file passes the same exit check (#573's chart-workbook rule, unchanged).
  - Document skills (box_shell): PowerPoint keeps addChart / add_chart (the pptx skill already says "keep charts
    native"). Word gets `docx/scripts/word_chart.py`, our own file next to the vendored skill (`added` in SOURCE.json):
    it replaces placeholder paragraphs ("[[chart:sales]]") with native charts, using python-docx and python-pptx's
    chart writer (both preinstalled in a run). The prompt names it (`DOC_CHART_RULE`).
  - Read-back: a .docx / .pptx leaving the work folder with pictures and no chart part gets one line: a chart drawn as
    a picture cannot be edited; rebuild it natively, or say plainly it is a picture (files/chart-data.ts
    `pictureChartLine`, from the part names only).
- **Left out:** chart kinds beyond column, bar, line and pie in the make_file block (the helper also has stacked, area
  and doughnut); Hangul (.hwpx) charts; templates' own embedded workbooks (still refused, as before).
- **Tests:** tests/unit/office-chart.test.ts (block parsing, Word and PowerPoint files from make_file read back as "ok"
  and passing the exit check, refusals, the helper with python-docx / python-pptx, the picture line, the words),
  tests/unit/places-copy.test.ts (save_work_file of a Word file with a picture), tests/unit/doc-skills.test.ts (the added
  file), AI scenario EDIT-19 (ko, en, ja, pptx).
- **Version impact:** patch (bug fix).
