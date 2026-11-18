# make_file: no raw Office markup from the Markdown

- Date (UTC): 2026-11-18 13:00
- Branch: `fix/docx-raw-openxml`
- Status: done
- Where: server/src/tools/make-file.ts. Why: make_file turns the AI's Markdown into the Word, PowerPoint and PDF files.
- Version impact: patch (security fix)

## Goal

QA TC-4941. Pandoc copies raw blocks such as `` `<w:instrText>DDEAUTO ...</w:instrText>`{=openxml} `` into
word/document.xml unchanged, so Markdown written by the AI (or a team-folder .md source someone else wrote) could put
a DDE field, an external link or broken XML into a Word file. After this, make_file refuses raw markup in any format
other than HTML and Markdown before pandoc writes docx, pptx or PDF.

## Scope

In: the Markdown path of make_file (docx, pptx, pdf): RawBlock / RawInline with a format other than html or markdown
are refused (nothing saved); tex/latex ones (`\newpage`) are dropped, since no writer of these formats uses them.
Out: hwpx (its writer already refuses raw markup) and the safe-ops PowerPoint path (already refuses raw nodes).

## Steps

1. A walk over pandoc's tree after the Markdown is read, before images and the writer.
2. Unit tests: openxml raw inline and block refused for docx and pptx, typst raw refused for pdf, `\newpage` and raw
   HTML still work.

## Decisions

docs/decisions/20261118-docx-raw-openxml.md

## Tests

tests/unit/sec-make-file-raw.test.ts
