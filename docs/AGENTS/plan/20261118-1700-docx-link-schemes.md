# make_file: links only to the web, mail and the document itself

- Date (UTC): 2026-11-18 17:00
- Branch: `fix/docx-link-schemes`
- Status: done
- Where: server/src/tools/office-links.ts (new), server/src/tools/make-file.ts, server/src/tools/index.ts (one result line).
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
2. The finished package: external relationships must be hyperlinks to allowed targets; internal ones may not name a
   scheme, a share or a backslash path; Word fields: no HYPERLINK to other targets (or built by a nested field), no
   DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, IMPORT, LINK. Refused, nothing saved. A Word attached template is taken out.
3. Tests: every hostile scheme in the pure checks and through the tool for docx, pptx, pdf, xlsx and hostile templates;
   plain links still work.

## Decisions

docs/decisions/20261118-docx-link-schemes.md

## Tests

tests/unit/sec-make-file-links.test.ts
