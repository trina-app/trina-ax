# Big Office files: read the text parts, raise the cap to 200 MB

- Date (UTC): 2026-11-18 11:00
- Branch: `fix/limits-office-read`
- Status: done
- Where: server/ (files: extract, office worker, new zip-slim and sheet-stream, hwp, cfb; files/service read), shared/ (read's input). Why: reading files is Team AX core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, files that were refused now read; read gains two optional arguments

## Goal

On Linux (or with a plan) an Office file over 32 MB reads like a small one: spreadsheets and Hangul files are no longer
refused, Word and PowerPoint keep their speaker notes, chart data, headers, footers and comments, and a big deck is not
cut down to its pictures. A very large workbook comes as an overview that names how to read the rest (QA TC-4910,
limits audit item #8).

## Scope

In: emptying pictures and media before any reader (zip-slim.ts), a streaming .xlsx reader with an overview and
sheet/range reads (sheet-stream.ts), read's `sheet` and `range`, Word chart data, a .hwp read without its pictures, the
cap at 200 MB, the worker's stdin read and time limit for big inputs.
Out: old formats (.doc, .ppt), other archives (audit #9), the grep text cache format (no version change), room/chat
file tools (their own 32 MB limits, audit #7 and #23).

## Steps

1. zip-slim.ts: copy the text parts as they are, empty the rest; extract.ts uses it for docx/pptx/odt/xlsx/hwpx.
2. sheet-stream.ts: inflate each sheet a piece at a time; whole text when it fits, else an overview; a range reader.
3. office-parse / office-worker / extract: route big .xlsx to it, pass sheet/range, read stdin into one buffer, scale the time limit.
4. read: `sheet` and `range` for spreadsheets; Word charts; hwp via cfb.ts without BinData; cap 200 MB.
5. Tests, decision, changes note; real-AI check with a 58 MB workbook and a deck with notes and a chart.

## Decisions

`docs/decisions/20261118-limits-office-read.md`.

## Risks

Memory of the office worker on the smallest servers (converter cgroup 512 MB): measured peaks are in the decision.

## Tests

tests/unit/office-big.test.ts (new), office-worker, office-extra, g-limits, sources-locations, hwp; check:prepush.

## Result

See the decision for the measurements and the real-AI check.
