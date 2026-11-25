# Charts in Word and PowerPoint files are native, editable charts by default

- Date (UTC): 2026-11-25 13:46
- Branch: `fix/word-native-charts`
- Status: in progress
- Where: server/src/tools (make_file), server/src/files (chart parts, chart read-back), server/src/chat/prompt.ts,
  resources/doc-skills (one added helper). Why: make_file and the save read-back are where every made Office file
  passes (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: a chart asked for in a Word or PowerPoint file comes out editable, as it already
  did when the request said "editable"; no setting or API changes.

## Goal

Live QA on qa.trina.app (dev 0.18.2-dev.20261125131845): "차트 하나 넣은 Word 보고서 만들어 줘" gave a .docx whose bar
chart is a PNG (word/media/image1.png, no word/charts): Edit Data finds nothing, and the answer did not say so. An
English request that asked for an "editable" chart got a native chart with its data workbook. People asking in any
language for a chart in a Word or PowerPoint file should get a chart they can edit, like Claude's documents.

Root cause: every path the AI is shown for a chart in Word draws a picture. make_file's description and the prompt say
"draw a chart as SVG and save it as PNG; an .svg picture in a Word or PowerPoint document goes in as a PNG, so a
report can hold a chart", and the docx skill (docx-js) has no chart at all, so the AI draws one (SVG or matplotlib).
Only a request that says "editable" makes it look for another way. The save read-back (files/chart-data.ts, #573)
only reads native charts, so a file with a chart picture and no chart part passes silently.

## Scope

In:
- make_file (Markdown to .docx / .pptx): a fenced ```chart block with a small JSON spec (type column, bar, line, pie;
  title; categories; series of name + values) becomes a native chart with its data workbook (word/charts +
  word/embeddings, ppt/charts + ppt/embeddings), written by the server after pandoc. In PowerPoint the chart takes the
  slide's content area (a chart block alone under its slide heading). Refused for PDF, with the reason.
- The run (document skills): a helper `docx/scripts/word_chart.py` (added by us next to the vendored skill) puts native
  charts into any .docx at placeholder paragraphs, with python-docx and python-pptx's chart writer (both preinstalled).
- Words for the AI (prompt and make_file's description): a chart in a Word or PowerPoint file is a native chart with its
  data sheet unless the person asks for a picture or the chart has no native form; PowerPoint addChart / add_chart,
  Word the helper (or make_file's chart block); when a chart is a picture, say so plainly.
- Read-back: a .docx / .pptx leaving the work folder with pictures and no native chart gets one line: a chart drawn as
  a picture cannot be edited; rebuild it as a native chart or say plainly that it is a picture.
- Tests: chart parts and workbook (chart-data review says ok, the exit check passes), make_file with chart blocks
  (docx, pptx, refusal cases), the helper (when python-pptx is there), the read-back line, the prompt words.

Out:
- Chart kinds beyond column, bar, line and pie in the make_file block (scatter, combo): the skills route has them.
- Hangul (.hwpx) charts.

## Steps

1. files/office-chart.ts: chart part + workbook + insertion into .docx / .pptx at marker paragraphs.
2. make_file: chart blocks to markers in pandoc's tree, insertion after pandoc, before the link check; result count.
3. resources/doc-skills/docx/scripts/word_chart.py, SOURCE.json "added", README.
4. Prompt and make_file words; read-back line for pictures without charts.
5. Unit tests; a few real prompts (EN/KO/JA) if a run can be made here.
6. changes/word-native-charts.md.

## Decisions

docs/decisions/20261125-native-charts-default.md: charts in Word and PowerPoint are native by default; one added
helper ships next to the vendored docx skill.

## Risks

Security: the new parts are written by the server from numbers and text the AI gives (escaped); the file still passes
the exit check, whose chart-workbook allowance (#573) is unchanged. No migration, no UI text, no new tool (tool lists
unchanged).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for make-file, chart-data, office-chart, doc-skills, prompt;
web unit tests.

## Result

(filled in at the end)
