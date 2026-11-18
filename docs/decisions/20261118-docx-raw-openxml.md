# make_file refuses raw markup for the writer

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/docx-raw-openxml (QA TC-4941, found in the review of #1295)

Plan: docs/AGENTS/plan/20261118-1300-docx-raw-openxml.md.

- **Problem:** pandoc copies a raw block of the output's own format into the file unchanged. Markdown with
  `` `<w:instrText>DDEAUTO ...</w:instrText>`{=openxml} `` (from the AI, or from a team-folder .md someone else wrote,
  given as `source`) became a DDE field in word/document.xml, which Word offers to run when the file opens. The same
  went for PowerPoint (openxml) and raw typst in a PDF.
- **Rule:** after pandoc reads the Markdown and before anything else, make_file walks the whole tree (metadata
  included). A RawBlock or RawInline of any format other than html or markdown is refused with "raw <format> markup ...
  cannot go into a file made here", and nothing is saved. TeX ones (`\newpage`, `\pagebreak`), which the docx, pptx and
  typst writers ignore anyway, are replaced by an empty Div or Span, so documents that used them still convert.
- **Not changed:** hwpx (its writer already refuses raw markup except `\newpage`), the safe-ops PowerPoint path (it
  already refuses raw nodes), CSV input (no raw nodes).
- **Tests:** tests/unit/sec-make-file-raw.test.ts.
- **Version impact:** patch.
