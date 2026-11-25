# Document skills

The `docx`, `pptx`, `xlsx` and `pdf` skills from [github.com/anthropics/skills](https://github.com/anthropics/skills)
at commit `e4bb5d960d87126ff3b3a8af1a104b7db67560ba`, under the Apache License 2.0. Each folder keeps its `LICENSE.txt`. Copyright remains with the
authors. `SOURCE.json` records the commit and the sha256 of every file shipped here.

## What Trina AX changed

- **Not shipped:** `scripts/office/schemas/` in docx, pptx and xlsx. These XSD files come from ISO/IEC 29500, ECMA-376
  and Microsoft and carry no licence statement of their own, so we could not confirm that Apache-2.0 covers them.
- **Changed:** `scripts/office/validators/base.py` in docx, pptx and xlsx. Without the schemas the XSD check is skipped
  and prints `NOT CHECKED`; the other structural checks run as published. The file carries a notice of this change.

- **Added:** `docx/scripts/word_chart.py` (Trina AX's own, AGPL-3.0-only, listed under `added` in `SOURCE.json`). docx-js
  writes no charts, so a Word file's chart came out as a picture nobody can edit; this puts native charts with their
  data workbook at placeholder paragraphs, with python-docx and python-pptx's chart writer. The skill's `SKILL.md` is
  unchanged; the prompt names the script (server/src/chat/prompt.ts `DOC_CHART_RULE`).

Everything else is as published. To update: take a new commit, check each `LICENSE.txt`, apply the same changes, keep the added file and
rewrite `SOURCE.json`.
