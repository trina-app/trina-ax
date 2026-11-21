# PDF reads: the tool output limit in tokens, and whole-document questions read every page (QA AP-004)

- Date (UTC): 2026-11-19 13:30
- Branch: `fix/pdf-read-token-cap`
- Status: done
- Where: `server/src/files/service.ts` (pdfPagesForModel), `tests/unit/vision-read.test.ts`
- Version impact: patch. No API, setting or migration change.

## Problem

QA "AI parity 2026-11-19", AP-004 (Limit, Medium): for an 80-page PDF the AI read pages 1-20 and one chapter and
searched the text of the rest ("the AI reads only part of the PDF").

A read by pages holds at most 20 pages and 200,000 characters of text. Page images stop at READ_OUTPUT_TOKENS
(24,000), but page text did not. Claude Code cuts an MCP result over MAX_MCP_OUTPUT_TOKENS (25,000) and the AI then
does not have all the pages it asked for. Measured: F02 (English) pages 1-20 are about 5,000 tokens (no cut); F03
(Korean, 18 pages) is about 34,000 tokens (cut).

## Fix

The text of each page counts against READ_OUTPUT_TOKENS (600 tokens kept for the notes). From the first page that does
not fit, the pages wait for another call, and the note names it: `pages: "N-M"`, and "to answer about the whole
document, read every page this way". A first page that alone does not fit is cut at a line end and says to read the
rest with offset/limit. The room-file read (`room_file` by pages) uses the same function and its `reserve`.

## Whole-document questions read every page (owner decision 2026-11-19: option b)

F02 (English, 80 pages) pages 1-20 are about 5,000 tokens, so no cut there: the AI chose to read 20 pages and grep
the rest. The owner chose to change the tools' words (not to put the whole text in context, not a higher MCP limit).
`WHOLE_PDF_RULE` (files/vision.ts): "For a question about the whole document (a summary, every chapter, a check of all
of it), read every page in parts of 20 (…) before you answer; grep finds a passage, it does not read the document." It
is in the read tool's description (shared/src/tools.ts), chat_file's, the pages_required refusal of read and room_file
(grep and offset/limit only to look up one passage), and the note of a read cut at the tool output limit.

## Steps

1. Token cap in pdfPagesForModel. Done.
2. Tests: 18 dense Korean pages, a single page too long. They fail without the fix. Done.
3. WHOLE_PDF_RULE in the read words and refusals; tests check the descriptions, the refusals and the cut note. Done.
