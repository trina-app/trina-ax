# A PDF read by pages stops at the tool output limit in tokens, not only in characters (QA AP-004)

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

## Not in this PR (owner decision)

- The read tool's words and the `pages_required` refusal still offer grep and offset/limit. A rule that a
  whole-document question reads every page in parts (no grep sampling) is a prompt change.
- Put the whole extracted text in context as claude.ai does, or raise Claude Code's MCP output limit: cost and
  latency trade-offs.

## Steps

1. Token cap in pdfPagesForModel. Done.
2. Tests: 18 dense Korean pages, a single page too long. They fail without the fix. Done.
