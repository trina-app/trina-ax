# Seven small limits from the second limits audit

- Date: 2026-11-18
- Status: accepted
- Supersedes: the office worker's 60 s and 2 workers and pandoc's 20 s (2026-10-29, e855f798c); make_file's "exactly one
  of source or content"
- Branch: fix/audit2-small (QA TC-4914, TC-4917, TC-4918, TC-4921, TC-4923, TC-4924, TC-4926)

Plan: docs/AGENTS/plan/20261118-1135-audit2-small.md. Goal from the owner: the AI should behave like Claude Code.

## TC-4914: a big workbook from a CSV source

For a 50,000-row workbook the AI said it could put "about 100,000 characters" in an Excel file and made a 999-row
sample. Three things led there: make_file's "Limits: … 100,000 text characters" (written for PowerPoint; PR #1284 shows
it only where safe operations check it); a CSV `source` could only become one sheet, so a workbook with the data and a
summary over it had to be typed into `content`; and the AI cannot type 1.7 million characters into one call.

- make_file takes `source` (a .csv/.tsv) and `content` together for format xlsx: the CSV is the first sheet, named after
  the file without its extension, and each Markdown table of `content` is another sheet (a summary with
  `=SUMIFS(sales!E:E,…)`). Any other format still takes exactly one; `content` without a pipe table is refused.
- The description says it: a big workbook is made from the CSV as `source`, never retyped or sampled, up to 10 MB.
- Not changed: an .xlsx is not a `source` (convert to CSV first is not offered either); conditional formatting (N3).

## TC-4917: the Word title

pandoc's docx reader puts a Title, Subtitle, Author, Date and Abstract paragraph into the metadata, which `-t plain`
without a template leaves out. The marks filter (files/extract.ts MARKS_LUA) now puts them first, as plain lines in that
order. Without the filter (an old pandoc) `-s` gives the title, author and date. A document's core properties are not
used (pandoc does not read them as the title either), so a file without a Title paragraph gets no line.

## TC-4918: formulas next to values

A formula cell with a stored result reads `=SUM(B2:B9) → 1770` (files/office-parse.ts formulasWithValues): the formula,
then the value as the file shows it (an error too: `=B2/0 → #DIV/0!`). A formula over 300 characters is cut with "…".
Cells without a formula are unchanged, and a formula without a stored result still reads `=SUM(B2:E2)`. The text cache
format goes to 7 (6 stays usable and is made again in the background), so grep finds formulas too.

PR #1290 adds a streaming reader for big .xlsx files (sheet-stream.ts) and its own one-sheet path (sheetRangeText); both
need `formulasWithValues` (or the same text) after `formulaStubsAsText` once both are merged.

## TC-4921: no silent cuts in grep and list

- grep skips files over 50 MB (ripgrep `--max-filesize`, unchanged). The AI's grep now ends with how many were skipped,
  up to 5 names, and "Read them directly with read (offset and limit)". Only files the person can see are counted or
  named; the listing has no file contents and stops at 20,000 files.
- grep and list stop at about 20,000 tokens (28,000 characters, the estimate of files/vision.ts), under Claude Code's
  25,000 for a tool result, and end with the exact next call: `offset=N`. Both tools take a new optional `offset` (skip
  N output lines or entries). A single grep line longer than the budget comes back cut, with a note. The file screen's
  content search has no budget.
- read: PR #1282 (28,000 characters). glob returns at most 100 paths (no change). Left: Google Drive's read gives up to
  100,000 characters (40,000 by default) with no offset, which can pass 25,000 tokens in Korean (finding N18).

## TC-4923: office time limits by file size

| What | Before | Now |
|---|---|---|
| office worker read or write (xlsx/xls/ods/hwp/hwpx, docx/pptx extras, hwpx and PDF tools) | 60 s | 180 s + 2 s per MB, at most 10 min |
| pandoc (docx/pptx/odt) and pdftotext reads | 20 s | 60 s + 2 s per MB, at most 5 min |
| office workers at once | 2 | half the CPU budget, 2 to 6; with a plan at most its converter memory / 512 MB (never below 2) |

The memory caps stay: each worker 2,048 MB RSS, and the converter cgroup's memory.max for all of them together, so more
workers never take more memory. Background work still takes at most one worker. PR #1290 scales the same timeout
(`officeWorkerTimeoutMs(bytes)`, 60 s + 1 s per 2 MB past 32 MB); one of the two definitions stays when both merge.

## TC-4924: box_shell only when the dev environment works

A turn offers box_shell only when `srtProblem()` is empty (devenv/srt/runner.ts devEnvDownReason; cached 1-10 min; a
check that takes over 3 s counts as working, as before). When the team setting is on but the install is broken, the AI
is told once in its instructions, in plain words, which work cannot be done and not to say "try again in a few minutes".
An owner or admin is pointed to Admin › Settings › Dev environment; a member (and every shared chat) is told the
owner or an admin can see the reason, with no technical details. The admin page shows the reason under "This server
cannot run dev environments", and the server logs each new reason once.

## TC-4926: the sub-agent sentence from the tool list

The sentence named 6 tools sub-agents lack; PARENT_ONLY_TOOLS has 30. It is now built from PARENT_ONLY_TOOLS and the
turn's own tools (prompt.ts subagentLacks, PARENT_ONLY_WORDS), so a tool the turn does not have is not named. A test
checks every PARENT_ONLY_TOOLS entry has words. After PR #1289 (box_shell for sub-agents) the dev environment drops out
of the sentence by itself.
