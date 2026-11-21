# Big Office files: read the text parts, not the pictures; the cap is 200 MB

- Date: 2026-11-18
- Status: accepted
- Supersedes: the 32 MB "in-process parse" cap (server/src/system/limits.ts `IN_PROCESS_PARSE_MAX`, 2026-10-27 snapshot)
- Branch: fix/limits-office-read (limits audit item #8, QA TC-4910)

Plan: docs/AGENTS/plan/20261118-1100-limits-office-read.md.

- **Ask:** "the AI should behave like Claude Code". On Linux (or with a plan) a spreadsheet or Hangul file over 32 MB
  could not be read at all ("download it to look at it"), and a Word or PowerPoint file over 32 MB lost its speaker
  notes, chart data, headers, footers and comments. Exports and decks over 32 MB are common; a deck is big because of
  its pictures.
- **Rule 1, pictures are not read as text:** before a reader sees a .docx, .pptx, .odt, .xlsx or .hwpx of 1 MB or more,
  every part that is not text (pictures, sound, video, fonts, embedded files, printer settings) is emptied
  (`files/zip-slim.ts`). Kept: `*.xml`, `*.rels`, `*.hpf`, `*.vml`, `mimetype`, `META-INF/*`. A dropped part stays in
  the zip under its own name with no bytes, so every relationship still finds a part. Nothing is inflated: the central
  directory is read with zip-guard's bounded reader and the kept parts are copied as they are, still compressed, so it
  runs in the server process. pandoc and the office worker then read a zip of a few MB; pandoc's text of a deck and a
  report was byte for byte the same with and without the pictures. The readers check the slim zip again before they
  expand anything.
- **Rule 2, the cap:** `IN_PROCESS_PARSE_MAX` is 200 MB (it was 32 MB), the same as the read limit and unzip_file, and
  counts the file after rule 1. The office worker's own limits stay (sandbox, converter cgroup, 2 GB resident memory
  watchdog, output cap); its wall clock grows with the input: 60 s, plus 1 s per 2 MB past 32 MB (144 s at 200 MB; since the 11-18 batch #1300's 60 s + 4 s per MB, at most 10 min, docs/decisions/20261118-audit2-small.md),
  and the CPU-time rlimit with it.
- **Rule 3, big workbooks are read a piece at a time:** SheetJS holds every cell in memory, about 120 times the file
  (1.3 GB for an 11 MB export, 2.3 GB for 18 MB, past the worker's 2 GB). An .xlsx over 2 MB, or one whose parts
  expand past zip-guard's 200 MB, goes to `files/sheet-stream.ts`: each sheet is inflated 1 MB at a time and its rows
  are scanned as they come (linear scans, a row that does not end stops the read at 64 MB, no part may inflate past
  its declared size, the declared sizes pass zip-guard's ratio check; up to 4 GB declared in all, bounded by the time
  limit). Shared text is packed into blocks (a million short texts cost their characters, not a million strings).
  Values are the stored ones: dates as ISO dates, percentages as percentages, other number formats not applied (a
  total shows as 2840332644.62, where SheetJS's General format showed 2841038064).
  - When the whole text is at most 32 MB, it is the same text SheetJS gives (labels, ranges, `# row N`, empty fields to
    the last column; checked equal in the tests), so grep's cache and read agree.
  - Otherwise the text is an **overview**: a first line that says the workbook is too large to give whole and how to
    read on, then per sheet its label with the real range, how many rows hold data and which columns, the first 20
    and last 10 rows with data (totals are usually at the bottom), and the exact range of the rows not shown.
  - **read's `sheet` and `range`** (spreadsheets only: .xlsx, .xls, .ods) give one range of one sheet: "A1:H2000",
    "5000:7000", "C:F", "A1200:"; at most 2,000 rows with data per read, ended by the range to read on with. A sheet
    name that is not there lists the sheets. Small workbooks get the same through SheetJS.
- **Rule 4, a big .hwp is read without its pictures:** at 8 MB and more, `files/cfb.ts` (the strict reader edit_hwp
  uses) reads only the streams outside `BinData/` (the others are still checked); a file it does not take goes to
  SheetJS's reader as before. A 150 MB .hwp of photos took 560 MB of worker memory, now 280 MB.
- **Rule 5, Word charts:** a .docx's charts (series, categories, values) come after its comments, like a deck's, under
  `=== Word charts (the data of the charts in the body, in order) ===`.
- **Worker input:** stdin is read 1 MB at a time into one buffer of the size the server passes (`INPUT_BYTES`):
  `Bun.stdin.arrayBuffer()` on a pipe peaked at 570 MB for a 200 MB file, this at 234 MB.
- **Measured (Apple M-series, Bun 1.3.12, `--smol`, peak resident memory of the worker):** a 58 MB export (4 sheets,
  1.1 M rows, 347 MB of XML): overview in 6 s CPU, 310 MB; one range of its last sheet in 1 s. A 200 MB export (12
  sheets, 3.7 M rows): overview in 19 s CPU, 530 MB; a range of the last sheet 2.5 s, 530 MB. 160 MB deck and report
  of pictures: under 0.5 s each (the slim zip is 30 KB). So a 200 MB workbook fits a converter cgroup of 1 GB (a 4 GB
  server); on the smallest servers (512 MB for all converters) a workbook near 200 MB can still be stopped, and the AI
  is told "too large or too complex to read safely as text (the reader ran out of memory or time)" as before.
- **Left as it was:** grep's text cache format (version 6; text of files that read now is made at the next search;
  existing .docx files get their chart data when they change) and its 50 MB per-file limit; chat_file, room_file and
  Drive attachments keep their own size limits (audit items #7, #23); .xls and .ods have no streaming reader (SheetJS
  under the worker's limits); old formats and other archives (audit #9).
- **Hostile input (security review of #1290):** zip-slim gives up (the reader gets the original and refuses it) when
  central entries share a local header or their [header, data end) ranges overlap, when the kept data is larger than
  the file, and on zip64, encryption or damage; the slim copy is used only when the emptied parts are over a quarter
  of the file. sheet-stream: an open row or shared text item may grow to 16 MB (the head before the sheet data to
  8 MB), and the search for its end tag goes on where it stopped (one pass, not one per piece); at most 10 M shared
  text items, each counted as at least 8 characters; a cell's text is cut at 32,767 characters (Excel's own limit) with
  a note, a row of more than 8 MB of text is refused as too large; the empty fields that pad rows to the last column
  count against the whole-text size (one cell in column XFD falls back to the overview).
- **The overview's own size (security re-review of #1290):** the rows it keeps are cut, each cell at 300 characters and
  each row at 64 KB, with a note to read the row by its range; rows are added one at a time while the overview is under
  4 MB, and past that the rest of the sheet (and later sheets) are named, not shown. 40 rows of 8 MB gave a 245 MB
  overview at 1.26 GB; now 2 MB in 0.5 s, 300 such sheets 4.3 MB in 5 s. The quarter rule for the slim copy is decided
  before the copy is made. Found on the way: the worker's `Bun.write(Bun.stdout, …)` on a pipe could stop after 64 KB
  of a large answer or spin until the time limit (Bun 1.3.12); the worker now writes stdout itself, a MiB at a time,
  and runIsolated reads a converter's output before it writes its input, so neither waits for the other.
- **Real-AI check (2026-11-18, Claude Code on this Mac, a copy of the QA team with a plan file so the limits apply):**
  a fake 60 MB sales export (4 sheets, 1.1 M rows) and a 160 MB deck of photos with two speaker notes and a chart.
  "What are the totals on its last sheet?": one read, the overview's last rows, the exact TOTAL row (6,489,148 orders,
  19,266,023 units, 2,839,355,962.77). "How much did Store 060000 have?": one read with sheet and range, the right row.
  "What do the speaker notes say, what does the chart show?": both notes by slide and the four chart values.
- **Tests:** tests/unit/office-big.test.ts: a 40 MB deck keeps notes and charts, a 40 MB report keeps headers,
  footers, comments and charts, a 40 MB-picture .xlsx, .hwp and .hwpx read (all failed before: 32 MB cap), the streaming
  reader equals SheetJS on a whole workbook, cells as other writers store them, the overview and its row numbers,
  ranges and their limits, read's `sheet`/`range` through the tool and its refusal on other files, the cap and the
  time limit. g-limits, office-extra updated.
