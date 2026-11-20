# Office skills for the prepared list: tested, none added

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (applies DS3 and W6 in docs/DECISIONS.md: only skills with a known origin, nothing added by itself)
- Branch: feat/office-skills

- **Question.** Should "skills Trina prepared" (intro deck, card news, promo video, natural writing) offer the skills
  office workers use most: Anthropic's docx, xlsx, pptx and pdf, internal-comms and doc-coauthoring
  (github.com/anthropics/skills), and a meeting-notes skill written from knowledge-work-plugins' call-summary and
  meeting-briefing (github.com/anthropics/knowledge-work-plugins)? The rule: a skill ships only if it measurably beats
  the same request without it.
- **Licences.** docx, xlsx, pptx, pdf and internal-comms each carry the Apache-2.0 LICENSE.txt in their folder;
  knowledge-work-plugins has Apache-2.0 at its root. doc-coauthoring has no LICENSE.txt and no `license` line, and the
  repository has no root licence, so its terms cannot be confirmed: dropped without a test.
- **Can they run here.** The team AI has no shell: Claude Code's Bash is denied (server/src/engine/claude.ts
  `CLAUDE_BUILTIN_DENIED`), and a skill's scripts run only through box_shell when the dev environment is on
  (server/src/chat/prompt.ts `skillScriptsLine`). The docx, xlsx, pptx and pdf skills are mostly instructions to run
  scripts and programs: Python (openpyxl, pandas, markitdown, pypdf, pdfplumber, reportlab), Node packages (docx,
  pptxgenjs, react-icons, sharp), LibreOffice, pandoc and poppler. The dev environment's packages
  (scripts/system/packages.json `devenv`) have python3, openpyxl, python-docx, Node and Chromium, not LibreOffice,
  pandoc, poppler or the other libraries. A pack also installs SKILL.md alone (skill-packs.ts `placeSkill`), so the
  scripts/ folder would never reach a team. Without a dev environment (Docker, plans under 4 GiB, most self-installs)
  none of their steps run. internal-comms and meeting-notes are text only and run anywhere.
- **A/B.** Thirteen office tasks on a private copy of the QA team with the real AI (Claude Code on an office Mac
  login), once with no skill and once with the skill in skills/ and invoked by name: edit a contract with tracked
  changes and a comment, a memo with a cost table and page numbers, a workbook with formulas and a chart, VAT columns
  in an existing workbook, an 8-slide deck from notes, filling a fillable PDF form, a PDF table to Excel, four
  meeting transcripts or notes (one Korean, one with put-off items, an owner-less task and an injected instruction),
  a weekly status update and an incident report.
  - docx, xlsx, pdf: the same result with and without (every turn said "This runtime cannot execute bundled scripts"
    and used make_file, edit_office, comment_docx and edit_pdf as before).
  - pptx: worse with the skill (2 drawn visuals instead of 7; more bullet slides).
  - meeting-notes: as good, slightly more consistent (put-off items always under open questions, "not set" instead of
    a guessed due date, an injected line flagged), not clearly better: the AI already writes decisions, a to-do
    table with owners and dates, and open questions.
  - internal-comms: the same content; the skill only changes the layout to Anthropic's own 3P format.
- **Decision.** None is added; the prepared list stays as it is (four skills). The built-in tools already cover what
  the office skills do in this runtime, so a skill would add a row people must choose without changing the result.
- **What the test found instead (product gaps, not skills).** Tracked changes cannot be made: edit_office keeps
  existing ones but adds none, so "send it back with our changes marked" ends as plain edits plus comments. A fillable
  PDF form is not filled: edit_pdf prints the text on the page under the form's empty fields, so macOS Preview and
  poppler show a blank form while the AI says every entry is in its box. Both are tool work, recorded on the QA sheet.
- **Reopen when** the dev environment ships LibreOffice and a pack can carry a skill's whole folder, or a skill shows
  a clear win on the same kind of A/B.
