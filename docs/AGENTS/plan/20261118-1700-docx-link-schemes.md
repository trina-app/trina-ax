# make_file: links only to the web, mail and the document itself

- Date (UTC): 2026-11-18 17:00
- Branch: `fix/docx-link-schemes`
- Status: done
- Where: server/src/files/office-rules.ts, office-xml.ts, office-links-check.ts, pdf-links.ts (new); server/src/tools/office-links.ts (markdown strip); make-file.ts, index.ts; office-template.ts (attached template). Built on #1281.
  Why: make_file writes the Word, PowerPoint, Excel and PDF files the AI makes.
- Version impact: patch (security fix)

## Goal

QA TC-4949. pandoc wrote every Markdown link into the file as it was: `file:///C:/...exe`, `\\host\share`,
`javascript:`, `ms-word:`, `search-ms:`, `ms-msdt:` and `../../x.exe` all became clickable links in a Word file. A team
template from skills/ (`template`) could also bring links, HYPERLINK / INCLUDEPICTURE fields and an attached template
on a network share. After this, a file made here links only to http, https, mailto and places inside the document.

## Scope

In: make_file's Markdown path (docx, pptx, pdf) and the finished docx, pptx and xlsx packages (pandoc's output, the
template's parts, docx-format.ts's header and footer).
Out: hwpx (its writer refuses links), the safe-ops PowerPoint path (refuses Link nodes), comment_docx (adds plain text
to a file the person already has), raw openxml (refused since #1303).

## Steps

1. pandoc's tree: a Link with any other target becomes a Span with the same words; the AI is told which ones.
2. The finished docx/pptx/xlsx: checked in the office worker with saxes (shares #1281's parser), so ">" in a value and a
   prefixed duplicate cannot hide a link. External relationships must be hyperlinks to allowed targets; internal ones may
   not name a scheme/share/backslash path; Word fields held to an allow-list (no DDE/INCLUDE*/DATABASE/RD/ADDIN/unknown,
   no HYPERLINK to a bad target or whose name is a nested field). A Word attached template is stripped at #1281's template
   check instead of refused.
3. PDF from .html or a deck: link annotations filtered (pdf-links.ts); mailto allows only to/cc/bcc/subject/body.
4. Tests: every hostile scheme and field in the pure checks, the worker check (saxes), the PDF filter, and through the
   tool for docx, pptx, pdf, xlsx and hostile templates; plain links still work; many unclosed instrText tags.

## Decisions

docs/decisions/20261118-docx-link-schemes.md

## Tests

tests/unit/sec-make-file-links.test.ts
